// 转发服务端主体：把扩展端 server 适配器（modules/ai/backend/server.ts）的三条契约路径
// 接到与端上完全相同的能力实现（createLocalBackend）——服务端不是另写一套识别逻辑，
// 而是把同一份 RAG + 提示词跑在没有 CORS 与算力限制的地方。
//
// 契约（冻结）：POST /ai/{ad-detection|summary|chat}，请求体是端口形状的原始 context，
// 响应与端上同形；chat 是同构 SSE 三事件（start/message/end，end 必然收尾）。
// 额外提供 GET /ai/health 供设置页「一键体检」探活（未实现该路径的第三方服务同样可用）。

import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AiSettings } from '../modules/settings'
import type { AiCapabilities, AiContext, ChatMessage } from '../modules/ai/port'
import { createLocalBackend } from '../modules/ai/backend/local'
import { AiError, errorInfoFrom } from '../modules/shared/error'
import type { AiErrorInfo } from '../modules/shared/error'
import { parseChatMessages, parseContext, parseStrategy } from './parse'
import { SSE_HEADERS, sseDone, sseEvent } from './sse'

export const AI_PATHS = {
  health: '/ai/health',
  detectAds: '/ai/ad-detection',
  summarize: '/ai/summary',
  chat: '/ai/chat',
} as const

export interface ServerDeps {
  settings: AiSettings
  /** 非空即要求 Authorization: Bearer ⟨token⟩；/ai/health 不鉴权（供负载均衡探活）。 */
  token?: string
  allowOrigin?: string
  maxBodyBytes?: number
  /** 测试注入点；缺省用与扩展端同一份本地能力实现。 */
  capabilities?: AiCapabilities
  /** 降级与异常的上报口（只报状态与原因，绝不带 Key/Token/请求体）。 */
  onWarn?: (message: string) => void
  version?: string
}

export const DEFAULT_MAX_BODY_BYTES = 24 * 1024 * 1024

/** AiError kind → HTTP 状态：客户端只按状态码分类，原因文案在响应体里给人看。 */
export function statusOfError(error: unknown): number {
  if (error instanceof PayloadTooLargeError) return 413
  if (error instanceof RequestAbortedError) return 400
  if (!(error instanceof AiError)) return 500
  switch (error.kind) {
    case 'config':
      return 500 // 服务端自己没配好，不是调用方的错
    case 'auth':
      return 502 // 上游模型端点鉴权失败，对调用方呈现为上游错误
    case 'http':
      return 502
    case 'network':
      return 504
    case 'parse':
      return 400
  }
}

/** 请求体超上限：语义是 413 而不是 400，单独一个类型让状态映射不靠猜。 */
export class PayloadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`请求体超过上限 ${maxBytes} 字节`)
    this.name = 'PayloadTooLargeError'
  }
}

/**
 * 请求体没能收完（多半是客户端半途断开）：这是调用方侧的问题，
 * 不该混进「上游失败」的告警通道把运维引向模型端点。
 */
export class RequestAbortedError extends Error {
  constructor(cause?: unknown) {
    super('请求体未收完（客户端可能已断开）')
    this.name = 'RequestAbortedError'
    this.cause = cause
  }
}

/** 上游在首块之前就失败：网络类 → 504，其余 → 502（config 类保持 500，那是服务端自己没配好）。 */
export function upstreamFailure(info: AiErrorInfo): AiError {
  const kind: AiError['kind'] =
    info.kind === 'network' || info.kind === 'config' ? info.kind : 'http'
  return new AiError(kind, info.message, info.status === undefined ? {} : { status: info.status })
}

/**
 * 客户端侧失败（不进「上游失败」告警）：handler 的 controller 已中止是最直接的判据；
 * 兜底沿 cause 链找 AbortError——客户端断开在能力层可能被包成 AiError（顶层 name 是
 * 'AiError'，得下钻 cause）。TimeoutError 不算客户端侧：那是上游模型端点的死线，真故障。
 */
