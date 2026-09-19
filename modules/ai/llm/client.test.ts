import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chatCompletion,
  chatCompletionStream,
  embeddings,
  joinApiUrl,
  listModels,
  parseTokenUsage,
  withDeadline,
} from './client'
import { attachNetRelay, setNetRelayConnect } from './net-relay'
import type { RelayPort } from './net-relay'

afterEach(() => {
  vi.unstubAllGlobals()
  setNetRelayConnect(undefined)
})

describe('内容脚本经后台中继（net-relay）', () => {
  /** 客户端 ⇄ 宿主内存端口对：宿主侧绑定全局 fetch 桩，模拟后台代取。
   *  每次连接生成全新端口对（真实 runtime.connect 每次也是新端口，不复用断开态）。 */
  function enableRelayWithHostFetch(): void {
    const mk = (): {
      messageListeners: Array<(message: unknown) => void>
      disconnectListeners: Array<() => void>
      disconnected: boolean
    } => ({ messageListeners: [], disconnectListeners: [], disconnected: false })
    const endOf = (self: ReturnType<typeof mk>, peer: ReturnType<typeof mk>): RelayPort => ({
      postMessage(message: unknown): void {
        if (self.disconnected) return
        // 模拟 Chrome runtime 端口的 JSON 序列化语义（Uint8Array 过端口会变形）。
        const serialized = JSON.parse(JSON.stringify(message)) as unknown
        queueMicrotask(() => {
          if (self.disconnected) return
          for (const listener of peer.messageListeners) listener(serialized)
        })
      },
      disconnect(): void {
        if (self.disconnected) return
        self.disconnected = true
        for (const listener of self.disconnectListeners) listener()
        if (!peer.disconnected) {
          peer.disconnected = true
          for (const listener of peer.disconnectListeners) listener()
        }
      },
      onMessage: { addListener: (listener: (message: unknown) => void) => self.messageListeners.push(listener) },
      onDisconnect: { addListener: (listener: () => void) => self.disconnectListeners.push(listener) },
    })
    setNetRelayConnect(() => {
      const a = mk()
      const b = mk()
      attachNetRelay(endOf(b, a))
      return endOf(a, b)
    })
  }

  it('chatCompletion 经中继成功：请求由宿主发出（URL/头/体一致），结果同直连', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(OPEN_AI_COMPLETION('中继答案')))
    vi.stubGlobal('fetch', fetchMock)
    enableRelayWithHostFetch()
    const result = await chatCompletion({ endpoint: ENDPOINT, messages: MESSAGES })
    expect(result.content).toBe('中继答案')
    const { url, init } = fetchCall(fetchMock)
    expect(url).toBe('https://llm.example/v1/chat/completions')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer k-1')
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'm-1', messages: MESSAGES })
  })

  it('中继路径回退同样生效：/messages 404 → /v1/messages 命中（方舟 Coding 形态）', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith('/v1/messages')
        ? jsonResponse({ content: [{ type: 'text', text: '答' }] })
        : new Response('not found', { status: 404 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    enableRelayWithHostFetch()
    const result = await chatCompletion({
      endpoint: { baseUrl: 'https://ark.example/api/coding', model: 'm-1', apiKey: 'k-1', format: 'anthropic' },
      messages: MESSAGES,
    })
    expect(result.content).toBe('答')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('中继流式：SSE 分块经端口桥接逐段下发', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"你"}}]}',
        'data: {"choices":[{"delta":{"content":"好"}}]}',
        'data: [DONE]',
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)
    enableRelayWithHostFetch()
    const chunks: string[] = []
    const result = await chatCompletionStream({
      endpoint: ENDPOINT,
      messages: MESSAGES,
      onChunk: (chunk) => chunks.push(chunk),
    })
    expect(chunks).toEqual(['你', '好'])
    expect(result.content).toBe('你好')
  })

  it('中继宿主网络失败 → AiError network（与直连同口径）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    enableRelayWithHostFetch()
    await expect(chatCompletion({ endpoint: ENDPOINT, messages: MESSAGES })).rejects.toMatchObject({
      kind: 'network',
      message: '请求发不出去，请检查端点地址与网络',
    })
  })
})


const ENDPOINT = { baseUrl: 'https://llm.example/v1', model: 'm-1', apiKey: 'k-1' }
const MESSAGES = [{ role: 'user' as const, content: '你好' }]
const OPEN_AI_COMPLETION = (content: string) => ({
  choices: [{ message: { content } }],
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status })
}

