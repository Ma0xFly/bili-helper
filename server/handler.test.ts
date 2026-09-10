// 服务端主体测试：真起 http 服务（端口 0）打真请求。
// 除了逐条路由/鉴权/错误映射，最后用扩展端真实的 server 适配器（createServerBackend）
// 打这个服务做契约互通验证——客户端解析器与服务端序列化器必须对得上，否则模式一切就废。
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServerBackend } from '../modules/ai/backend/server'
import type {
  AiCapabilities,
  AiChatEvent,
  ChatInput,
  DetectAdsInput,
  SummarizeInput,
} from '../modules/ai/port'
import { DEFAULT_SETTINGS } from '../modules/settings'
import type { AiSettings } from '../modules/settings'
import { AiError } from '../modules/shared/error'
import type { ServerDeps } from './handler'
import { PayloadTooLargeError, createRequestHandler, statusOfError } from './handler'

const CONTEXT = {
  video: { bvid: 'BV1xx411c7mD', cid: 7, title: '设备横评', duration: 600 },
  subtitles: [{ start: 492, end: 512, text: '恰饭时间到了' }],
  danmaku: [{ time: 500, text: '广告来啦' }],
  comments: [{ top: { text: '这段是广告' } }],
}

interface Harness {
  baseUrl: string
  calls: { detect: DetectAdsInput[]; summary: SummarizeInput[]; chat: ChatInput[] }
  close(): Promise<void>
}

function makeCapabilities(): { capabilities: AiCapabilities; calls: Harness['calls'] } {
  const calls: Harness['calls'] = { detect: [], summary: [], chat: [] }
  const capabilities: AiCapabilities = {
    async detectAds(input) {
      calls.detect.push(input)
      return {
        ads: [{ start: 492, end: 512, product_name: '某品牌', ad_content: '口播', confidence: 0.9 }],
        source: 'rag',
      }
    },
    async summarize(input) {
      calls.summary.push(input)
      return { summary: '# 一句话概括\n横评八款设备', segments: [{ start: 0, end: 60, label: '开场' }] }
    },
    async chat(input, handlers) {
      calls.chat.push(input)
      handlers.onEvent({ type: 'start' })
      handlers.onEvent({ type: 'message', chunk: '你' })
      handlers.onEvent({ type: 'message', chunk: '好' })
      handlers.onEvent({ type: 'end' })
    },
  }
  return { capabilities, calls }
}

const started: Harness[] = []

