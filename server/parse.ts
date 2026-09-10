// 服务端请求体解析：把扩展送来的原始 context 归一成端口契约形状（modules/ai/port）。
// 宽松原则：单条脏数据丢弃，而不是让整个请求 400——一条坏字幕不该毁掉整支视频的识别；
// 只有根形状不合法（不是对象、缺 video.bvid）才判 parse 错（handler 映射为 400）。

import { AiError } from '../modules/shared/error'
import type { AdStrategy, AiContext, ChatMessage } from '../modules/ai/port'
import type { Comment, Danmaku, Subtitle, VideoMeta } from '../modules/video/types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  // 字幕文件里时间偶见字符串（"12.5"），能转就转，转不动才落回默认值。
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (isRecord(value)) return value
  throw new AiError('parse', `${what}必须是 JSON 对象`)
}

export function parseVideoMeta(value: unknown): VideoMeta {
  const record = requireRecord(value, 'video')
  const bvid = asText(record.bvid).trim()
  if (bvid === '') throw new AiError('parse', 'video.bvid 不能为空')
  const cid =
    typeof record.cid === 'number' && Number.isFinite(record.cid) ? Math.trunc(record.cid) : undefined
  return {
    bvid,
    cid,
    title: asText(record.title),
    duration: Math.max(0, asFiniteNumber(record.duration, 0)),
  }
}

/** 字幕行：起止时间非法（end ≤ start）或文本为空的行直接丢弃。 */
export function parseSubtitles(value: unknown): Subtitle[] {
  if (!Array.isArray(value)) return []
  const subtitles: Subtitle[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const text = asText(item.text).trim()
    if (text === '') continue
    const start = Math.max(0, asFiniteNumber(item.start, -1))
    const end = Math.max(0, asFiniteNumber(item.end, -1))
    if (start < 0 || end <= start) continue
    subtitles.push({ start, end, text })
  }
  return subtitles
}

export function parseDanmaku(value: unknown): Danmaku[] {
  if (!Array.isArray(value)) return []
  const danmaku: Danmaku[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const text = asText(item.text).trim()
    if (text === '') continue
    const time = asFiniteNumber(item.time, -1)
    if (time < 0) continue
    danmaku.push({ time, text })
  }
  return danmaku
}

/** 评论：只取 top.text（threads 未结构化，服务端同样不猜）。 */
export function parseComments(value: unknown): Comment[] {
  if (!Array.isArray(value)) return []
  const comments: Comment[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const top = isRecord(item.top) ? asText(item.top.text).trim() : ''
    if (top === '') continue
    comments.push({ top: { text: top } })
  }
  return comments
}

/** 统一上下文：video 必填，其余三源缺失即空数组（与端上采集层的降级语义一致）。 */
export function parseContext(body: Record<string, unknown>): AiContext {
  return {
    video: parseVideoMeta(body.video),
    subtitles: parseSubtitles(body.subtitles),
    danmaku: parseDanmaku(body.danmaku),
    comments: parseComments(body.comments),
  }
}

export function parseStrategy(value: unknown): AdStrategy {
  return value === 'free' || value === 'always' ? value : 'smart'
}

/** 会话消息：只收 user/assistant 轮次，system 提示词由服务端 prompts 装配（不接受客户端注入）。 */
export function parseChatMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) throw new AiError('parse', 'messages 必须是数组')
  const messages: ChatMessage[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const role = item.role
    if (role !== 'user' && role !== 'assistant') continue
    const content = asText(item.content)
    if (content.trim() === '') continue
    messages.push({ role, content })
  }
  if (messages.length === 0) throw new AiError('parse', 'messages 里没有可处理的对话轮次')
  return messages
}