function sseResponse(lines: string[], status = 200): Response {
  return new Response(lines.map((line) => `${line}\n`).join(''), {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

// 读取过程中等待外部 signal 中止后抛 AbortError 的响应体，模拟已中止连接的读失败。
function abortableStream(signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull() {
      if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
      throw new DOMException('The operation was aborted.', 'AbortError')
    },
  })
}

function fetchCall(fetchMock: ReturnType<typeof vi.fn>, index = 0): { url: string; init?: RequestInit } {
  const call = fetchMock.mock.calls[index]
  return { url: String(call?.[0]), init: call?.[1] as RequestInit | undefined }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('chatCompletion（直连补全）', () => {
  it('成功返回 choices[0].message.content，且流量只发往指定端点', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(OPEN_AI_COMPLETION('你好呀')))
    vi.stubGlobal('fetch', fetchMock)
    const result = await chatCompletion({ endpoint: ENDPOINT, messages: MESSAGES })
    expect(result.content).toBe('你好呀')
    const { url, init } = fetchCall(fetchMock)
    expect(url).toBe('https://llm.example/v1/chat/completions')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer k-1')
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'm-1', messages: MESSAGES })
  })

  it('fetch 抛错归一为 AiError network', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    await expect(chatCompletion({ endpoint: ENDPOINT, messages: MESSAGES })).rejects.toMatchObject({
      name: 'AiError',
      kind: 'network',
    })
  })

  it('401/403 映射 auth（带 status），不重试', async () => {
    for (const status of [401, 403]) {
      const fetchMock = vi.fn(async () => jsonResponse({ error: 'bad key' }, status))
      vi.stubGlobal('fetch', fetchMock)
      await expect(chatCompletion({ endpoint: ENDPOINT, messages: MESSAGES })).rejects.toMatchObject({
        kind: 'auth',
        status,
      })
      // 鉴权错误属于配置问题，任何重试只会再拿到同一个 401/403。
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  })

  it('其余非 2xx 映射 http（带 status）', async () => {
    for (const status of [404, 429, 500]) {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, status)))
      await expect(chatCompletion({ endpoint: ENDPOINT, messages: MESSAGES })).rejects.toMatchObject({
        kind: 'http',
        status,
      })
    }
  })

  it('坏 JSON 映射 parse', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => textResponse('<html>oops</html>')))
    await expect(chatCompletion({ endpoint: ENDPOINT, messages: MESSAGES })).rejects.toMatchObject({
      kind: 'parse',
    })
  })

  it('缺少 choices[0].message.content 映射 parse', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ choices: [{ message: {} }] })))
    await expect(chatCompletion({ endpoint: ENDPOINT, messages: MESSAGES })).rejects.toMatchObject({
      kind: 'parse',
      message: expect.stringContaining('content'),
    })
  })

  it('apiUrl 空映射 config「先去设置页配置端点」', async () => {
    await expect(
      chatCompletion({ endpoint: { ...ENDPOINT, baseUrl: '' }, messages: MESSAGES }),
    ).rejects.toMatchObject({ kind: 'config', message: '先去设置页配置端点' })
  })

  it('模型为空映射 config', async () => {
    await expect(
      chatCompletion({ endpoint: { ...ENDPOINT, model: '  ' }, messages: MESSAGES }),
    ).rejects.toMatchObject({ kind: 'config' })
  })

  it('apiKey 为空时不发送 Authorization 头', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(OPEN_AI_COMPLETION('ok')))
    vi.stubGlobal('fetch', fetchMock)
    await chatCompletion({ endpoint: { ...ENDPOINT, apiKey: '' }, messages: MESSAGES })
    const { init } = fetchCall(fetchMock)
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it('端点接受连接但不响应时被死线中止（network「请求超时」）', async () => {
    const fetchMock = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
            { once: true },
          )
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const shortDeadline = withDeadline(undefined, 50)
    await expect(
      chatCompletion({ endpoint: ENDPOINT, messages: MESSAGES, signal: shortDeadline }),
    ).rejects.toMatchObject({ kind: 'network', message: '请求超时' })
  })

  it('baseUrl 尾部斜杠被归一，路径拼装正确', () => {
    expect(joinApiUrl('https://llm.example/v1/', 'chat/completions')).toBe(
      'https://llm.example/v1/chat/completions',
    )
  })
})

