// net-relay 双向纯逻辑测试：内存端口对把「客户端 ⇄ 宿主」接起来，
// 宿主的 fetchImpl 用桩注入，验证协议时序（head → chunk* → end/error）、
// 三类失败归一（网络/超时/中止）、流式桥接与取消传播。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiError } from '../../shared/error'
import {
  attachNetRelay,
  netRelayFetch,
  netRelayFetchBuffered,
  setNetRelayConnect,
} from './net-relay'
import type { RelayPort } from './net-relay'

/** 内存端口对：一端 postMessage 投递到对端监听器；disconnect 双端触发 onDisconnect。 */
function createPortPair(): { client: RelayPort; host: RelayPort } {
  const mk = (): {
    messageListeners: Array<(message: unknown) => void>
    disconnectListeners: Array<() => void>
    disconnected: boolean
  } => ({ messageListeners: [], disconnectListeners: [], disconnected: false })
  const a = mk()
  const b = mk()

  const endOf = (self: ReturnType<typeof mk>, peer: ReturnType<typeof mk>): RelayPort => ({
    postMessage(message: unknown): void {
      if (self.disconnected) return
      // 模拟 Chrome runtime 端口的 JSON 序列化语义：非 JSON 安全的值（Uint8Array 等）
      // 过端口会变形——测试必须与真实通道同构，否则挡不住这类 bug。
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

  return { client: endOf(a, b), host: endOf(b, a) }
}

/** 客户端 ⇄ 宿主整链：宿主用给定的 fetchImpl 桩，客户端经装配好的中继发请求。 */
function relayChain(fetchImpl: typeof fetch): { seen: Array<{ url: string; init: RequestInit }> } {
  const seen: Array<{ url: string; init: RequestInit }> = []
  const { client, host } = createPortPair()
  attachNetRelay(host, {
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} })
      return fetchImpl(url, init)
    }) as typeof fetch,
  })
  setNetRelayConnect(() => client)
  return { seen }
}

const REQ = { url: 'https://llm.example/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"m-1"}' }

afterEach(() => {
  setNetRelayConnect(undefined)
})

describe('netRelayFetchBuffered（非流式代取）', () => {
  it('成功：状态/类型/全文返回，请求原样到达宿主（含鉴权头与请求体）', async () => {
    const { seen } = relayChain(vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const result = await netRelayFetchBuffered(REQ)
    expect(result.status).toBe(200)
    expect(result.ok).toBe(true)
    expect(result.contentType).toContain('application/json')
    expect(result.text).toBe(JSON.stringify({ ok: 1 }))
    expect(seen[0]?.url).toBe(REQ.url)
    expect(seen[0]?.init.method).toBe('POST')
    expect((seen[0]?.init.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect(String(seen[0]?.init.body)).toBe(REQ.body)
  })

  it('宿主 fetch 抛 TypeError → AiError network「请求发不出去」', async () => {
    relayChain(vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    await expect(netRelayFetchBuffered(REQ)).rejects.toMatchObject({
      kind: 'network',
      message: '请求发不出去，请检查端点地址与网络',
    })
  })

  it('宿主死线到期（TimeoutError）→ AiError network「请求超时」', async () => {
    relayChain(vi.fn(async () => Promise.reject(new DOMException('signal timed out', 'TimeoutError'))))
    await expect(netRelayFetchBuffered(REQ)).rejects.toMatchObject({
      kind: 'network',
      message: '请求超时',
    })
  })

  it('外部中止 → AiError network「请求已中止」，且宿主侧 fetch 信号同步中止', async () => {
    const controller = new AbortController()
    const hostSignalAbort = vi.fn()
    relayChain(
      vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            hostSignalAbort()
            reject(new DOMException('aborted', 'AbortError'))
          })
        }),
      ),
    )
    const pending = netRelayFetchBuffered(REQ, controller.signal)
    // 先让 req 送达宿主、fetch 开始（同 tick 里中止会发生在消息送达之前）。
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ kind: 'network', message: '请求已中止' })
    expect(hostSignalAbort).toHaveBeenCalledTimes(1)
  })

  it('宿主侧死线由 timeoutMs 驱动（宿主拿到带死线的 signal）', async () => {
    let received: AbortSignal | null | undefined
    relayChain(
      vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        received = init?.signal
        return Promise.resolve(new Response('{}'))
      }) as unknown as typeof fetch,
    )
    await netRelayFetchBuffered({ ...REQ, timeoutMs: 50 })
    expect(received).toBeDefined()
  })
})

describe('netRelayFetch（流式代取）', () => {
  function streamResponse(chunks: string[], status = 200): Response {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
  }

  it('head → chunk* → end：分块按序到达，end 关闭流', async () => {
    relayChain(vi.fn(async () => streamResponse(['data: {"a":1}\n', 'data: [DONE]\n'])))
    const result = await netRelayFetch(REQ)
    expect(result.status).toBe(200)
    expect(result.contentType).toContain('text/event-stream')
    const reader = result.body.getReader()
    const decoder = new TextDecoder()
    const chunks: string[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(decoder.decode(value))
    }
    expect(chunks).toEqual(['data: {"a":1}\n', 'data: [DONE]\n'])
  })

  it('宿主流中途抛错 → 已开始的读取以「流中断」失败', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode('data: partial\n'))
      },
      pull(controller): void {
        controller.error(new TypeError('upstream cut'))
      },
    })
    relayChain(vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })))
    const result = await netRelayFetch(REQ)
    const reader = result.body.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe('data: partial\n')
    await expect(reader.read()).rejects.toThrow(/流式响应在传输中中断/)
  })

  it('消费方 cancel → 宿主侧 fetch 被中止（不白烧 token）', async () => {
    const hostSignalAbort = vi.fn()
    relayChain(
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        init?.signal?.addEventListener('abort', hostSignalAbort)
        // 流不收尾：消费方 cancel 应当中止上游。
        const body = new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(new TextEncoder().encode('data: x\n'))
          },
        })
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }) as unknown as typeof fetch,
    )
    const result = await netRelayFetch(REQ)
    await result.body.cancel()
    expect(hostSignalAbort).toHaveBeenCalledTimes(1)
  })

  it('非 2xx 状态照常透传（ok=false，状态码归上层映射）', async () => {
    relayChain(vi.fn(async () => new Response('{"error":1}', { status: 401 })))
    const result = await netRelayFetch(REQ)
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
    expect(await result.body.getReader().read()).toMatchObject({ done: false })
  })
})

describe('装配守卫', () => {
  it('未装配中继时 netRelayFetch 直接拒绝（config），调用方走直连路径', async () => {
    setNetRelayConnect(undefined)
    await expect(netRelayFetch(REQ)).rejects.toMatchObject({ kind: 'config' })
    expect(() => new AiError('network', 'x')).not.toThrow()
  })
})
