// AI 面板的纯逻辑单点：分段时间线 × 广告区间合并打标、〔字幕/弹幕〕溯源解析（秒数提取）、
// 多轮消息裁剪（上限 20 保留上下文首条）、AiError kind → 面板文案映射。
// 全部纯函数、不碰 DOM 与 chrome API，可单测；SummaryTab/ChatTab 只消费这里的结果。

import { buildChatMessages, formatTimecode } from './prompts'
import type { AdSegment, AiContext, ChatMessage, SummarySegment } from './port'
import type { AiErrorInfo } from '../shared/error'

// ---------- 分段时间线 × 广告区间合并 ----------

/** 分段时间线条目：按 start 排序；isAd 由与广告区间的重叠判定。 */
export interface PanelSegment {
  start: number
  end: number
  label: string
  isAd: boolean
}

/** 区间重叠判定：分段与广告区间有任何交叠即算落入广告区间（含广告完全处于段内）。 */
export function overlapsAd(start: number, end: number, ad: Pick<AdSegment, 'start' | 'end'>): boolean {
  return start < ad.end && end > ad.start
}

/** 总结 segments × 去广告 ads 合并：重叠分段标 isAd；无 ads 时返回纯分段（按时序）。 */
export function mergeSegmentsWithAds(
  segments: SummarySegment[],
  ads: AdSegment[],
): PanelSegment[] {
  return segments
    .map((segment) => ({
      ...segment,
      isAd: ads.some((ad) => overlapsAd(segment.start, segment.end, ad)),
    }))
    .sort((a, b) => a.start - b.start)
}

// ---------- 时间格式化（面板内自足，不依赖 content 层） ----------

/** UI 层时间格式化：秒 → HH:MM:SS（端口内时间一律秒，只有 UI 层才格式化）。 */
export function formatPanelTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds)) return '00:00:00'
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  return [hours, minutes, rest].map((part) => String(part).padStart(2, '0')).join(':')
}

/** 广告段标题区间提示（EXPERIENCE：广告段标题含区间提示）：无「至」字时补「（至 HH:MM:SS）」。 */
export function adSegmentLabel(label: string, end: number): string {
  return label.includes('至') ? label : `${label}（至 ${formatPanelTimestamp(end)}）`
}

// ---------- 溯源标注解析 ----------

export type CitationKind = 'subtitle' | 'danmaku'

export interface Citation {
  kind: CitationKind
  /** 跳播目标秒数。 */
  seconds: number
  /** chip 展示文案（字幕 mm:ss / 弹幕 123s）。 */
  label: string
}

/** 回答内容切分产物：markdown 段与可点击溯源 chip 交替。 */
export type AnswerPart =
  | { type: 'markdown'; markdown: string }
  | { type: 'citation'; citation: Citation }

// 〔〕全角括号为准的溯源记法；⧸ 之后是引用行自身的起止范围（跳播取引用点的首个时间码）。
const CITATION_PATTERN = /〔\s*(字幕|弹幕)\s*([^〕]*?)\s*〕/g

const MMTIME_PATTERN = /^(\d{1,2}):(\d{2})/
const SECONDS_PATTERN = /^(\d+(?:\.\d+)?)s?/

/** 解析单条溯源记法内容（不含全角括号）；无法取出秒数返回 null（回退为普通文字）。 */
export function parseCitation(kindText: string, contentText: string): Citation | null {
  const content = contentText.split('⧸')[0] ?? contentText
  if (kindText === '字幕') {
    const match = MMTIME_PATTERN.exec(content)
    if (!match) return null
    const minutes = Number(match[1])
    const seconds = Number(match[2])
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || seconds > 59) return null
    const total = minutes * 60 + seconds
    return { kind: 'subtitle', seconds: total, label: `字幕 ${formatTimecode(total)}` }
  }
  if (kindText === '弹幕') {
    const match = SECONDS_PATTERN.exec(content)
    if (!match) return null
    const value = Number(match[1])
    if (!Number.isFinite(value) || value < 0) return null
    return { kind: 'danmaku', seconds: value, label: `弹幕 ${value}s` }
  }
  return null
}

/** 把回答 Markdown 按溯源记法切成 markdown 段与 citation 交替序列；无效记法保持原文走 markdown。 */
export function splitCitations(markdown: string): AnswerPart[] {
  const parts: AnswerPart[] = []
  let lastIndex = 0

  // 相邻 markdown 段合并，避免无效记法把一段文字切得稀碎。
  function pushMarkdown(text: string): void {
    if (text === '') return
    const last = parts[parts.length - 1]
    if (last && last.type === 'markdown') last.markdown += text
    else parts.push({ type: 'markdown', markdown: text })
  }

  for (const match of markdown.matchAll(CITATION_PATTERN)) {
    const index = match.index ?? 0
    const raw = match[0] ?? ''
    if (index > lastIndex) {
      pushMarkdown(markdown.slice(lastIndex, index))
    }
    const citation = parseCitation(match[1] ?? '', match[2] ?? '')
    if (citation) parts.push({ type: 'citation', citation })
    else pushMarkdown(raw)
    lastIndex = index + raw.length
  }
  if (lastIndex < markdown.length) {
    pushMarkdown(markdown.slice(lastIndex))
  }
  return parts
}

