// 内容脚本 → 后台的网络中继：内容脚本运行在页面源（bilibili.com）上，跨域 fetch
// 受页面 CORS 约束——端点不放行 B 站源就永远连不上；而后台 service worker 拿着
// host_permissions（http/https 全域），fetch 不受 CORS 限制。AI 直连流量因此统一
// 改走这条 runtime 端口通道，端点是否放行跨域不再影响可用性（请求仍走系统代理）。
//
// 纯逻辑、双向可注入：宿主侧 attachNetRelay(port)（background 接线），
// 客户端侧 netRelayFetch / netRelayFetchBuffered（client.ts 按需启用）。
// 一个端口只服务一个请求：生命周期 = 连接 → req → head → chunk* → end/error → 断开。
// 协议消息只含地址与请求体，鉴权头照原样转发给用户自己配置的端点，不落任何日志。

import { AiError } from '../../shared/error'

export const NET_RELAY_PORT_NAME = 'bh-net-relay'

/** 客户端 → 宿主：请求本体、保活心跳（消息到达即刷新 SW 闲置计时）、主动中止。 */
export type NetRelayClientMessage =
  | {
      t: 'req'
      url: string
      method: string
      headers: Record<string, string>
      body?: string
      /** 整条请求（含响应体收完）的宿主侧死线；流式请求不传，由消费方 abort。 */
      timeoutMs?: number
    }
  | { t: 'keep' }
  | { t: 'abort' }

/**
 * 宿主 → 客户端：响应头（一次）、响应体分块（多次）、正常收束、上游失败。
 * 注意：runtime 端口消息只支持 JSON 序列化——二进制分块必须 base64 编码为字符串，
 * 直接传 Uint8Array 会在过端口时退化成普通对象（TextDecoder 当场 TypeError）。
 */
export type NetRelayHostMessage =
  | { t: 'head'; status: number; contentType: string }
  | { t: 'chunk'; data: string }
  | { t: 'end' }
  | { t: 'error'; name: string; message: string }

/** Uint8Array → base64（浏览器/SW 通用，不依赖 Buffer）。 */
export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] as number)
  return btoa(binary)
}

/** base64 → Uint8Array。 */
export function base64ToUint8(encoded: string): Uint8Array {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** browser.runtime.Port 的最小面：两侧逻辑都只依赖这些，测试用内存管道即可。 */
export interface RelayPort {
  postMessage(message: unknown): void
  disconnect(): void
  onMessage: { addListener(listener: (message: unknown) => void): void }
  onDisconnect: { addListener(listener: () => void): void }
}

export interface NetRelayRequestParams {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  /** 整条请求（含响应体收完）的宿主侧死线；流式请求不传，由消费方 abort。 */
  timeoutMs?: number
}

// ---------- 宿主侧（background 接线） ----------

export function isNetRelayClientMessage(value: unknown): value is NetRelayClientMessage {
  if (typeof value !== 'object' || value === null) return false
  const kind = (value as { t?: unknown }).t
  if (kind === 'keep' || kind === 'abort') return true
  if (kind !== 'req') return false
  const req = value as Record<string, unknown>
  return typeof req.url === 'string' && typeof req.method === 'string'
}

/**
 * 宿主处理器：一个端口一个请求。req 到达后发起 fetch（宿主侧带死线与断连中止），
 * 响应头先走 head，响应体逐块转发（非流式消费方自己缓冲），收束发 end；失败发
 * error{name,message}——客户端按 name 归一为超时/中止/网络三类。客户端 abort 或
 * 断开连接都会中止上游 fetch，不白烧 token。
 */
export function attachNetRelay(port: RelayPort, deps: { fetchImpl?: typeof fetch } = {}): void {
  const fetchImpl = deps.fetchImpl ?? fetch
  let controller: AbortController | undefined

  port.onMessage.addListener((raw) => {
    if (!isNetRelayClientMessage(raw)) return
    if (raw.t === 'keep') return // 保活：消息到达本身已刷新 SW 闲置计时
    if (raw.t === 'abort') {
      controller?.abort()
      return
    }
    void runRelayRequest(port, raw, fetchImpl, (created) => {
      controller = created
    })
  })

  // 客户端断开（消费方 cancel / 页面关闭）：立刻中止上游。
  port.onDisconnect.addListener(() => controller?.abort())
}

async function runRelayRequest(
  port: RelayPort,
  req: NetRelayRequestParams,
  fetchImpl: typeof fetch,
  setController: (controller: AbortController) => void,
): Promise<void> {
  const controller = new AbortController()
  setController(controller)
  const signal =
    req.timeoutMs === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, AbortSignal.timeout(req.timeoutMs)])

  let response: Response
  try {
    response = await fetchImpl(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body === undefined ? {} : { body: req.body }),
      signal,
    })
  } catch (cause) {
    console.error('[bili-helper/net-relay:sw] fetch 失败', req.url, String(cause))
    postHostError(port, cause)
    return
  }
  port.postMessage({
    t: 'head',
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
  })
  const body = response.body
  if (!body) {
    port.postMessage({ t: 'end' })
    return
  }
  const reader = body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) port.postMessage({ t: 'chunk', data: uint8ToBase64(value) })
    }
    port.postMessage({ t: 'end' })
  } catch (cause) {
    console.error('[bili-helper/net-relay:sw] 流读取失败', req.url, String(cause))
    postHostError(port, cause)
  } finally {
    void reader.cancel().catch(() => {})
  }
}

