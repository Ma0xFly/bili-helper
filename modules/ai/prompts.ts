// AI 提示词单一维护点：总结与提问的 system 提示词、视频上下文装配、JSON 输出解析全部集中于此。
// 措辞红线：只依据给定资料、禁止编造；资料不足明说；提问回答必须带溯源标注。
// 总结输出协议为 JSON 对象；解析遵循「先解析后退化」——JSON 不可用或形状不对时，
// 原始文本整体作为 summary、segments 为空，保证能力层永不因输出格式问题悬挂。

import type { AiContext } from './port'
import type { AdSegment, ChatInput, SummarizeInput, SummarizeResult, SummarySegment } from './port'
import type { OpenAiChatMessage } from './llm/client'

/** 时间码 mm:ss（提示词/溯源标注内部使用）；HH:MM:SS 只在 UI 层格式化。 */
export function formatTimecode(seconds: number): string {
  // NaN/Infinity 保护：坏时间戳不得产出「NaN:NaN」这类破文案。
  if (!Number.isFinite(seconds)) return '00:00'
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

// 输出协议在提示词里给模型展示一遍、解析时再校验一遍，两处共用同一条字符串避免漂移。
const SUMMARY_SCHEMA_TEXT = '{"summary": "Markdown 文本：先一句话总结，再列核心要点（- 列表）", "segments": [{"start": 0, "end": 0, "label": "分章标题"}]}'

const SUMMARY_SYSTEM_PROMPT = [
  '你是 B 站视频 AI 总结助手。你的任务是根据给定的视频资料（字幕、弹幕）产出一份精炼的中文总结。',
  '',
  '铁律：',
  '1. 只依据给定资料总结，严禁编造资料中不存在的内容；资料不足以支撑总结时，直接说明「资料不足」，并只总结已有内容。',
  '2. 时间一律以秒为单位，且只能取自资料中出现的时间戳；不确定的时间不要写。',
  '3. 字幕中若出现明显的商业推广（恰饭、带货、口播广告），在对应分段的 label 前标注「广告」二字。',
  '4. 不评价视频质量，不复述无关内容。',
  '',
  '输出协议：只输出一个 JSON 对象（不要 Markdown 代码块，不要任何其他文字），字段如下：',
  SUMMARY_SCHEMA_TEXT,
  '- summary 用中文 Markdown；segments 按视频内容自然分章，start/end 对齐字幕时间戳（秒），无法可靠分段时返回空数组 []。',
].join('\n')

const CHAT_SYSTEM_PROMPT = [
  '你是 B 站视频 AI 助手，回答用户关于这期视频的问题。',
  '',
  '铁律：',
  '1. 只依据下面提供的视频资料（字幕/弹幕/评论）回答，严禁编造资料中没有的信息，也不要用你自己的外部知识补充；资料不足以回答时，直接说明「资料不足，无法回答」。',
  '2. 引用资料原文必须带溯源标注，格式统一为：',
  '   - 字幕引用：〔字幕 mm:ss–mm:ss〕',
  '   - 弹幕引用：〔弹幕 123s〕（123s 为弹幕出现时刻，单位秒）',
  '   - 评论引用：〔评论〕',
  '3. 回答用中文 Markdown，简洁直接，先结论后细节；用户多轮追问时，每一轮都只依据资料。',
  '4. 不要输出道歉、免责声明之类的多余文字。',
].join('\n')

/** 把端口上下文渲染成提示词正文：标题 + 字幕（带时间码）+ 弹幕 + 评论。 */
export function renderAiContext(context: AiContext): string {
  const parts: string[] = []
  const title = context.video.title.trim()
  const heading = title ? `视频「${title}」（BV 号 ${context.video.bvid}）` : `视频 BV 号 ${context.video.bvid}`
  parts.push(heading)
  if (context.subtitles.length > 0) {
    const lines = context.subtitles
      .map((subtitle) => `[${formatTimecode(subtitle.start)}] ${subtitle.text}`)
      .join('\n')
    parts.push(`字幕：\n${lines}`)
  }
  if (context.danmaku.length > 0) {
    const lines = context.danmaku.map((danmaku) => `[${danmaku.time}s] ${danmaku.text}`).join('\n')
    parts.push(`弹幕（方括号内为出现时刻，单位秒）：\n${lines}`)
  }
  if (context.comments.length > 0) {
    const commentLines: string[] = []
    for (const comment of context.comments) {
      const text = comment.top?.text?.trim()
      if (text) commentLines.push(`- ${text}`)
    }
    if (commentLines.length > 0) parts.push(`评论：\n${commentLines.join('\n')}`)
  }
  return parts.join('\n\n')
}

export function buildSummaryMessages(input: SummarizeInput): OpenAiChatMessage[] {
  const context = renderAiContext({
    video: input.video,
    subtitles: input.subtitles,
    danmaku: input.danmaku,
    comments: [],
  })
  const user = context === ''
    ? '请根据给定视频资料输出 JSON 总结。'
    : `${context}\n\n请根据以上资料按输出协议输出 JSON 总结。`
  return [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ]
}

export function buildChatMessages(input: ChatInput): OpenAiChatMessage[] {
  const contextText = renderAiContext(input.context)
  // 上下文单独作为一条 user 消息装载：多轮追问时资料仍在最前，回答约束不被后续轮次稀释。
  const contextMessage =
    contextText === ''
      ? '（本期视频没有可用的字幕/弹幕/评论资料，回答时请注明资料不足）'
      : `以下是本期视频的资料，你的回答只能依据这些资料：\n\n${contextText}`
  const messages: OpenAiChatMessage[] = [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
    { role: 'user', content: contextMessage },
  ]
  for (const message of input.messages) {
    messages.push({ role: message.role, content: message.content })
  }
  return messages
}

// 从模型输出中尽力挖出 JSON：先整段解析，再剥 ```json 围栏，最后取首尾花括号截取。
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return null
  try {
    return JSON.parse(trimmed)
  } catch {
    // 继续走退化路径。
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced && fenced[1] !== undefined) {
    try {
      return JSON.parse(fenced[1].trim())
    } catch {
      // 继续走退化路径。
    }
  }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      // 返回 null 走整体退化。
    }
  }
  return null
}

