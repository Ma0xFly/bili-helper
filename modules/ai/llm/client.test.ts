import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chatCompletion,
  chatCompletionStream,
  embeddings,
  joinApiUrl,
  listModels,
  withDeadline,
} from './client'

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

  it('401 不触发路径回退（直接映射 auth，一次请求）', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 401))
    vi.stubGlobal('fetch', fetchMock)
    await expect(chatCompletion({ endpoint: ENDPOINT, messages: MESSAGES })).rejects.toMatchObject({
      kind: 'auth',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
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