function postHostError(port: RelayPort, cause: unknown): void {
  const error = cause instanceof Error ? cause : undefined
  port.postMessage({
    t: 'error',
    name: error?.name ?? 'Error',
    message: error?.message ?? '请求失败',
  })
}

// ---------- 客户端侧（client.ts 按上下文启用） ----------

/** 内容脚本入口装配的中继通道；未装配（扩展页/后台/测试）时 client 走直连 fetch。 */
let relayConnect: (() => RelayPort) | undefined

export function setNetRelayConnect(connect: (() => RelayPort) | undefined): void {
  relayConnect = connect
}

export function netRelayEnabled(): boolean {
  return relayConnect !== undefined
}

export interface NetRelayResult {
  ok: boolean
  status: number
  contentType: string
  /** 响应体流：pull 驱动的分块桥接；end 关闭、error/断连让 pending 读取失败。 */
  body: ReadableStream<Uint8Array>
}

export interface NetRelayBufferedResult {
  ok: boolean
  status: number
  contentType: string
  text: string
}

interface ReadWaiter {
  resolve: (result: IteratorResult<Uint8Array>) => void
  reject: (error: unknown) => void
}

/**
 * 经后台代取一次请求。head 阶段失败（fetch 抛错/外部中止/断连）整体 reject 为
 * AiError（与直连路径同形状）；head 之后响应体由消费方从流里读，错误以原生形态
 * 抛出（AbortError/TimeoutError 命名等），交由上层既有映射归类。
 */
