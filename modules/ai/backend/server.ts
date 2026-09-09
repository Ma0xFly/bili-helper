// server 适配器：按既定契约把能力转发到自建服务（POST {serverBaseUrl}/ai/{ad-detection|summary|chat}），
// 请求体携带端口形状的原始 context；serverToken 非空时统一加 Authorization: Bearer。
// chat 先转发服务端的同构 SSE 三事件：流开始前失败直接 reject（auto 模式据此回退 local），
// 流开始后的任何失败以 end{error} 收束，保证终止性。

import { AiError, errorInfoFrom } from '../../shared/error'
import type { AiErrorInfo, AiErrorKind } from '../../shared/error'
import type { AiSettings } from '../../settings'
import { isAbortError, mapNetworkError, mapResponseError } from '../llm/client'
import type {
  AiCapabilities,
  AiChatEvent,
  ChatHandlers,
  ChatInput,
  DetectAdsInput,
  DetectAdsResult,
  SummarizeInput,
  SummarizeResult,
} from '../port'

const AI_PATHS = {
  detectAds: 'ai/ad-detection',
  summarize: 'ai/summary',
  chat: 'ai/chat',
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (isRecord(value)) return value
  throw new AiError('parse', message)
}

function asSeconds(value: unknown): number {
  // 负数时间段无意义：钳制到 0，避免坏数据进 UI 与跳播逻辑。
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

function parseDetectAdsResult(data: unknown): DetectAdsResult {
  const root = requireRecord(data, '去广告响应不是合法 JSON 对象')
  if (!Array.isArray(root.ads)) throw new AiError('parse', '去广告响应缺少 ads 数组')
  const ads = root.ads.map((item) => {
    const ad = requireRecord(item, '去广告响应 ad 条目形状不合法')
    return {
      start: asSeconds(ad.start),
      end: asSeconds(ad.end),
      product_name: typeof ad.product_name === 'string' ? ad.product_name : '',
      ad_content: typeof ad.ad_content === 'string' ? ad.ad_content : '',
      confidence: typeof ad.confidence === 'number' ? ad.confidence : 0,
    }
  })
  const source: DetectAdsResult['source'] =
    root.source === 'rag' || root.source === 'llm' || root.source === 'none' ? root.source : 'rag'
  return { ads, source }
}

function parseSummarizeResult(data: unknown): SummarizeResult {
  const root = requireRecord(data, '总结响应不是合法 JSON 对象')
  if (typeof root.summary !== 'string') throw new AiError('parse', '总结响应缺少 summary 字段')
  if (!Array.isArray(root.segments)) throw new AiError('parse', '总结响应缺少 segments 数组')
  const segments = root.segments.map((item, index) => {
    const segment = requireRecord(item, '总结响应 segment 条目形状不合法')
    return {
      start: asSeconds(segment.start),
      end: asSeconds(segment.end),
      label: typeof segment.label === 'string' && segment.label.trim() !== '' ? segment.label : `分段 ${index + 1}`,
    }
  })
  return { summary: root.summary, segments }
}

// 服务端 end.error 透传归一：形状不明时收敛为 network 摘要，保证消费方拿到可渲染错误。
function normalizeServerError(value: unknown): AiErrorInfo {
  if (isRecord(value) && typeof value.message === 'string') {
    const kind: AiErrorKind =
      value.kind === 'network' || value.kind === 'http' || value.kind === 'auth' ||
      value.kind === 'parse' || value.kind === 'config'
        ? value.kind
        : 'network'
    const status = typeof value.status === 'number' ? value.status : undefined
    return { kind, message: value.message, ...(status === undefined ? {} : { status }) }
  }
  return { kind: 'network', message: '服务器返回了未知错误' }
}

function parseServerEvent(line: string): AiChatEvent | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  const payload = trimmed.slice('data:'.length).trim()
  if (payload === '[DONE]') return { type: 'end' }
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  if (value.type === 'message') {
    return typeof value.chunk === 'string' ? { type: 'message', chunk: value.chunk } : null
  }
  if (value.type === 'end') {
    return {
      type: 'end',
      ...(value.error === undefined ? {} : { error: normalizeServerError(value.error) }),
    }
  }
  return null
}