describe('chatCompletionStream（SSE 流式）', () => {
  const streamFetch = (lines: string[], status = 200) => vi.fn(async () => sseResponse(lines, status))

  it('事件序 start→message{chunk}→end，data: [DONE] 收束且其后不再消费', async () => {
    vi.stubGlobal(
      'fetch',
      streamFetch([
        'data: {"choices":[{"delta":{"content":"你"}}]}',
        'data: {"choices":[{"delta":{"content":"好"}}]}',
        'data: [DONE]',
        'data: {"choices":[{"delta":{"content":"不该出现"}}]}',
      ]),
    )
    const chunks: string[] = []
    const { content } = await chatCompletionStream({ endpoint: ENDPOINT, messages: MESSAGES, onChunk: (c) => chunks.push(c) })
    expect(chunks).toEqual(['你', '好'])
    expect(content).toBe('你好')
  })

  it('解析脏行跳过：注释行/空行/坏 JSON/无 content 的 delta 不触发 message', async () => {
    vi.stubGlobal(
      'fetch',
      streamFetch([
        ': keep-alive comment',
        '',
        'data: {bad json',
        'data: {"choices":[{"delta":{"role":"assistant"}}]}',
        'data: {"choices":[{"delta":{"content":"正"}}]}',
        'data: [DONE]',
      ]),
    )
    const chunks: string[] = []
    const { content } = await chatCompletionStream({ endpoint: ENDPOINT, messages: MESSAGES, onChunk: (c) => chunks.push(c) })
    expect(chunks).toEqual(['正'])
    expect(content).toBe('正')
  })

  it('句尾无换行且无 [DONE] 时按正常收束处理（补解析残行）', async () => {
    // 无尾部换行的裸 body：走「读完后补解析残行」的收尾分支。
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => textResponse('data: {"choices":[{"delta":{"content":"尾"}}]}')),
    )
    const chunks: string[] = []
    const { content } = await chatCompletionStream({ endpoint: ENDPOINT, messages: MESSAGES, onChunk: (c) => chunks.push(c) })
    expect(content).toBe('尾')
    expect(chunks).toEqual(['尾'])
  })

  it('非 2xx 映射 http', async () => {
    vi.stubGlobal('fetch', streamFetch([], 429))
    await expect(
      chatCompletionStream({ endpoint: ENDPOINT, messages: MESSAGES, onChunk: () => {} }),
    ).rejects.toMatchObject({ kind: 'http', status: 429 })
  })

  it('200 但 content-type 是 text/html（代理错误页）时抛 parse 而非空成功', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html>Bad Gateway</html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          }),
      ),
    )
    await expect(
      chatCompletionStream({ endpoint: ENDPOINT, messages: MESSAGES, onChunk: () => {} }),
    ).rejects.toMatchObject({ kind: 'parse' })
  })

  it('流内 error 对象终止并抛 http', async () => {
    vi.stubGlobal(
      'fetch',
      streamFetch(['data: {"choices":[{"delta":{"content":"半"}}]}', 'data: {"error":{"message":"boom"}}']),
    )
    await expect(
      chatCompletionStream({ endpoint: ENDPOINT, messages: MESSAGES, onChunk: () => {} }),
    ).rejects.toMatchObject({ kind: 'http', message: 'boom' })
  })

  it('外部中止抛 AiError network「请求已中止」，消费方不悬挂', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(abortableStream(controller.signal))))
    const promise = chatCompletionStream({
      endpoint: ENDPOINT,
      messages: MESSAGES,
      signal: controller.signal,
      onChunk: () => {},
    })
    controller.abort()
    await expect(promise).rejects.toMatchObject({ kind: 'network', message: '请求已中止' })
  })
})