function isClientSide(error: unknown, clientAborted: boolean): boolean {
  if (clientAborted) return true
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    if (cause.name === 'AbortError') return true
  }
  return false
}

function jsonBody(error: unknown): string {
  const info: AiErrorInfo =
    error instanceof AiError
      ? { kind: error.kind, message: error.message, ...(error.status === undefined ? {} : { status: error.status }) }
      : errorInfoFrom(error)
  return JSON.stringify({ error: info })
}

function pathOf(req: IncomingMessage): string {
  const url = req.url ?? '/'
  const queryStart = url.indexOf('?')
  return queryStart === -1 ? url : url.slice(0, queryStart)
}

/** 定长比较：token 校验不用 === ，避免逐字符短路留下时序侧信道。 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        // 只暂停不销毁：销毁套接字会让 413 响应发不出去，客户端只看到「连接被关」。
        // 暂停后由 handler 回响应（带 Connection: close），响应写完再断开。
        req.pause()
        reject(new PayloadTooLargeError(maxBytes))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', (cause) => reject(new RequestAbortedError(cause)))
  })
}

async function parseJsonBody(raw: string): Promise<Record<string, unknown>> {
  // 容忍前导 BOM：Windows 侧工具（PowerShell Out-File、记事本）导出的 JSON 天然带 BOM，
  // RFC 8259 虽然禁止，但对一个希望第三方也能消费的参考实现，剥掉它的成本远低于一次 400。
  const text = raw.replace(/^\uFEFF/, '')
  if (text.trim() === '') throw new AiError('parse', '请求体为空')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new AiError('parse', '请求体不是合法 JSON', { cause })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AiError('parse', '请求体必须是 JSON 对象')
  }
  return value as Record<string, unknown>
}

/**
 * context 的两种合法摆放：chat 送 {messages, context:{video,…}} 嵌套形状，
 * ad-detection/summary 送平铺形状。两种都收，避免服务端只认一种就把另一半调用打成 400。
 */
function contextOf(body: Record<string, unknown>): Record<string, unknown> {
  const nested = body.context
  return typeof nested === 'object' && nested !== null && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : body
}

/** 请求处理器 + 停机钩子：优雅关闭时要先给进行中的 SSE 流补终止事件，再断连接。 */
export interface RequestHandler {
  (req: IncomingMessage, res: ServerResponse): void
  /** 给所有进行中的 SSE 流补 end{error} + [DONE]，返回被收束的流数量。 */
  shutdownStreams(reason: string): number
}