// ---------- 多轮消息裁剪 ----------

/** 多轮轮次上限：装配列表（含上下文首条）超过该数即裁剪最旧轮次。 */
export const CHAT_TURN_LIMIT = 20

/**
 * 从端口上下文装配「上下文首条」user 消息：复用 prompts.buildChatMessages 的装配口径，
 * 保证面板与能力层的上下文表述一致（后端随后仍会自行装配，面板只取这条做裁剪基准）。
 */
export function buildContextUserMessage(context: AiContext): ChatMessage {
  const assembled = buildChatMessages({ messages: [], context })
  const contextUser = assembled.find((message) => message.role === 'user')
  return { role: 'user', content: contextUser?.content ?? '' }
}

/**
 * 多轮消息裁剪：列表以「上下文首条 + 各轮 user/assistant」形态装配，
 * 超过 limit 条时裁剪最旧轮次、保留上下文首条（索引 0 永不被裁）。
 */
export function trimChatHistory(messages: ChatMessage[], limit = CHAT_TURN_LIMIT): ChatMessage[] {
  if (messages.length <= limit) return [...messages]
  if (limit <= 0) return []
  // limit===1：只保留上下文首条（索引 0 永不被裁），而非取末尾消息。
  if (limit === 1) return [messages[0]!]
  return [messages[0]!, ...messages.slice(messages.length - (limit - 1))]
}

// ---------- AiError kind → 面板文案（EXPERIENCE.md State Patterns 表） ----------

export interface PanelErrorCopy {
  /** 主文案（错误卡标题）。 */
  title: string
  /** 去向提示（错误卡副行）。 */
  hint: string
  /** 是否提供「去看看设置」入口（config 直跳选项，其余也给入口指向 AI 助手组）。 */
  withSettingsLink: boolean
}

/** 面板文案映射表。 */
const ERROR_COPY: Record<AiErrorInfo['kind'], Omit<PanelErrorCopy, 'withSettingsLink'>> = {
  network: {
    title: 'AI 掉线了，去看看端点设置？',
    hint: '查地址与网络；请求走系统代理——本地代理工具（如 Clash）需放行端点域名，或改用「服务器转发」绕过',
  },
  http: {
    title: '端点返回了错误，去设置里看看？',
    hint: '附状态码；5xx 建议稍后重试',
  },
  auth: {
    title: 'API Key 好像不对，去设置里核对一下？',
    hint: '检查 Key 及向量端点继承关系',
  },
  parse: {
    title: 'AI 的回答没看懂（格式不对），再试一次？',
    hint: '建议重试；原始回复可在设置页「诊断记录」里直接查看',
  },
  config: {
    title: '还没配置端点，先去设置页填一下？',
    hint: '直跳设置页 · AI 助手分组',
  },
}

/** AiError kind → 用户文案映射（文案基调 = 轻盈俏皮但给明确去向）。 */
export function panelErrorCopy(info: AiErrorInfo): PanelErrorCopy {
  const base = ERROR_COPY[info.kind]
  if (info.kind === 'http') {
    // 有状态码报状态码；没有（HTTP 200 + 业务错误体，如国内网关的 {code,message}）用 base 文案。
    if (typeof info.status !== 'number') return { ...base, withSettingsLink: true }
    return {
      title: `端点返回了 ${info.status}，去设置里看看？`,
      hint: info.status >= 500 ? '5xx 建议稍后重试' : base.hint,
      withSettingsLink: true,
    }
  }
  if (info.kind === 'parse' && info.message.trim() !== '') {
    // 解析失败的具体原因（推理模型只回思考过程 / 上游错误体…）就是最有用的那句：
    // 直接放进面板提示，别让用户只能去翻诊断控制台。
    return { ...base, hint: info.message, withSettingsLink: true }
  }
  return { ...base, withSettingsLink: true }
}

/** 生成完成相对时间：「总结完成于 X 秒前」的秒数（向下取整、负值归零）。 */
export function summaryAgoSeconds(doneAtMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - doneAtMs) / 1000))
}

// ---------- 流式自动滚底判定 ----------

/** 滚动近底容差（px）：距底该值内视为「在底部」。 */
export const SCROLL_STICK_TOLERANCE_PX = 24

/**
 * 流式回答自动滚底的近底判定：用户上滚（离开近底带）后暂停自动滚底，
 * 滚回底部（重新进入近底带）恢复。
 */
export function isNearBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  tolerance = SCROLL_STICK_TOLERANCE_PX,
): boolean {
  return scrollTop + clientHeight >= scrollHeight - tolerance
}