describe('embeddings（批量向量）', () => {
  it('返回与输入对齐的 number[][]（服务端乱序按 index 恢复）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          data: [
            { index: 1, embedding: [0.2, 0.3] },
            { index: 0, embedding: [0.1, 0.9] },
          ],
        }),
      ),
    )
    const result = await embeddings({ endpoint: ENDPOINT, inputs: ['第一句', '第二句'] })
    expect(result).toEqual([
      [0.1, 0.9],
      [0.2, 0.3],
    ])
  })

  it('POST /embeddings 且请求体携带 model 与 inputs', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ index: 0, embedding: [1] }] }))
    vi.stubGlobal('fetch', fetchMock)
    await embeddings({ endpoint: ENDPOINT, inputs: ['a'] })
    const { url, init } = fetchCall(fetchMock)
    expect(url).toBe('https://llm.example/v1/embeddings')
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'm-1', input: ['a'] })
  })

  it('JSON 非预期（数量不符/embedding 非数字数组）映射 parse', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [{ index: 0, embedding: [1] }] })))
    await expect(embeddings({ endpoint: ENDPOINT, inputs: ['a', 'b'] })).rejects.toMatchObject({
      kind: 'parse',
    })

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [{ index: 0, embedding: ['x'] }] })))
    await expect(embeddings({ endpoint: ENDPOINT, inputs: ['a'] })).rejects.toMatchObject({
      kind: 'parse',
    })
  })

  it('未配置 baseUrl 映射 config', async () => {
    await expect(
      embeddings({ endpoint: { ...ENDPOINT, baseUrl: '' }, inputs: ['a'] }),
    ).rejects.toMatchObject({ kind: 'config' })
  })
})

describe('listModels（模型列表）', () => {
  it('GET {apiUrl}/models 返回 id 数组', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ id: 'gpt-4o-mini' }, { id: 'm-2' }] }))
    vi.stubGlobal('fetch', fetchMock)
    const ids = await listModels({ baseUrl: ENDPOINT.baseUrl, apiKey: ENDPOINT.apiKey })
    expect(ids).toEqual(['gpt-4o-mini', 'm-2'])
    const { url, init } = fetchCall(fetchMock)
    expect(url).toBe('https://llm.example/v1/models')
    expect(init?.method).toBe('GET')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer k-1')
  })

  it('端点不支持（404）映射 http，供 UI 报错文案但允许手动输入', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'not found' }, 404)))
    await expect(listModels({ baseUrl: ENDPOINT.baseUrl, apiKey: '' })).rejects.toMatchObject({
      kind: 'http',
      status: 404,
    })
  })

  it('重复 id 去重且保序（datalist 以 id 为 key）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ data: [{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: 'c' }, { id: 'b' }] }),
      ),
    )
    const ids = await listModels({ baseUrl: ENDPOINT.baseUrl, apiKey: ENDPOINT.apiKey })
    expect(ids).toEqual(['a', 'b', 'c'])
  })

  it('响应缺 data 数组映射 parse', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ models: [] })))
    await expect(listModels({ baseUrl: ENDPOINT.baseUrl, apiKey: '' })).rejects.toMatchObject({
      kind: 'parse',
    })
  })
})
describe('chatCompletion（Anthropic Messages）', () => {
  const ANTHROPIC_ENDPOINT = { ...ENDPOINT, format: 'anthropic' as const }

  it('走 /messages 路径：x-api-key + 版本头，system 提到顶层，max_tokens 必填', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ content: [{ type: 'text', text: '答' }, { type: 'text', text: '案' }] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const result = await chatCompletion({
      endpoint: ANTHROPIC_ENDPOINT,
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '你好' },
      ],
    })
    expect(result.content).toBe('答案')
    const { url, init } = fetchCall(fetchMock)
    expect(url).toBe('https://llm.example/v1/messages')
    const headers = init?.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('k-1')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers.Authorization).toBeUndefined()
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body.model).toBe('m-1')
    expect(body.system).toBe('你是助手')
    expect(body.max_tokens).toBe(4096)
    expect(body.messages).toEqual([{ role: 'user', content: '你好' }])
  })

  it('content 数组缺失 → parse 错误（协议不匹配的提示去向）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'x' } }] })))
    await expect(
      chatCompletion({ endpoint: ANTHROPIC_ENDPOINT, messages: MESSAGES }),
    ).rejects.toMatchObject({ kind: 'parse' })
  })
})

describe('chatCompletionStream（Anthropic SSE）', () => {
  it('content_block_delta 增量逐段下发，message_stop 终止', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'data: {"type":"message_start"}',
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你"}}',
          'event: ping',
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}',
          'data: {"type":"message_stop"}',
        ]),
      ),
    )
    const chunks: string[] = []
    const result = await chatCompletionStream({
      endpoint: { ...ENDPOINT, format: 'anthropic' },
      messages: MESSAGES,
      onChunk: (chunk) => chunks.push(chunk),
    })
    expect(chunks).toEqual(['你', '好'])
    expect(result.content).toBe('你好')
  })

  it('流内 error 事件 → http 错误（消费方以 end{error} 收束）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse(['data: {"type":"error","error":{"type":"overloaded_error","message":"过载"}}']),
      ),
    )
    await expect(
      chatCompletionStream({
        endpoint: { ...ENDPOINT, format: 'anthropic' },
        messages: MESSAGES,
        onChunk: () => undefined,
      }),
    ).rejects.toMatchObject({ kind: 'http', message: '过载' })
  })
})