async function start(overrides: Partial<ServerDeps> = {}): Promise<Harness> {
  const { capabilities, calls } = makeCapabilities()
  const server = createServer(
    createRequestHandler({ settings: DEFAULT_SETTINGS, capabilities, ...overrides }),
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const harness: Harness = {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
  started.push(harness)
  return harness
}

function post(baseUrl: string, path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

afterEach(async () => {
  while (started.length > 0) await started.pop()?.close()
  vi.unstubAllGlobals()
})

describe('statusOfError（AiError → HTTP 状态）', () => {
  it('五类 kind 各有归属，请求体超限是 413', () => {
    expect(statusOfError(new AiError('parse', '坏 JSON'))).toBe(400)
    expect(statusOfError(new AiError('config', '没配端点'))).toBe(500)
    expect(statusOfError(new AiError('auth', '上游 401', { status: 401 }))).toBe(502)
    expect(statusOfError(new AiError('http', '上游 500', { status: 500 }))).toBe(502)
    expect(statusOfError(new AiError('network', '超时'))).toBe(504)
    expect(statusOfError(new PayloadTooLargeError(10))).toBe(413)
    expect(statusOfError(new Error('意外'))).toBe(500)
  })
})

describe('路由与探活', () => {
  it('GET /ai/health → 200，报配置状态但不回显地址与 Key', async () => {
    const { baseUrl } = await start({
      settings: { ...DEFAULT_SETTINGS, apiUrl: 'https://chat.example/v1', model: 'm', apiKey: 'sk-secret' },
      token: 'tok',
    })
    const response = await fetch(`${baseUrl}/ai/health`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({ ok: true, service: 'bili-helper-ai', configured: true })
    // 探活响应里不能带出端点地址或 Key（健康检查通常不鉴权，谁都能打）。
    expect(JSON.stringify(body)).not.toContain('sk-secret')
    expect(JSON.stringify(body)).not.toContain('chat.example')
  })

  it('未配置端点时 health 仍 200 但 configured=false', async () => {
    const { baseUrl } = await start()
    const body = (await (await fetch(`${baseUrl}/ai/health`)).json()) as { configured: boolean }
    expect(body.configured).toBe(false)
  })

  it('未知路径 404，非 POST 405，OPTIONS 预检 204 带 CORS 头', async () => {
    const { baseUrl } = await start({ allowOrigin: 'https://www.bilibili.com' })
    expect((await fetch(`${baseUrl}/ai/nope`)).status).toBe(404)
    expect((await fetch(`${baseUrl}/ai/summary`)).status).toBe(405)

    const preflight = await fetch(`${baseUrl}/ai/chat`, { method: 'OPTIONS' })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://www.bilibili.com')
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization')
  })

  it('JSON 响应也带 CORS 头（扩展内容脚本从 bilibili.com 发起跨源请求）', async () => {
    const { baseUrl } = await start({ allowOrigin: '*' })
    const response = await post(baseUrl, '/ai/ad-detection', CONTEXT)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })
})

describe('鉴权', () => {
  it('设了 token：缺失或错误 401，正确放行；health 不鉴权', async () => {
    const { baseUrl } = await start({ token: 'sekret' })
    expect((await post(baseUrl, '/ai/ad-detection', CONTEXT)).status).toBe(401)
    expect((await post(baseUrl, '/ai/ad-detection', CONTEXT, 'wrong')).status).toBe(401)
    expect((await post(baseUrl, '/ai/ad-detection', CONTEXT, 'sekret')).status).toBe(200)
    expect((await fetch(`${baseUrl}/ai/health`)).status).toBe(200)
  })

  it('未设 token：不校验（本机/内网用法）', async () => {
    const { baseUrl } = await start()
    expect((await post(baseUrl, '/ai/ad-detection', CONTEXT)).status).toBe(200)
  })

  it('Authorization 头形状不对（非 Bearer）同样 401', async () => {
    const { baseUrl } = await start({ token: 'sekret' })
    const response = await fetch(`${baseUrl}/ai/ad-detection`, {
      method: 'POST',
      headers: { Authorization: 'sekret', 'Content-Type': 'application/json' },
      body: JSON.stringify(CONTEXT),
    })
    expect(response.status).toBe(401)
  })
})

describe('三条契约路径', () => {
  it('ad-detection：context 解析后交给能力层，strategy 缺省 smart，响应同形回传', async () => {
    const harness = await start()
    const response = await post(harness.baseUrl, '/ai/ad-detection', CONTEXT)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({
      ads: [{ start: 492, end: 512, product_name: '某品牌', ad_content: '口播', confidence: 0.9 }],
      source: 'rag',
    })

    const [input] = harness.calls.detect
    expect(input?.video).toEqual(CONTEXT.video)
    expect(input?.subtitles).toEqual(CONTEXT.subtitles)
    expect(input?.danmaku).toEqual(CONTEXT.danmaku)
    expect(input?.comments).toEqual(CONTEXT.comments)
    expect(input?.strategy).toBe('smart')
    expect(input?.signal).toBeInstanceOf(AbortSignal)
  })

  it('summary：能力层收到端口形状（无 comments 字段）', async () => {
    const harness = await start()
    const response = await post(harness.baseUrl, '/ai/summary', CONTEXT)
    expect(await response.json()).toEqual({
      summary: '# 一句话概括\n横评八款设备',
      segments: [{ start: 0, end: 60, label: '开场' }],
    })
    const [input] = harness.calls.summary
    expect(input).toMatchObject({ video: CONTEXT.video, subtitles: CONTEXT.subtitles })
    expect('comments' in (input as unknown as Record<string, unknown>)).toBe(false)
  })

  it('chat：SSE 三事件按序下发，[DONE] 收尾，头里关掉代理缓冲', async () => {
    const harness = await start()
    const response = await post(harness.baseUrl, '/ai/chat', {
      messages: [{ role: 'user', content: '讲了什么' }],
      context: CONTEXT,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('x-accel-buffering')).toBe('no')

    const raw = await response.text()
    const events = raw
      .split('\n\n')
      .filter((block) => block.startsWith('data: '))
      .map((block) => block.slice('data: '.length))
    expect(events.at(-1)).toBe('[DONE]')
    expect(events.slice(0, -1).map((item) => JSON.parse(item) as AiChatEvent)).toEqual([
      { type: 'start' },
      { type: 'message', chunk: '你' },
      { type: 'message', chunk: '好' },
      { type: 'end' },
    ])
    expect(harness.calls.chat[0]?.messages).toEqual([{ role: 'user', content: '讲了什么' }])
  })

  it('chat 里能力层以 end{error} 收束时原样透传（客户端据此渲染错误）', async () => {
    const capabilities: AiCapabilities = {
      async detectAds() {
        return { ads: [], source: 'none' }
      },
      async summarize() {
        return { summary: '', segments: [] }
      },
      async chat(_input, handlers) {
        handlers.onEvent({ type: 'start' })
        handlers.onEvent({ type: 'end', error: { kind: 'auth', message: '上游 Key 无效', status: 401 } })
      },
    }
    const { baseUrl } = await start({ capabilities })
    const raw = await (
      await post(baseUrl, '/ai/chat', { messages: [{ role: 'user', content: 'x' }], context: CONTEXT })
    ).text()
    expect(raw).toContain('"type":"end"')
    expect(raw).toContain('上游 Key 无效')
  })
})

describe('错误映射与请求体防御', () => {
  it('非法 JSON / 缺 bvid → 400 且带 kind=parse', async () => {
    const { baseUrl } = await start()
    const badJson = await post(baseUrl, '/ai/ad-detection', '{not json')
    expect(badJson.status).toBe(400)
    expect(((await badJson.json()) as { error: { kind: string } }).error.kind).toBe('parse')

    const noBvid = await post(baseUrl, '/ai/ad-detection', { video: { title: 'x' } })
    expect(noBvid.status).toBe(400)
    expect(((await noBvid.json()) as { error: { message: string } }).error.message).toContain('bvid')
  })

  it('空请求体 → 400，数组请求体 → 400', async () => {
    const { baseUrl } = await start()
    expect((await post(baseUrl, '/ai/ad-detection', '')).status).toBe(400)
    expect((await post(baseUrl, '/ai/ad-detection', [1, 2])).status).toBe(400)
  })

  it('能力层抛 AiError → 按 kind 映射状态（network 504 / config 500）', async () => {
    const capabilities: AiCapabilities = {
      async detectAds() {
        throw new AiError('network', '上游模型端点连不上')
      },
      async summarize() {
        throw new AiError('config', '还没配置端点')
      },
      async chat() {
        /* 本用例不涉及 */
      },
    }
    const { baseUrl } = await start({ capabilities })
    const network = await post(baseUrl, '/ai/ad-detection', CONTEXT)
    expect(network.status).toBe(504)
    expect(((await network.json()) as { error: { kind: string; message: string } }).error).toEqual({
      kind: 'network',
      message: '上游模型端点连不上',
    })

    const config = await post(baseUrl, '/ai/summary', CONTEXT)
    expect(config.status).toBe(500)
  })

  it('能力层抛非 AiError → 500，响应体仍是可渲染的错误形状', async () => {
    const capabilities: AiCapabilities = {
      async detectAds() {
        throw new Error('意料之外')
      },
      async summarize() {
        return { summary: '', segments: [] }
      },
      async chat() {
        /* 本用例不涉及 */
      },
    }
    const { baseUrl } = await start({ capabilities })
    const response = await post(baseUrl, '/ai/ad-detection', CONTEXT)
    expect(response.status).toBe(500)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain('意料之外')
  })

  it('请求体超上限 → 413', async () => {
    const { baseUrl } = await start({ maxBodyBytes: 64 })
    const response = await post(baseUrl, '/ai/ad-detection', CONTEXT)
    expect(response.status).toBe(413)
  })

  it('降级提示经 onWarn 上报，且不带 Key/Token', async () => {
    const onWarn = vi.fn()
    const capabilities: AiCapabilities = {
      async detectAds() {
        throw new AiError('network', '上游挂了')
      },
      async summarize() {
        return { summary: '', segments: [] }
      },
      async chat() {
        /* 本用例不涉及 */
      },
    }
    const { baseUrl } = await start({
      capabilities,
      onWarn,
      token: 'super-secret-token',
      settings: { ...DEFAULT_SETTINGS, apiKey: 'sk-secret' },
    })
    await post(baseUrl, '/ai/ad-detection', CONTEXT, 'super-secret-token')
    expect(onWarn).toHaveBeenCalled()
    const logged = onWarn.mock.calls.map((call) => String(call[0])).join('\n')
    expect(logged).not.toContain('super-secret-token')
    expect(logged).not.toContain('sk-secret')
  })
})

describe('客户端断开', () => {
  it('连接中断 → 能力层收到 aborted signal（不白烧上游 token）', async () => {
    let seen: AbortSignal | undefined
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const capabilities: AiCapabilities = {
      async detectAds() {
        return { ads: [], source: 'none' }
      },
      async summarize() {
        return { summary: '', segments: [] }
      },
      async chat(input, handlers) {
        seen = input.signal
        handlers.onEvent({ type: 'start' })
        await gate
        handlers.onEvent({ type: 'end' })
      },
    }
    const { baseUrl } = await start({ capabilities })

    const controller = new AbortController()
    // 客户端主动断开：fetch 必须带上 signal，否则服务端根本看不到「对方走了」。
    const pending = fetch(`${baseUrl}/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], ...CONTEXT }),
      signal: controller.signal,
    }).then(
      () => undefined,
      () => undefined,
    )
    // 先让请求真正进到能力层，再断开。
    await vi.waitFor(() => expect(seen).toBeDefined())
    controller.abort()
    await pending
    await vi.waitFor(() => expect(seen?.aborted).toBe(true), { timeout: 2000 })
    release?.()
  })
})

describe('契约互通：扩展端 server 适配器 ↔ 本服务', () => {
  function clientSettings(baseUrl: string, token = ''): AiSettings {
    return { ...DEFAULT_SETTINGS, mode: 'server', serverBaseUrl: baseUrl, serverToken: token }
  }

  it('detectAds：客户端拿到与端上同形的结果', async () => {
    const harness = await start({ token: 'tok' })
    const backend = createServerBackend(clientSettings(harness.baseUrl, 'tok'))
    const result = await backend.detectAds({ ...CONTEXT, strategy: 'free' })
    expect(result).toEqual({
      ads: [{ start: 492, end: 512, product_name: '某品牌', ad_content: '口播', confidence: 0.9 }],
      source: 'rag',
    })
    expect(harness.calls.detect[0]?.strategy).toBe('free')
  })

  it('summarize：客户端解析出 summary 与 segments', async () => {
    const harness = await start()
    const backend = createServerBackend(clientSettings(harness.baseUrl))
    expect(await backend.summarize(CONTEXT)).toEqual({
      summary: '# 一句话概括\n横评八款设备',
      segments: [{ start: 0, end: 60, label: '开场' }],
    })
  })

  it('chat：客户端按序收到 start/message×2/end（客户端自己补发 start，服务端 start 被跳过）', async () => {
    const harness = await start()
    const backend = createServerBackend(clientSettings(harness.baseUrl))
    const events: AiChatEvent[] = []
    await backend.chat(
      { messages: [{ role: 'user', content: '讲了什么' }], context: CONTEXT },
      { onEvent: (event) => events.push(event) },
    )
    expect(events).toEqual([
      { type: 'start' },
      { type: 'message', chunk: '你' },
      { type: 'message', chunk: '好' },
      { type: 'end' },
    ])
    // 客户端送的是 {messages, context:{video,…}} 嵌套形状，服务端必须从 context 里取素材。
    expect(harness.calls.chat[0]?.context.video).toEqual(CONTEXT.video)
  })

  it('服务器 5xx：客户端抛 AiError（auto 模式据此回退本地直连）', async () => {
    const capabilities: AiCapabilities = {
      async detectAds() {
        throw new AiError('network', '上游挂了')
      },
      async summarize() {
        return { summary: '', segments: [] }
      },
      async chat() {
        /* 本用例不涉及 */
      },
    }
    const { baseUrl } = await start({ capabilities })
    const backend = createServerBackend(clientSettings(baseUrl))
    await expect(backend.detectAds({ ...CONTEXT, strategy: 'smart' })).rejects.toMatchObject({
      kind: 'http',
      status: 504,
    })
  })

  it('token 不匹配：客户端抛 auth 类 AiError', async () => {
    const harness = await start({ token: 'right' })
    const backend = createServerBackend(clientSettings(harness.baseUrl, 'wrong'))
    await expect(backend.summarize(CONTEXT)).rejects.toMatchObject({ kind: 'auth', status: 401 })
  })
})