export async function netRelayFetch(
  req: NetRelayRequestParams,
  external?: AbortSignal,
): Promise<NetRelayResult> {
  const connect = relayConnect
  if (connect === undefined) {
    throw new AiError('config', '网络中继未装配：仅内容脚本需要走后台代取')
  }
  const port = connect()

  let headSettled = false
  let resolveHead: ((head: { status: number; contentType: string }) => void) | undefined
  let rejectHead: ((error: unknown) => void) | undefined
  const headPromise = new Promise<{ status: number; contentType: string }>((resolve, reject) => {
    resolveHead = resolve
    rejectHead = reject
  })

  let terminal = false
  let streamFailure: unknown
  let chunksSeen = 0
  const pendingChunks: Uint8Array[] = []
  const waiters: ReadWaiter[] = []

  // 保活心跳：长流（总结/问答 SSE）可能长时间无分块，20 秒一拍防止 SW 闲置熄火。
  const keepTimer = setInterval(() => {
    if (!terminal) port.postMessage({ t: 'keep' })
  }, 20_000)
  const finish = (): void => {
    terminal = true
    clearInterval(keepTimer)
  }
  const failPendingReads = (error: unknown): void => {
    for (const waiter of waiters.splice(0)) waiter.reject(error)
  }
  const settleWaiters = (result: IteratorResult<Uint8Array>): void => {
    for (const waiter of waiters.splice(0)) waiter.resolve(result)
  }

  const onHostMessage = (raw: unknown): void => {
    const message = raw as NetRelayHostMessage
    if (message?.t === 'head' && !headSettled) {
      headSettled = true
      resolveHead?.({ status: message.status, contentType: message.contentType })
      return
    }
    if (message?.t === 'chunk') {
      chunksSeen += 1
      const bytes = base64ToUint8(message.data)
      const waiter = waiters.shift()
      if (waiter) waiter.resolve({ done: false, value: bytes })
      else pendingChunks.push(bytes)
      return
    }
    if (message?.t === 'end') {
      finish()
      settleWaiters({ done: true, value: undefined })
      if (!headSettled) {
        headSettled = true
        rejectHead?.(new AiError('network', '请求发不出去，请检查端点地址与网络'))
      }
      port.disconnect()
      return
    }
    if (message?.t === 'error') {
      finish()
      console.error('[bili-helper/net-relay] 宿主报错', message.name, message.message)
      if (!headSettled) {
        headSettled = true
        rejectHead?.(transportErrorOf(message.name))
      } else {
        streamFailure = streamFailureOf(message.name)
        failPendingReads(streamFailure)
      }
      port.disconnect()
    }
  }

  const onDisconnect = (): void => {
    if (terminal) return
    finish()
    console.error('[bili-helper/net-relay] 端口断开 ' + JSON.stringify({ headSettled, url: req.url, chunksSeen }))
    if (!headSettled) {
      headSettled = true
      // 后台连接中断多半是「构建更新了但扩展没重载」：陈旧扩展的 SW 起不来、无人应答。
      // 文案直接指到重载，而不是让用户去查地址与网络。
      rejectHead?.(
        new AiError(
          'network',
          '请求发不出去：扩展后台未响应，请在扩展管理页重载扩展后重试；已重载仍失败则检查网络与系统代理',
        ),
      )
    } else {
      failPendingReads(new Error('流式响应在传输中中断（后台连接断开）'))
    }
  }

  const onExternalAbort = (): void => {
    if (terminal) return
    console.error('[bili-helper/net-relay] 外部信号中止', { headSettled, url: req.url, reason: String(external?.reason) })
    port.postMessage({ t: 'abort' })
    finish()
    const timeout = external?.reason instanceof Error && external.reason.name === 'TimeoutError'
    if (!headSettled) {
      headSettled = true
      rejectHead?.(new AiError('network', timeout ? '请求超时' : '请求已中止'))
    } else {
      failPendingReads(timeout ? timeoutFailure() : abortFailure('请求已中止'))
    }
    port.disconnect()
  }

  external?.addEventListener('abort', onExternalAbort, { once: true })
  port.onMessage.addListener(onHostMessage)
  port.onDisconnect.addListener(onDisconnect)
  port.postMessage({ t: 'req', ...req })

  let head: { status: number; contentType: string }
  try {
    head = await headPromise
  } catch (error) {
    // 失败路径不再摘监听器：下面的 disconnect() 会掐断整条端口，消息不会再进来。
    port.disconnect()
    throw error
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      const queued = pendingChunks.shift()
      if (queued !== undefined) {
        controller.enqueue(queued)
        return
      }
      if (streamFailure !== undefined) throw streamFailure
      if (terminal) {
        controller.close()
        return
      }
      const result = await new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
        waiters.push({ resolve, reject })
      })
      if (result.done) controller.close()
      else controller.enqueue(result.value)
    },
    cancel(): void {
      // 消费方放弃（如流式收尾 reader.cancel）：停掉上游，别让端点白生成。
      finish()
      port.postMessage({ t: 'abort' })
      port.disconnect()
    },
  })

  return { ok: head.status >= 200 && head.status < 300, status: head.status, contentType: head.contentType, body }
}

/** 非流式消费方用：整条收完再返回（embeddings/补全/模型列表的响应体都是一次成型）。 */
export async function netRelayFetchBuffered(
  req: NetRelayRequestParams,
  external?: AbortSignal,
): Promise<NetRelayBufferedResult> {
  const result = await netRelayFetch(req, external)
  const reader = result.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } catch (cause) {
    throw bufferedFailureOf(cause)
  }
  return { ok: result.ok, status: result.status, contentType: result.contentType, text }
}

// head 阶段的宿主错误 → AiError network（与直连 fetch 抛错的映射同口径）。
function transportErrorOf(name: string): AiError {
  if (name === 'TimeoutError') return new AiError('network', '请求超时')
  return new AiError('network', '请求发不出去，请检查端点地址与网络')
}

// head 之后（流式读期间）的宿主错误 → 原生形态（上层 readStreamChunk 按名字归类）。
function streamFailureOf(name: string): unknown {
  if (name === 'TimeoutError') return timeoutFailure()
  if (name === 'AbortError') return new Error('流式响应在传输中中断')
  return new Error('流式响应在传输中中断')
}

function timeoutFailure(): DOMException {
  return new DOMException('请求超时', 'TimeoutError')
}

function abortFailure(message: string): DOMException {
  return new DOMException(message, 'AbortError')
}

// 缓冲读中途失败：交给调用方统一的网络类错误。
function bufferedFailureOf(cause: unknown): AiError {
  if (cause instanceof AiError) return cause
  const name = cause instanceof Error ? cause.name : ''
  if (name === 'TimeoutError') return new AiError('network', '请求超时')
  if (name === 'AbortError') return new AiError('network', '请求已中止')
  return new AiError('network', '请求发不出去，请检查端点地址与网络')
}