describe('路径双拼法回退（base 带/不带 /v1）', () => {
  it('anthropic：/messages 404 时自动改试 /v1/messages（方舟 Coding 形态）', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith('/v1/messages')
        ? jsonResponse({ content: [{ type: 'text', text: '答' }] })
        : new Response('not found', { status: 404 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const result = await chatCompletion({
      endpoint: { baseUrl: 'https://ark.example/api/coding', model: 'm-1', apiKey: 'k-1', format: 'anthropic' },
      messages: MESSAGES,
    })
    expect(result.content).toBe('答')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://ark.example/api/coding/messages')
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('https://ark.example/api/coding/v1/messages')
  })

  it('openai：/chat/completions 404 时自动改试 /v1/chat/completions', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith('/v1/chat/completions')
        ? jsonResponse(OPEN_AI_COMPLETION('好'))
        : new Response('not found', { status: 404 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const result = await chatCompletion({
      endpoint: { baseUrl: 'https://relay.example', model: 'm-1', apiKey: 'k-1' },
      messages: MESSAGES,
    })
    expect(result.content).toBe('好')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('两种拼法都 404 → http 错误（带 status），不会无限重试', async () => {
    const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(chatCompletion({ endpoint: ENDPOINT, messages: MESSAGES })).rejects.toMatchObject({
      kind: 'http',
      status: 404,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('非 2xx 带上游原因：400 的响应体 error.message 透传到错误文案', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          { error: { code: 'InvalidParameter', message: 'max_tokens exceeds the model limit 8192' } },
          400,
        ),
      ),
    )
    await expect(chatCompletion({ endpoint: ENDPOINT, messages: MESSAGES })).rejects.toMatchObject({
      kind: 'http',
      message: '端点返回了 400：max_tokens exceeds the model limit 8192',
    })
  })

  it('非 2xx 无可读原因：维持「端点返回了 N」原始形状', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('plain', 502)))
    await expect(chatCompletion({ endpoint: ENDPOINT, messages: MESSAGES })).rejects.toMatchObject({
      kind: 'http',
      message: '端点返回了 502',
    })
  })

  it('401 不触发路径回退（直接映射 auth，一次请求）', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 401))
    vi.stubGlobal('fetch', fetchMock)
    await expect(chatCompletion({ endpoint: ENDPOINT, messages: MESSAGES })).rejects.toMatchObject({
      kind: 'auth',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('anthropic：x-api-key 401 → 换 Bearer 头重试成功（方舟 Coding 网关只认 Bearer）', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      if ('x-api-key' in headers) return jsonResponse({}, 401)
      if ('Authorization' in headers) {
        return jsonResponse({ content: [{ type: 'text', text: '答' }] })
      }
      return jsonResponse({}, 401)
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await chatCompletion({
      endpoint: { baseUrl: 'https://ark.example/api/coding/v1', model: 'm-1', apiKey: 'k-1', format: 'anthropic' },
      messages: MESSAGES,
    })
    expect(result.content).toBe('答')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondHeaders = (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.headers as Record<string, string>
    expect(secondHeaders.Authorization).toBe('Bearer k-1')
    expect(secondHeaders['x-api-key']).toBeUndefined()
  })

  it('anthropic：两种鉴权头都 401 → 映射 auth（最后一次的 status），共两次请求', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 401))
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      chatCompletion({ endpoint: { ...ENDPOINT, apiKey: 'bad', format: 'anthropic' }, messages: MESSAGES }),
    ).rejects.toMatchObject({ kind: 'auth', status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('流式请求同样回退：/messages 404 → /v1/messages 命中', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith('/v1/messages')
        ? sseResponse(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}', 'data: {"type":"message_stop"}'])
        : new Response('not found', { status: 404 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const chunks: string[] = []
    const result = await chatCompletionStream({
      endpoint: { baseUrl: 'https://ark.example/api/coding', model: 'm-1', apiKey: 'k-1', format: 'anthropic' },
      messages: MESSAGES,
      onChunk: (chunk) => chunks.push(chunk),
    })
    expect(result.content).toBe('好')
    expect(chunks).toEqual(['好'])
  })
})

describe('listModels（容错对齐开源客户端做法）', () => {
  it('anthropic 格式：x-api-key 头 + 同一 /models 路径', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ id: 'claude-sonnet-4' }] }))
    vi.stubGlobal('fetch', fetchMock)
    const ids = await listModels({ baseUrl: ENDPOINT.baseUrl, apiKey: 'k-1', format: 'anthropic' })
    expect(ids).toEqual(['claude-sonnet-4'])
    const headers = fetchCall(fetchMock).init?.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('k-1')
    expect(headers.Authorization).toBeUndefined()
  })

  it('401 时摘掉鉴权重试一次（部分中转 /models 不收 Key）', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      return 'Authorization' in headers
        ? new Response('no', { status: 401 })
        : jsonResponse({ data: [{ id: 'm-a' }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(await listModels({ baseUrl: ENDPOINT.baseUrl, apiKey: 'k-1' })).toEqual(['m-a'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('响应形状多认：{models:[{name}]}（Ollama 形）与裸数组字符串', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ models: [{ name: 'qwen3:8b' }] })))
    expect(await listModels({ baseUrl: ENDPOINT.baseUrl, apiKey: '' })).toEqual(['qwen3:8b'])

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(['m-1', 'm-2'])))
    expect(await listModels({ baseUrl: ENDPOINT.baseUrl, apiKey: '' })).toEqual(['m-1', 'm-2'])
  })

  it('anthropic：x-api-key 401 → 换 Bearer 再试（Claude Code 类网关只认 Bearer 形态）', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      if ('x-api-key' in headers) return new Response('no', { status: 401 })
      if ('Authorization' in headers) return jsonResponse({ data: [{ id: 'claude-sonnet-4' }] })
      return new Response('no', { status: 401 })
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(await listModels({ baseUrl: ENDPOINT.baseUrl, apiKey: 'k-1', format: 'anthropic' })).toEqual([
      'claude-sonnet-4',
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('路径回退：/models 404 → /v1/models 命中（base 不带 /v1 的用户粘贴）', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith('/v1/models')
        ? jsonResponse({ data: [{ id: 'm-1' }] })
        : new Response('no', { status: 404 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    expect(await listModels({ baseUrl: 'https://relay.example', apiKey: 'k-1' })).toEqual(['m-1'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('全部拼法 404 → 文案明说「手动填写模型名」（专用 Messages 网关不提供列表）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 404 })))
    await expect(
      listModels({ baseUrl: 'https://ark.example/api/coding', apiKey: 'k-1', format: 'anthropic' }),
    ).rejects.toThrow(/手动填写模型名/)
  })

  it('HTTP 状态码透出（404 → 文案带状态，提示可能不支持 /models）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 404 })))
    await expect(listModels({ baseUrl: ENDPOINT.baseUrl, apiKey: '' })).rejects.toThrow(
      /HTTP 404/,
    )
  })
})

describe('parseTokenUsage（成本可观测）', () => {
  it('OpenAI 形状：usage.prompt_tokens/completion_tokens', () => {
    expect(
      parseTokenUsage({ choices: [], usage: { prompt_tokens: 1234.0, completion_tokens: 56 } }),
    ).toEqual({ input: 1234, output: 56 })
  })

  it('Anthropic 形状：usage.input_tokens/output_tokens', () => {
    expect(
      parseTokenUsage({ content: [], usage: { input_tokens: 987, output_tokens: 3 } }),
    ).toEqual({ input: 987, output: 3 })
  })

  it('缺 usage / 缺字段 / 非数字 / 负数 → 一律视为没有（undefined）', () => {
    expect(parseTokenUsage({ choices: [] })).toBeUndefined()
    expect(parseTokenUsage({ usage: { prompt_tokens: 100 } })).toBeUndefined()
    expect(parseTokenUsage({ usage: { prompt_tokens: 'x', completion_tokens: 1 } })).toBeUndefined()
    expect(parseTokenUsage(null)).toBeUndefined()
  })

  it('chatCompletion 把端点回传的 usage 透传给调用方', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: 'ok' } }],
              usage: { prompt_tokens: 300, completion_tokens: 20 },
            }),
            { status: 200 },
          ),
      ),
    )
    const result = await chatCompletion({ endpoint: ENDPOINT, messages: [{ role: 'user', content: 'hi' }] })
    expect(result.content).toBe('ok')
    expect(result.usage).toEqual({ input: 300, output: 20 })
  })

  it('端点不回 usage 时 result.usage 缺省（不报错）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
            status: 200,
          }),
      ),
    )
    const result = await chatCompletion({ endpoint: ENDPOINT, messages: [{ role: 'user', content: 'hi' }] })
    expect(result.usage).toBeUndefined()
  })
})