export function createRequestHandler(deps: ServerDeps): RequestHandler {
  const token = deps.token ?? ''
  const allowOrigin = deps.allowOrigin ?? '*'
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  /** 进行中的 SSE 响应：停机时逐条收束，客户端不能只看到 socket 被掐断（契约要求 end 必然收尾）。 */
  const activeStreams = new Set<ServerResponse>()
  // 能力层无状态（设置在闭包里），整个进程共用一份即可。
  const capabilities: AiCapabilities =
    deps.capabilities ??
    createLocalBackend(deps.settings, {
      onVectorFallback: () => deps.onWarn?.('向量端点不可用，本次识别退化为纯词表检索'),
    })

  function send(res: ServerResponse, status: number, body: string, json = true): void {
    res.writeHead(status, {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      ...(json ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    })
    res.end(body)
  }

  function sendError(
    req: IncomingMessage,
    res: ServerResponse,
    error: unknown,
    clientAborted = false,
  ): void {
    const status = statusOfError(error)
    // 用户切视频/关页导致的中止、以及请求体没收完，都不是故障：
    // 混进「上游失败」告警会把运维引向模型端点，真故障反而被噪音淹掉。
    const clientSide = isClientSide(error, clientAborted)
    if (status >= 500 && !clientSide) {
      deps.onWarn?.(`上游失败（${status}）：${error instanceof Error ? error.message : '未知错误'}`)
    }
    if (error instanceof PayloadTooLargeError) {
      // 请求体没读完就回响应：声明关连接，响应冲出去后再断，避免半截 body 被当成下一个请求。
      res.writeHead(status, {
        'Access-Control-Allow-Origin': allowOrigin,
        'Content-Type': 'application/json; charset=utf-8',
        Connection: 'close',
      })
      res.end(jsonBody(error))
      res.on('finish', () => req.destroy())
      return
    }
    send(res, status, jsonBody(error))
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    // 客户端中途断开后再写响应，会在 res 上 emit 'error'；没有监听器就是未捕获异常，
    // 一个用户关页面就能打崩整个进程。断开本身已由 AbortController 处理（停掉上游调用），
    // 这里只需吞掉写入侧的错误并记一条状态。
    res.on('error', () => {
      deps.onWarn?.('响应写入失败（客户端已断开）')
    })
    const path = pathOf(req)
    const method = req.method ?? 'GET'

    if (method === 'OPTIONS') {
      send(res, 204, '')
      return
    }

    // HEAD 一并放行：负载均衡与 curl -I 这类探活器常用 HEAD，health 是幂等只读，
    // 回 405 会让探活误判服务不可用（Node 对 HEAD 自动不发响应体）。
    if (path === AI_PATHS.health && (method === 'GET' || method === 'HEAD')) {
      send(
        res,
        200,
        JSON.stringify({
          ok: true,
          service: 'bili-helper-ai',
          version: deps.version ?? '0.0.0',
          // 只报「配没配」，绝不回显地址或 Key。
          configured: deps.settings.apiUrl !== '' && deps.settings.model !== '',
        }),
      )
      return
    }

    // 鉴权在路由匹配之前：否则未鉴权就能用 404/405 枚举出路由表，把这个服务的指纹送出去。
    if (token !== '') {
      const header = req.headers.authorization ?? ''
      const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
      if (provided === '' || !tokenMatches(provided, token)) {
        send(res, 401, JSON.stringify({ error: { kind: 'auth', message: 'Authorization: Bearer ⟨token⟩ 缺失或不匹配' } }))
        return
      }
    }

    if (!Object.values(AI_PATHS).includes(path as (typeof AI_PATHS)[keyof typeof AI_PATHS])) {
      // 不回显请求路径：那是调用方自己送来的内容，原样返回只会被用来做反射/日志注入。
      send(res, 404, JSON.stringify({ error: { kind: 'http', message: '未知路径' } }))
      return
    }
    if (method !== 'POST') {
      send(res, 405, JSON.stringify({ error: { kind: 'http', message: '该路径只接受 POST' } }))
      return
    }

    // 外层 catch 也要知道「客户端是否已断开」，而 controller 在 IIFE 里才创建：经此变量带出。
    let requestSignal: AbortSignal | undefined
    void (async () => {
      const body = await parseJsonBody(await readBody(req, maxBodyBytes))
      const context: AiContext = parseContext(contextOf(body))
      // 客户端断开（用户关页/切视频）要立即中止上游模型调用，否则白烧 token。
      // 两个事件都听：请求流被弃时触发 close，响应侧断开（SSE 场景）触发 res 的 close。
      const controller = new AbortController()
      requestSignal = controller.signal
      const onDisconnect = (): void => controller.abort()
      req.on('close', onDisconnect)
      res.on('close', onDisconnect)

      if (path === AI_PATHS.chat) {
        const messages: ChatMessage[] = parseChatMessages(body.messages)
        // 契约要求「流开始前的失败必须让客户端 reject」——auto 模式据此回退浏览器直连。
        // 但能力层把一切上游失败收敛成 in-band end{error}（它永不 throw）；若照直先发 SSE 200 头，
        // 客户端就永远认为「流已开始」，服务器上游挂了也不会回退——而这恰恰是最该回退的场景
        // （服务器所在网络连不上模型端点，用户浏览器却能直连）。
        // 因此首块延迟：出现第一个 message 才升级为 SSE；此前带错收束就改回 HTTP 错误。
        let headSent = false
        let preStreamError: AiErrorInfo | undefined
        const canWrite = (): boolean => !res.writableEnded && !res.destroyed
        const writeSseHead = (): void => {
          headSent = true
          res.writeHead(200, {
            'Access-Control-Allow-Origin': allowOrigin,
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            ...SSE_HEADERS,
          })
          res.write(sseEvent({ type: 'start' }))
          // 登记为进行中的流：优雅停机时逐条补终止事件（close 覆盖正常结束与断连两种出口）。
          activeStreams.add(res)
          res.on('close', () => activeStreams.delete(res))
        }
        try {
          await capabilities.chat({ messages, context, signal: controller.signal }, {
            onEvent: (event) => {
              // 能力层自己会 emit start；线上只保留服务端这一份，避免客户端看到两个 start。
              if (event.type === 'start') return
              if (!headSent) {
                if (event.type === 'end') {
                  // 没有任何 message 就收束：带错 → 交给下面的 HTTP 错误分支（触发客户端回退）；
                  // 不带错 → 空回答，仍按正常 SSE 走完（客户端要看到 end 事件才算收到终止）。
                  if (event.error) {
                    preStreamError = event.error
                  } else {
                    writeSseHead()
                    if (canWrite()) res.write(sseEvent(event))
                  }
                  return
                }
                writeSseHead()
              }
              if (canWrite()) res.write(sseEvent(event))
            },
          })
        } catch (error) {
          // 能力层约定流开始后以 end{error} 收束；这里兜住流开始前的意外，保证终止性。
          if (!headSent) preStreamError = errorInfoFrom(error)
          else if (canWrite()) res.write(sseEvent({ type: 'end', error: errorInfoFrom(error) }))
        }
        if (!headSent) {
          if (preStreamError) {
            // 上游在首块之前就失败：回 HTTP 错误而不是 SSE，客户端 reject → auto 回退本地直连。
            sendError(req, res, upstreamFailure(preStreamError), requestSignal?.aborted === true)
          } else {
            // 能力层一个事件都没给（实现异常）：也要给出终止的 SSE，客户端不能悬挂。
            writeSseHead()
            if (canWrite()) {
              res.write(
                sseEvent({ type: 'end', error: { kind: 'network', message: '服务器没有返回任何内容' } }),
              )
            }
          }
        }
        if (headSent && canWrite()) {
          res.write(sseDone())
          res.end()
        }
        return
      }

      if (path === AI_PATHS.detectAds) {
        const result = await capabilities.detectAds({
          ...context,
          strategy: parseStrategy(body.strategy),
          signal: controller.signal,
        })
        send(res, 200, JSON.stringify(result))
        return
      }

      const result = await capabilities.summarize({
        video: context.video,
        subtitles: context.subtitles,
        danmaku: context.danmaku,
        signal: controller.signal,
      })
      send(res, 200, JSON.stringify(result))
    })().catch((error) => {
      if (!res.headersSent) sendError(req, res, error, requestSignal?.aborted === true)
      else if (!res.writableEnded && !res.destroyed) res.end()
    })
  }

  const handler = handle as RequestHandler
  handler.shutdownStreams = (reason: string): number => {
    let closed = 0
    for (const stream of activeStreams) {
      if (stream.writableEnded || stream.destroyed) continue
      // 契约要求 end 必然收尾：停机也要让客户端拿到 end{error} + [DONE]，
      // 而不是 socket 被硬掐（那样面板会永远停在「正在回答…」）。
      stream.write(sseEvent({ type: 'end', error: { kind: 'network', message: reason } }))
      stream.write(sseDone())
      stream.end()
      closed += 1
    }
    activeStreams.clear()
    return closed
  }
  return handler
}
