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
    req.on('error', (cause) => reject(new AiError('network', '读取请求体失败', { cause })))
  })
}

async function parseJsonBody(raw: string): Promise<Record<string, unknown>> {
  if (raw.trim() === '') throw new AiError('parse', '请求体为空')
  let value: unknown
  try {
    value = JSON.parse(raw)
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

export function createRequestHandler(deps: ServerDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const token = deps.token ?? ''
  const allowOrigin = deps.allowOrigin ?? '*'
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
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

  function sendError(req: IncomingMessage, res: ServerResponse, error: unknown): void {
    const status = statusOfError(error)
    if (status >= 500) deps.onWarn?.(`上游失败（${status}）：${error instanceof Error ? error.message : '未知错误'}`)
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

  return function handle(req: IncomingMessage, res: ServerResponse): void {
    const path = pathOf(req)
    const method = req.method ?? 'GET'

    if (method === 'OPTIONS') {
      send(res, 204, '')
      return
    }

    if (path === AI_PATHS.health && method === 'GET') {
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

    if (!Object.values(AI_PATHS).includes(path as (typeof AI_PATHS)[keyof typeof AI_PATHS])) {
      send(res, 404, JSON.stringify({ error: { kind: 'http', message: `未知路径 ${path}` } }))
      return
    }
    if (method !== 'POST') {
      send(res, 405, JSON.stringify({ error: { kind: 'http', message: `${path} 只接受 POST` } }))
      return
    }
    if (token !== '') {
      const header = req.headers.authorization ?? ''
      const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
      if (provided === '' || !tokenMatches(provided, token)) {
        send(res, 401, JSON.stringify({ error: { kind: 'auth', message: 'Authorization: Bearer ⟨token⟩ 缺失或不匹配' } }))
        return
      }
    }

    void (async () => {
      const body = await parseJsonBody(await readBody(req, maxBodyBytes))
      const context: AiContext = parseContext(contextOf(body))
      // 客户端断开（用户关页/切视频）要立即中止上游模型调用，否则白烧 token。
      // 两个事件都听：请求流被弃时触发 close，响应侧断开（SSE 场景）触发 res 的 close。
      const controller = new AbortController()
      const onDisconnect = (): void => controller.abort()
      req.on('close', onDisconnect)
      res.on('close', onDisconnect)

      if (path === AI_PATHS.chat) {
        const messages: ChatMessage[] = parseChatMessages(body.messages)
        res.writeHead(200, {
          'Access-Control-Allow-Origin': allowOrigin,
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          ...SSE_HEADERS,
        })
        // 先把 start 冲出去：首 token 可能要等几秒，客户端得先看到响应已建立。
        res.write(sseEvent({ type: 'start' }))
        try {
          await capabilities.chat({ messages, context, signal: controller.signal }, {
            onEvent: (event) => {
              // 能力层自己也会 emit start；线上只保留服务端这一份，避免客户端看到两个 start。
              if (event.type === 'start') return
              if (!res.writableEnded) res.write(sseEvent(event))
            },
          })
        } catch (error) {
          // 能力层约定流开始后以 end{error} 收束；这里兜住流开始前的意外，保证终止性。
          if (!res.writableEnded) res.write(sseEvent({ type: 'end', error: errorInfoFrom(error) }))
        }
        if (!res.writableEnded) {
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
      if (!res.headersSent) sendError(req, res, error)
      else if (!res.writableEnded) res.end()
    })
  }
}