describe('非 SSE 响应体与推理模型空回复的归因', () => {
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const streamFetch = (lines: string[], status = 200) => vi.fn(async () => sseResponse(lines, status))

  it('网关忽略 stream:true 回一次性补全体：直接采用正文（含用量），不报空回复', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          choices: [{ message: { role: 'assistant', content: '# 总结\n\n正文在此' } }],
          usage: { prompt_tokens: 12, completion_tokens: 34 },
        }),
      ),
    )
    const { content, usage } = await chatCompletionStream({
      endpoint: ENDPOINT,
      messages: MESSAGES,
      onChunk: () => {},
    })
    expect(content).toBe('# 总结\n\n正文在此')
    expect(usage).toEqual({ input: 12, output: 34 })
  })

  it('HTTP 200 + 业务错误体（{code,message}）：报带上游文案的 http 错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 401, message: 'invalid token', data: null })))
    await expect(
      chatCompletionStream({ endpoint: ENDPOINT, messages: MESSAGES, onChunk: () => {} }),
    ).rejects.toMatchObject({ kind: 'http', message: 'invalid token（code 401）' })
  })

  it('OpenAI 形错误体 {error:{message,code}}：同样转为 http 错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { message: 'insufficient quota', code: 'quota_exceeded' } })),
    )
    await expect(
      chatCompletion({ endpoint: ENDPOINT, messages: MESSAGES }),
    ).rejects.toMatchObject({ kind: 'http', message: 'insufficient quota（quota_exceeded）' })
  })

  it('推理模型只回思考过程：报「推理模型」并附原始摘录（可据此换模型/关思考）', async () => {
    vi.stubGlobal(
      'fetch',
      streamFetch([
        'data: {"choices":[{"delta":{"reasoning_content":"先想…"}}]}',
        'data: {"choices":[{"delta":{"reasoning_content":"再想…"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ]),
    )
    const failure = await chatCompletionStream({
      endpoint: ENDPOINT,
      messages: MESSAGES,
      onChunk: () => {},
    }).then(
      () => null,
      (error: unknown) => error as { kind: string; message: string; rawResponse?: string },
    )
    expect(failure?.kind).toBe('parse')
    expect(failure?.message).toContain('只返回了思考过程')
    expect(failure?.message).toContain('非推理模型')
    expect(failure?.rawResponse).toContain('reasoning_content')
  })

  it('思考过程吃光输出预算（finish_reason=length）：归因到预算而不是笼统空回复', async () => {
    vi.stubGlobal(
      'fetch',
      streamFetch([
        'data: {"choices":[{"delta":{"reasoning_content":"很长很长的思考"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
        'data: [DONE]',
      ]),
    )
    await expect(
      chatCompletionStream({ endpoint: ENDPOINT, messages: MESSAGES, onChunk: () => {} }),
    ).rejects.toMatchObject({ kind: 'parse', message: expect.stringContaining('输出预算被思考过程吃光了') })
  })

  it('空响应体：指向 Key/配额/地址，不带空摘录', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    await expect(
      chatCompletionStream({ endpoint: ENDPOINT, messages: MESSAGES, onChunk: () => {} }),
    ).rejects.toMatchObject({ message: expect.stringContaining('空响应体') })
  })

  it('非流式补全遇推理模型（message.reasoning_content）：同样报出推理模型原因', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ choices: [{ message: { reasoning_content: '想了很久', content: '' } }] })),
    )
    await expect(chatCompletion({ endpoint: ENDPOINT, messages: MESSAGES })).rejects.toMatchObject({
      kind: 'parse',
      message: expect.stringContaining('只返回了思考过程'),
    })
  })

  it('非补全形状（缺 choices）：保留原有精确报错，不误报成空回复', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: { ok: true } })))
    await expect(chatCompletion({ endpoint: ENDPOINT, messages: MESSAGES })).rejects.toMatchObject({
      message: expect.stringContaining('缺少 choices[0].message.content'),
    })
  })
})
