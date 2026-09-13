// 服务端主体测试：真起 http 服务（端口 0）打真请求。
// 除了逐条路由/鉴权/错误映射，最后用扩展端真实的 server 适配器（createServerBackend）
// 打这个服务做契约互通验证——客户端解析器与服务端序列化器必须对得上，否则模式一切就废。
import { createServer } from 'node:http'
import { request as httpRequest } from 'node:http'
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
import type { RequestHandler, ServerDeps } from './handler'
import { PayloadTooLargeError, RequestAbortedError, createRequestHandler, statusOfError } from './handler'

const CONTEXT = {
  video: { bvid: 'BV1xx411c7mD', cid: 7, title: '设备横评', duration: 600 },
  subtitles: [{ start: 492, end: 512, text: '恰饭时间到了' }],
  danmaku: [{ time: 500, text: '广告来啦' }],
  comments: [{ top: { text: '这段是广告' } }],
}

interface Harness {
  baseUrl: string
  handler: RequestHandler
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
  const handler = createRequestHandler({ settings: DEFAULT_SETTINGS, capabilities, ...overrides })
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const harness: Harness = {
    baseUrl: `http://127.0.0.1:${port}`,
    handler,
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

/** SSE 原始响应 → data 载荷序列（[DONE] 原样保留在末位）。 */
function sseEvents(raw: string): string[] {
  return raw
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => block.slice('data: '.length))
}

afterEach(async () => {
  while (started.length > 0) await started.pop()?.close()
  vi.unstubAllGlobals()
})

describe('statusOfError（AiError → HTTP 状态）', () => {
  it('五类 kind 各有归属，请求体超限是 413、半途断开是 400', () => {
    expect(statusOfError(new AiError('parse', '坏 JSON'))).toBe(400)
    expect(statusOfError(new AiError('config', '没配端点'))).toBe(500)
    expect(statusOfError(new AiError('auth', '上游 401', { status: 401 }))).toBe(502)
    expect(statusOfError(new AiError('http', '上游 500', { status: 500 }))).toBe(502)
    expect(statusOfError(new AiError('network', '超时'))).toBe(504)
    expect(statusOfError(new PayloadTooLargeError(10))).toBe(413)
    expect(statusOfError(new RequestAbortedError())).toBe(400)
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

  it('HEAD /ai/health 也 200（负载均衡与 curl -I 探活常用 HEAD）', async () => {
    const { baseUrl } = await start()
    const response = await fetch(`${baseUrl}/ai/health`, { method: 'HEAD' })
    expect(response.status).toBe(200)
  })

  it('404 不回显请求路径，鉴权在 404 之前（路由表不可枚举）', async () => {
    const { baseUrl } = await start({ token: 'sekret' })
    // 没鉴权时未知路径只给 401：拿 404/405 差异枚举不出路由表。
    expect((await fetch(`${baseUrl}/ai/nope?secret=leet`)).status).toBe(401)

    const response = await fetch(`${baseUrl}/ai/nope?secret=leet`, {
      headers: { Authorization: 'Bearer sekret' },
    })
    expect(response.status).toBe(404)
    // 固定文案：调用方送来的路径与查询串一个字都不反射（反射/日志注入面）。
    expect(await response.text()).toBe(JSON.stringify({ error: { kind: 'http', message: '未知路径' } }))
  })

  it('前导 BOM 的 JSON 也能收（Windows 工具导出的请求体天然带 BOM）', async () => {
    const { baseUrl } = await start()
    const response = await post(baseUrl, '/ai/ad-detection', `\uFEFF${JSON.stringify(CONTEXT)}`)
    expect(response.status).toBe(200)
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

    const events = sseEvents(await response.text())
    expect(events.at(-1)).toBe('[DONE]')
    expect(events.slice(0, -1).map((item) => JSON.parse(item) as AiChatEvent)).toEqual([
      { type: 'start' },
      { type: 'message', chunk: '你' },
      { type: 'message', chunk: '好' },
      { type: 'end' },
    ])
    expect(harness.calls.chat[0]?.messages).toEqual([{ role: 'user', content: '讲了什么' }])
  })

  it('chat：首块之前收 end{error} → 回 HTTP 错误而非 SSE（auto 模式的回退前提）', async () => {
    // 服务器上游挂了恰恰是最该回退的场景：如果这时还发 200+SSE，
    // 客户端就认为「流已开始」而永远不回退浏览器直连。
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
    const response = await post(baseUrl, '/ai/chat', {
      messages: [{ role: 'user', content: 'x' }],
      context: CONTEXT,
    })
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { kind: 'http', message: '上游 Key 无效' } })
  })

  it('chat：首块之后再收 end{error} → SSE 内联透传（流已开始，只能 in-band 收束）', async () => {
    const capabilities: AiCapabilities = {
      async detectAds() {
        return { ads: [], source: 'none' }
      },
      async summarize() {
        return { summary: '', segments: [] }
      },
      async chat(_input, handlers) {
        handlers.onEvent({ type: 'start' })
        handlers.onEvent({ type: 'message', chunk: '正在回答' })
        handlers.onEvent({ type: 'end', error: { kind: 'network', message: '上游断了' } })
      },
    }
    const { baseUrl } = await start({ capabilities })
    const response = await post(baseUrl, '/ai/chat', {
      messages: [{ role: 'user', content: 'x' }],
      context: CONTEXT,
    })
    expect(response.status).toBe(200)
    const events = sseEvents(await response.text()).map((item) =>
      item === '[DONE]' ? item : (JSON.parse(item) as AiChatEvent),
    )
    expect(events).toEqual([
      { type: 'start' },
      { type: 'message', chunk: '正在回答' },
      { type: 'end', error: { kind: 'network', message: '上游断了' } },
      '[DONE]',
    ])
  })

  it('chat：无 message 的干净收束 → 仍是完整 SSE（start+end+[DONE]），客户端不悬挂', async () => {
    const capabilities: AiCapabilities = {
      async detectAds() {
        return { ads: [], source: 'none' }
      },
      async summarize() {
        return { summary: '', segments: [] }
      },
      async chat(_input, handlers) {
        handlers.onEvent({ type: 'start' })
        handlers.onEvent({ type: 'end' })
      },
    }
    const { baseUrl } = await start({ capabilities })
    const response = await post(baseUrl, '/ai/chat', {
      messages: [{ role: 'user', content: 'x' }],
      context: CONTEXT,
    })
    expect(response.status).toBe(200)
    const events = sseEvents(await response.text()).map((item) =>
      item === '[DONE]' ? item : (JSON.parse(item) as AiChatEvent),
    )
    expect(events).toEqual([{ type: 'start' }, { type: 'end' }, '[DONE]'])
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
  it('SSE 流中途断开：写入侧不崩进程，服务紧接着仍可用', async () => {
    const capabilities: AiCapabilities = {
      async detectAds() {
        return { ads: [], source: 'none' }
      },
      async summarize() {
        return { summary: '', segments: [] }
      },
      async chat(input, handlers) {
        // 持续吐块直到被中止：模拟真实流式回答到一半用户关了页面。
        // 断开后 res 已 destroyed，继续 write 会 emit error——没有监听器就是未捕获异常。
        for (let index = 0; index < 500 && !input.signal?.aborted; index += 1) {
          handlers.onEvent({ type: 'message', chunk: `块${index}` })
          await new Promise((resolve) => setTimeout(resolve, 1))
        }
        handlers.onEvent({ type: 'end' })
      },
    }
    const harness = await start({ capabilities })

    const controller = new AbortController()
    // 两个阶段都可能被中止打断：连接阶段（fetch 本身拒绝）与读流阶段（text() 拒绝），都要接住。
    const pending = fetch(`${harness.baseUrl}/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], context: CONTEXT }),
      signal: controller.signal,
    })
      .then(
        (response) => response.text(),
        () => 'aborted',
      )
      .catch(() => 'aborted')
    await new Promise((resolve) => setTimeout(resolve, 30))
    controller.abort()
    await pending

    // 进程还活着、还能服务：这是对「写入已销毁的响应流」最直接的回归。
    expect((await fetch(`${harness.baseUrl}/ai/health`)).status).toBe(200)
    const after = await post(harness.baseUrl, '/ai/ad-detection', CONTEXT)
    expect(after.status).toBe(200)
  })

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

  it('请求体半途断开：不进「上游失败」告警，服务紧接着仍可用', async () => {
    const onWarn = vi.fn()
    const harness = await start({ onWarn })
    // fetch 发不出半截请求体，得用原生 http 客户端：声明 Content-Length 但只送一半就掐断。
    await new Promise<void>((resolve) => {
      const req = httpRequest(`${harness.baseUrl}/ai/ad-detection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': '1000' },
      })
      req.on('error', () => resolve()) // 掐断后客户端侧的 ECONNRESET 是预期内结果
      req.end(JSON.stringify(CONTEXT).slice(0, 20), () => {
        setTimeout(() => {
          req.destroy()
          resolve()
        }, 20)
      })
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    const logged = onWarn.mock.calls.map((call) => String(call[0])).join('\n')
    // 客户端侧问题 ≠ 上游故障：告警把运维引向模型端点就错了。
    expect(logged).not.toContain('上游失败')
    expect((await post(harness.baseUrl, '/ai/ad-detection', CONTEXT)).status).toBe(200)
  })

  it('客户端断开被能力层包成 AiError 也不误报「上游失败」（cause 链下钻）', async () => {
    const onWarn = vi.fn()
    const capabilities: AiCapabilities = {
      async detectAds(input) {
        // 模拟真实链路：signal 中止后把原始 AbortError 包成 AiError 抛出
        // （llm/client.mapNetworkError 的形状）——顶层 name 是 'AiError'，判据必须下钻 cause。
        return new Promise((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => {
            reject(
              new AiError('network', '请求已中止', {
                cause: new DOMException('This operation was aborted', 'AbortError'),
              }),
            )
          })
        })
      },
      async summarize() {
        return { summary: '', segments: [] }
      },
      async chat() {
        /* 本用例不涉及 */
      },
    }
    const harness = await start({ capabilities, onWarn })

    const controller = new AbortController()
    const pending = fetch(`${harness.baseUrl}/ai/ad-detection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(CONTEXT),
      signal: controller.signal,
    }).then(
      () => undefined,
      () => undefined,
    )
    // 先让请求真正进到能力层（挂在 abort 监听上），再模拟用户切视频断开。
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    await pending
    await new Promise((resolve) => setTimeout(resolve, 50))

    const logged = onWarn.mock.calls.map((call) => String(call[0])).join('\n')
    expect(logged).not.toContain('上游失败')
    // 服务仍可用。
    expect((await fetch(`${harness.baseUrl}/ai/health`)).status).toBe(200)
  })
})

describe('优雅停机（shutdownStreams）', () => {
  it('进行中的 SSE 流补 end{error} + [DONE] 收尾，而不是 socket 被硬掐', async () => {
    let answering = false
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
      async chat(_input, handlers) {
        handlers.onEvent({ type: 'start' })
        handlers.onEvent({ type: 'message', chunk: '开头' })
        answering = true
        await gate
        handlers.onEvent({ type: 'end' })
      },
    }
    const harness = await start({ capabilities })
    const pending = post(harness.baseUrl, '/ai/chat', {
      messages: [{ role: 'user', content: 'x' }],
      context: CONTEXT,
    }).then((response) => response.text())
    await vi.waitFor(() => expect(answering).toBe(true))

    const closed = harness.handler.shutdownStreams('服务正在关闭')
    expect(closed).toBe(1)
    release?.()

    const raw = await pending
    expect(raw).toContain('开头')
    expect(raw).toContain('服务正在关闭')
    expect(raw.trimEnd().endsWith('data: [DONE]')).toBe(true)
    // 流收束后服务进程仍能响应探活。
    expect((await fetch(`${harness.baseUrl}/ai/health`)).status).toBe(200)
  })

  it('流开始前停机：没有进行中的流可收束，返回 0，请求按原路径收场', async () => {
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
      async chat(_input, handlers) {
        handlers.onEvent({ type: 'start' })
        await gate // 一直不出首块：head 未发，不在 activeStreams 里
      },
    }
    const harness = await start({ capabilities })
    void post(harness.baseUrl, '/ai/chat', {
      messages: [{ role: 'user', content: 'x' }],
      context: CONTEXT,
    }).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(harness.handler.shutdownStreams('服务正在关闭')).toBe(0)
    release?.()
    await harness.close()
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

  it('chat 上游在首块前失败：服务端回 HTTP 504，客户端 reject——auto 回退本地直连的前提成立', async () => {
    const capabilities: AiCapabilities = {
      async detectAds() {
        return { ads: [], source: 'none' }
      },
      async summarize() {
        return { summary: '', segments: [] }
      },
      async chat(_input, handlers) {
        handlers.onEvent({ type: 'end', error: { kind: 'network', message: '服务器连不上模型端点' } })
      },
    }
    const { baseUrl } = await start({ capabilities })
    const backend = createServerBackend(clientSettings(baseUrl))
    await expect(
      backend.chat(
        { messages: [{ role: 'user', content: 'x' }], context: CONTEXT },
        { onEvent: () => undefined },
      ),
    ).rejects.toMatchObject({ kind: 'http', status: 504 })
  })

  it('token 不匹配：客户端抛 auth 类 AiError', async () => {
    const harness = await start({ token: 'right' })
    const backend = createServerBackend(clientSettings(harness.baseUrl, 'wrong'))
    await expect(backend.summarize(CONTEXT)).rejects.toMatchObject({ kind: 'auth', status: 401 })
  })
})