/** 总结输出「先解析后退化」：JSON 形状完整取其结构，否则原文整体作为 summary。 */
export function parseSummarizeResponse(raw: string): SummarizeResult {
  const parsed = extractJson(raw)
  const candidate =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  const summary =
    candidate && typeof candidate.summary === 'string' && candidate.summary.trim() !== ''
      ? candidate.summary
      : null
  const rawSegments = candidate && Array.isArray(candidate.segments) ? candidate.segments : null
  if (summary === null || rawSegments === null) {
    return { summary: raw.trim(), segments: [] }
  }
  const segments: SummarySegment[] = []
  for (const item of rawSegments) {
    if (typeof item !== 'object' || item === null) continue
    const segment = item as Record<string, unknown>
    const start = typeof segment.start === 'number' ? segment.start : NaN
    const end = typeof segment.end === 'number' ? segment.end : NaN
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    if (typeof segment.label !== 'string' || segment.label.trim() === '') continue
    segments.push({ start, end, label: segment.label })
  }
  return { summary, segments }
}

// ---------- 去广告定界提示词与解析 ----------

/** 定界输出协议：system 提示词与解析层共用同一条 schema 文案，避免两处漂移。 */
const DETECT_SCHEMA_TEXT =
  '{"ads": [{"start": 0, "end": 0, "product_name": "产品/品牌名", "ad_content": "一句话概括广告内容", "confidence": 0.5}]}'

