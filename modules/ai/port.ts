// AI 能力端口契约：调用方（设置页、内容脚本）只依赖这里的三个方法与锁定形状，
// 后端选择永远经 resolveBackend（modules/ai/backend/resolve），UI 不感知当前后端。
// 时间一律「秒（number）」；一切失败抛 AiError；chat 走 SSE 三事件且必须以 end 收尾。

import type { AiErrorInfo } from '../shared/error'
import type { Comment, Danmaku, Subtitle, VideoMeta } from '../video/types'

/** 端口的统一上下文形状：采集层归一到此，适配器不得各自重新解析原始字段。 */
export interface AiContext {
  video: VideoMeta
  subtitles: Subtitle[]
  danmaku: Danmaku[]
  comments: Comment[]
}

/** 去广告识别策略，与后端选择正交（后端分派由 settings.mode 决定）。 */
export type AdStrategy = 'free' | 'smart' | 'always'

export interface DetectAdsInput extends AiContext {
  strategy: AdStrategy
  signal?: AbortSignal
}

export interface AdSegment {
  /** 广告段起止时间，秒。 */
  start: number
  end: number
  product_name: string
  ad_content: string
  confidence: number
}

/** 结果来源标记（供缓存/调试），不是后端选择器。 */
export type AdSource = 'rag' | 'llm' | 'none'

/**
 * 检测走了哪条路（成本可观测的锚点）：
 * cache=命中结果缓存（0 token）｜consensus=词表+弹幕双源强一致（免 LLM）｜llm=LLM 定界（常规路径）
 * ｜fulltext=召回零命中后的全文兜底｜retrieval=极速匹配（对话端点未配置/不可用）｜none=无命中收尾。
 */
export type DetectPath = 'cache' | 'consensus' | 'llm' | 'fulltext' | 'retrieval' | 'none'

/** token 用量（端点未回 usage 时缺省）。 */
export interface TokenUsage {
  input: number
  output: number
}

export interface DetectMeta {
  path: DetectPath
  /** 本次检测实际发出的对话请求数（0 = 没花 token）。 */
  llmCalls: number
  usage?: TokenUsage
  /** 送 LLM 的候选窗口数（诊断用）。 */
  spans?: number
  /** 补充说明（如缓存命中的原始路径、双源一致的窗口数）。 */
  note?: string
}

export interface DetectAdsResult {
  ads: AdSegment[]
  source: AdSource
  meta?: DetectMeta
}

export interface SummarizeInput {
  video: VideoMeta
  subtitles: Subtitle[]
  danmaku: Danmaku[]
  signal?: AbortSignal
}

export interface SummarySegment {
  /** 分段起止时间，秒。 */
  start: number
  end: number
  label: string
}

export interface SummarizeResult {
  summary: string
  segments: SummarySegment[]
}

/** 端口的会话消息：调用方只送 user/assistant 轮次，system 提示词由适配器经 prompts 装配。 */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatInput {
  messages: ChatMessage[]
  context: AiContext
  signal?: AbortSignal
}

/** 能力层 SSE 只允许三事件；成功与错误/中止都必须以 end 收尾（错误载入 end.error）。 */
export type AiChatEvent =
  | { type: 'start' }
  | { type: 'message'; chunk: string }
  | { type: 'end'; error?: AiErrorInfo }

export interface ChatHandlers {
  onEvent: (event: AiChatEvent) => void
}

export interface AiCapabilities {
  detectAds(input: DetectAdsInput): Promise<DetectAdsResult>
  summarize(input: SummarizeInput): Promise<SummarizeResult>
  /** 返回的 Promise 在有事件流后总是 resolve（终止性由 end 事件承担）；流开始前的失败会 reject。 */
  chat(input: ChatInput, handlers: ChatHandlers): Promise<void>
}