async function readServerChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  try {
    return await reader.read()
  } catch (cause) {
    if (isAbortError(cause) || signal?.aborted) throw new AiError('network', '请求已中止', { cause })
    throw new AiError('network', '服务器流式响应在传输中中断', { cause })
  }
}

async function relayChatStream(
  body: ReadableStream<Uint8Array>,
  handlers: ChatHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let ended = false
  const finish = (error?: AiErrorInfo): void => {
    if (ended) return
    ended = true
    if (error) handlers.onEvent({ type: 'end', error })
    else handlers.onEvent({ type: 'end' })
  }

  handlers.onEvent({ type: 'start' })
  try {
    while (true) {
      const { done, value } = await readServerChunk(reader, signal)
      if (done) {
        // 无换行结尾的残行也要补解析一次：服务端最后一个 message/end 事件不能丢。
        if (buffer.trim() !== '') {
          const trailing = parseServerEvent(buffer)
          if (trailing) {
            handlers.onEvent(trailing)
            if (trailing.type === 'end') return
          }
        }
        finish()
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const event = parseServerEvent(line)
        if (!event || event.type === 'start') continue // start 已由本适配器 emit，重复行跳过
        handlers.onEvent(event)
        if (event.type === 'end') return // 服务端已收束
      }
    }
  } catch (error) {
    // 传输中断（含外部中止）：自行以 end{error} 收束，消费方不悬挂。
    finish(errorInfoFrom(error))
  } finally {
    reader.cancel().catch(() => {
      // 连接已断开或已读完时 cancel 会失败，忽略即可。
    })
  }
}

export function createServerBackend(settings: AiSettings): AiCapabilities {
  const baseUrl = settings.serverBaseUrl.trim().replace(/\/+$/, '')
  const token = settings.serverToken.trim()

  function serverUrl(path: string): string {
    return `${baseUrl}/${path}`
  }

  function ensureReady(): void {
    if (!baseUrl) throw new AiError('config', '还没配置服务器端点，先去设置页填写')
  }

  function headers(withContentType = true): Record<string, string> {
    const result: Record<string, string> = {}
    if (withContentType) result['Content-Type'] = 'application/json'
    if (token) result.Authorization = `Bearer ${token}`
    return result
  }

  async function postJson(path: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    ensureReady()
    let response: Response
    try {
      response = await fetch(serverUrl(path), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(payload),
        signal,
      })
    } catch (cause) {
      throw mapNetworkError(cause)
    }
    if (!response.ok) throw mapResponseError(response)
    try {
      return await response.json()
    } catch (cause) {
      throw new AiError('parse', '服务器响应不是合法 JSON', { cause })
    }
  }

  return {
    async detectAds(input: DetectAdsInput): Promise<DetectAdsResult> {
      const data = await postJson(
        AI_PATHS.detectAds,
        {
          video: input.video,
          subtitles: input.subtitles,
          danmaku: input.danmaku,
          comments: input.comments,
          strategy: input.strategy,
        },
        input.signal,
      )
      return parseDetectAdsResult(data)
    },

    async summarize(input: SummarizeInput): Promise<SummarizeResult> {
      const data = await postJson(
        AI_PATHS.summarize,
        {
          video: input.video,
          subtitles: input.subtitles,
          danmaku: input.danmaku,
          comments: [],
        },
        input.signal,
      )
      return parseSummarizeResult(data)
    },

    async chat(input: ChatInput, handlers): Promise<void> {
      ensureReady()
      let response: Response
      try {
        response = await fetch(serverUrl(AI_PATHS.chat), {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ messages: input.messages, context: input.context }),
          signal: input.signal,
        })
      } catch (cause) {
        // 流尚未开始：直接 reject，auto 模式据此回退 local。
        throw mapNetworkError(cause)
      }
      if (!response.ok) throw mapResponseError(response)
      const body = response.body
      if (!body) throw new AiError('parse', '服务器没有返回 SSE 流')
      await relayChatStream(body, handlers, input.signal)
    },
  }
}