/** Stage 2 定界 system：只依据给定窗口与信号判断；无可辨认返回空数组。 */
const DETECT_BOUNDS_SYSTEM_PROMPT = [
  '你是 B 站视频「恰饭广告」定界助手。给定若干候选窗口（含字幕行与时间码），你的任务是对商业推广片段做精确定界。',
  '',
  '铁律：',
  '1. 只依据给定窗口内的字幕内容与信号词判断，严禁编造窗口外的时间与内容。',
  '2. 时间一律以秒为单位；start/end 只能落在给定资料覆盖的时间范围内，且 start < end。',
  '3. 只有明显在推广/带货/介绍特定产品、含感谢赞助/优惠/购买引导等信号的内容才算广告；普通提及品牌（客观对比、评测语境）不要标。',
  '4. product_name 填推广的产品/品牌名，取不到就写空字符串；ad_content 用一句话概括（不超过 40 字）。',
  '5. confidence 是 0 到 1 的把握度，只在内容确实像广告时才大于 0.5。',
  '6. 弹幕与评论只作旁证，时间定位一律以字幕时间码为准。',
  '',
  '输出协议：只输出一个 JSON 对象（不要 Markdown 代码块，不要任何其他文字），字段如下：',
  DETECT_SCHEMA_TEXT,
  '- 没有任何可辨认的广告时返回：{"ads": []}。',
].join('\n')

/** 兜底全文 system：字幕整段交模型找广告；输出协议与定界一致。 */
const DETECT_FULLTEXT_SYSTEM_PROMPT = [
  '你是 B 站视频「恰饭广告」识别助手。给定视频完整字幕（含时间码），找出其中的商业推广片段并给出精确起止时间。',
  '',
  '铁律：',
  '1. 只依据给定字幕判断，严禁编造字幕中不存在的内容。',
  '2. 时间一律以秒为单位；start/end 只能取自字幕中出现的时间戳，且 start < end。',
  '3. 只有明显在推广/带货/介绍特定产品、含感谢赞助/优惠/购买引导等信号的内容才算广告；普通提及品牌（客观对比、评测语境）不要标。',
  '4. product_name 填推广的产品/品牌名，取不到就写空字符串；ad_content 用一句话概括（不超过 40 字）。',
  '5. confidence 是 0 到 1 的把握度，只在内容确实像广告时才大于 0.5。',
  '',
  '输出协议：只输出一个 JSON 对象（不要 Markdown 代码块，不要任何其他文字），字段如下：',
  DETECT_SCHEMA_TEXT,
  '- 没有任何可辨认的广告时返回：{"ads": []}。',
].join('\n')

/** 候选窗口（含父级上下文）在提示词里的行形状；弹幕为窗口范围内的旁证。 */
export interface DetectCandidateSpan {
  start: number
  end: number
  lines: { start: number; text: string }[]
  danmaku: { time: number; text: string }[]
}

function renderDetectHeading(video: AiContext['video']): string {
  const title = video.title.trim()
  return title ? `视频「${title}」（BV 号 ${video.bvid}）` : `视频 BV 号 ${video.bvid}`
}

/** Stage 2 定界消息：标题 + 候选窗口（字幕行 + 窗口内弹幕旁证）+ 顶部评论旁证。 */
export function buildDetectBoundsMessages(
  video: AiContext['video'],
  spans: DetectCandidateSpan[],
  commentTexts: string[] = [],
): OpenAiChatMessage[] {
  const windowBlocks = spans.map((span, index) => {
    const lines = span.lines
      .map((line) => `[${formatTimecode(line.start)}] ${line.text}`)
      .join('\n')
    const danmaku = span.danmaku.length > 0
      ? `\n弹幕（旁证）：\n${span.danmaku.map((item) => `[${Math.round(item.time)}s] ${item.text}`).join('\n')}`
      : ''
    return `候选窗口 ${index + 1}（${formatTimecode(span.start)}–${formatTimecode(span.end)}）：\n${lines}${danmaku}`
  })
  const comments = commentTexts.length > 0
    ? `\n\n顶部评论（旁证）：\n${commentTexts.map((text) => `- ${text}`).join('\n')}`
    : ''
  const user = `${renderDetectHeading(video)}\n\n候选窗口如下，请只在这些窗口内做广告定界：\n\n${windowBlocks.join('\n\n')}${comments}`
  return [
    { role: 'system', content: DETECT_BOUNDS_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ]
}

/** 均匀采样：跨全片取 ≤ maxLines 行（覆盖头中尾），避免前段截断漏掉后半段广告。 */
export function sampleSubtitlesEvenly(
  lines: { start: number; text: string }[],
  maxLines: number,
): { start: number; text: string }[] {
  if (lines.length <= maxLines) return lines
  const sampled: { start: number; text: string }[] = []
  for (let index = 0; index < maxLines; index += 1) {
    const sourceIndex = Math.floor((index * lines.length) / maxLines)
    const line = lines[sourceIndex]
    if (line) sampled.push(line)
  }
  return sampled
}

/** 兜底全文消息：完整字幕经均匀采样（限长）整段交模型找广告。 */
export function buildDetectFulltextMessages(
  video: AiContext['video'],
  subtitles: { start: number; text: string }[],
  maxLines = 600,
): OpenAiChatMessage[] {
  const lines = sampleSubtitlesEvenly(subtitles, maxLines)
    .map((line) => `[${formatTimecode(line.start)}] ${line.text}`)
    .join('\n')
  const user = `${renderDetectHeading(video)}\n\n完整字幕如下（头中尾均匀取样），请找出其中的恰饭广告片段：\n\n${lines}`
  return [
    { role: 'system', content: DETECT_FULLTEXT_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ]
}

/** 松限定界解析：从非 JSON 的模型输出里挖 mm:ss–mm:ss 或 start/end 数字对。 */
export function looseParseAdBounds(raw: string, maxEnd: number): AdSegment[] {
  const ads: AdSegment[] = []
  const mmss = /\b(\d{1,2}):(\d{2})\s*[–—~～-]\s*(\d{1,2}):(\d{2})\b/g
  for (const match of raw.matchAll(mmss)) {
    const m1 = Number(match[1])
    const s1 = Number(match[2])
    const m2 = Number(match[3])
    const s2 = Number(match[4])
    if (![m1, s1, m2, s2].every(Number.isFinite) || s1 > 59 || s2 > 59) continue
    const start = m1 * 60 + s1
    const end = m2 * 60 + s2
    if (!(end > start) || (maxEnd > 0 && start > maxEnd)) continue
    ads.push({ start, end, product_name: '', ad_content: '', confidence: 0.45 })
  }
  if (ads.length > 0) return ads
  const fieldPairs = /\bstart\s*[:=]?\s*(\d+(?:\.\d+)?)\D{0,24}end\s*[:=]?\s*(\d+(?:\.\d+)?)\b/gi
  for (const match of raw.matchAll(fieldPairs)) {
    const start = Number(match[1])
    const end = Number(match[2])
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) continue
    if (maxEnd > 0 && start > maxEnd) continue
    ads.push({ start, end, product_name: '', ad_content: '', confidence: 0.45 })
  }
  return ads
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 数字强转：接受数字与数字字符串（模型偶发 "start":"492"），无效返回 NaN。 */
function finiteNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : NaN
  }
  return NaN
}

/**
 * 定界输出「先 JSON 后宽松后保留召回窗口」：JSON 形状完整取其结构（字段先数字强转），
 * 否则宽松文本解析时间对；再不行退回召回窗口（降级链保证永远拿到可渲染结果）。
 */
export function parseDetectAdResponse(raw: string, fallbacks: AdSegment[], maxEnd: number): AdSegment[] {
  const parsed = extractJson(raw)
  const root = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  if (root && Array.isArray(root.ads)) {
    const ads: AdSegment[] = []
    for (const item of root.ads) {
      if (typeof item !== 'object' || item === null) continue
      const entry = item as Record<string, unknown>
      const start = finiteNumber(entry.start)
      const end = finiteNumber(entry.end)
      if (!(end > start)) continue
      if (maxEnd > 0 && start > maxEnd) continue
      const confidence = finiteNumber(entry.confidence)
      ads.push({
        start,
        end,
        product_name: typeof entry.product_name === 'string' ? entry.product_name : '',
        ad_content: typeof entry.ad_content === 'string' ? entry.ad_content : '',
        confidence: clamp(Number.isFinite(confidence) ? confidence : 0.5, 0, 1),
      })
    }
    if (ads.length > 0) return ads
    // JSON 整齐但明确回答「无广告」：尊重模型的 empt 判定，不再拿召回窗口硬凑。
    if (raw.trim() !== '') return []
  }
  const loose = looseParseAdBounds(raw, maxEnd)
  if (loose.length > 0) return loose
  return fallbacks.map((ad) => ({ ...ad }))
}