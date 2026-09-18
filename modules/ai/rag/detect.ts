// RAG 主体：召回（词表 BM25 + 向量语义 + 弹幕信号，RRF 融合去重）→ 小转大（命中窗口回取父级 ±40 秒上下文）→
// LLM 精确定界（只喂候选窗口、JSON 先解析后宽松、最终保留召回窗口）→ 片段合并/置信度归一。
//
// 省 token 的三条设计（去广告是高频功能，必须便宜）：
//   ① 上下文预算：候选窗口与评论有上限，窗口内弹幕经「信号优先 + 无偏采样」精选到常数级（MAX_SPAN_DANMAKU）；
//   ② 免 LLM 通道：词表命中 + 多条**不同**弹幕指认的窗口视为双源强一致，直接给高置信度成段、零对话调用；
//   ③ 不给白跑：召回零命中且弹幕/评论都没有广告线索时不做全文兜底（最贵的那条路），直接空结果收尾。
// 调用方（内容脚本）另有结果缓存与观看进度门槛，检测结果与 token 用量经 meta 回传做成本可观测。
//
// 对话端点是可选依赖：未配置（只配了向量端点）或调用失败时，走「极速匹配」——
// 命中窗口直接成段（窗口±边界、命中语料词作商品名、检索分映射保守置信度），零对话调用。
//
// 降级链（顺序）：①混合检索 RAG → ②/embeddings 不可用：纯词表召回续跑 + 向量故障一次性提示 →
// ③对话端点不可用（未配置/调用失败）：极速匹配（纯检索定界）+ 一次性提示 →
// ④纯词表召回无命中且字幕可用且对话可用且有弱信号：LLM 全文兜底 → ⑤无字幕/全部不可用：{ads:[], source:"none"}。
// 检索层对外永不抛错：唯一外抛是端点全未配置的 AiError(config)，内容脚本据此静默不弹 UI。

import { AiError } from '../../shared/error'
import type { AiSettings } from '../../settings'
import { resolveDetectEndpoint, resolveEmbeddingEndpoint } from '../../settings'
import { chatCompletion, isAbortError } from '../llm/client'
import type { ChatEndpoint } from '../llm/client'
import type { AdSegment, DetectAdsInput, DetectAdsResult, DetectMeta, TokenUsage } from '../port'
import {
  buildDetectBoundsMessages,
  buildDetectFulltextMessages,
  parseDetectAdResponse,
  sampleSubtitlesEvenly,
} from '../prompts'
import type { DetectCandidateSpan } from '../prompts'
import type { CorpusSignal } from './corpus'
import { AD_SIGNAL_CORPUS } from './corpus'
import { exactSignalMatches } from './bm25'
import type { LexicalRankedWindow } from './bm25'
import { rankWindowsByLexical } from './bm25'
import { chunkSubtitleWindows } from './vector'
import type { SubtitleWindow } from './vector'
import { rankWindowsByVector } from './vector'
import { effectiveCorpusDetailed, recordUserCorpusHits } from './user-corpus'
import { chunkDanmakuWindows, DANMAKU_AD_TERMS, danmakuDistinctHitCounts, rankWindowsByDanmaku } from './danmaku-signal'
import { rrfFuse } from './rrf'

export interface DetectHooks {
  /** 向量端点（/embeddings）不可用、退纯词表检索时回调；同一次检测最多触发一次。 */
  onVectorFallback?: () => void
  /** 对话端点不可用（未配置视为有意为之不提示；调用失败才触发），本次以极速匹配收尾。 */
  onRetrievalOnly?: () => void
}

/** 小转大：命中窗口两边回取的父级上下文秒数。 */
export const CONTEXT_PADDING_SECONDS = 40
/** 单次定界最多喂给模型的候选窗口数（合并后），控制上下文规模。 */
export const MAX_CANDIDATE_SPANS = 10
/** 片段合并的间隙容忍（秒）：间隙小于该值视为同一段广告。 */
export const MERGE_GAP_SECONDS = 2
/** 低于该时长的片段视为噪声丢弃。 */
export const MIN_AD_SECONDS = 2
/**
 * 单个候选窗口送 LLM 的弹幕上限：弹幕是旁证，几十条与上百条携带的信号一样，token 却差数倍。
 * 预算一半留给「信号弹幕」（含广告词/语料词），一半留给时间均匀采样（无偏，避免只喂广告弹幕把模型带偏）。
 */
export const MAX_SPAN_DANMAKU = 40
/** 单个候选窗口送 LLM 的字幕行上限（±40 秒窗口通常 50–60 行，上限只防超长视频爆量）。 */
export const MAX_SPAN_LINES = 200
/** 双源强一致所需的最少**去重文本**弹幕数：同句刷屏不算多人指认。 */
export const CONSENSUS_MIN_DANMAKU_HITS = 3
/** 双源强一致段的置信度：明确高于 0.7 自动跳过门槛（免 LLM 也能自动跳）。 */
export const CONSENSUS_CONFIDENCE = 0.75
/** 全文兜底前要求的弱信号下限（整片范围内的广告词弹幕条数）。 */
export const WEAK_SIGNAL_MIN_DANMAKU = 3

/**
 * 弹幕精选（省 token 的主力）：把窗口内弹幕压到常数级。
 * 信号优先（含元词/语料词，按权重降序、同文本去重）+ 无偏采样补齐，最后按时间排序——
 * 既保留「观众在喊恰饭」的强证据，也保留窗口的整体语气，避免喂偏。
 */
export function curateSpanDanmaku(
  items: readonly { time: number; text: string }[],
  corpus: readonly CorpusSignal[],
  limit: number = MAX_SPAN_DANMAKU,
): { time: number; text: string }[] {
  if (items.length <= limit) return [...items]
  const scoreOf = (text: string): number => {
    for (const signal of corpus) {
      if (signal.text.length >= 2 && text.includes(signal.text)) return signal.weight
    }
    return 0
  }
  const seen = new Set<string>()
  const signalPicks: { time: number; text: string; score: number }[] = []
  const neutral: { time: number; text: string }[] = []
  for (const item of items) {
    const key = item.text.trim()
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    const score = scoreOf(item.text)
    if (score > 0) signalPicks.push({ time: item.time, text: item.text, score })
    else neutral.push({ time: item.time, text: item.text })
  }
  signalPicks.sort((a, b) => b.score - a.score || a.time - b.time)
  const signalBudget = Math.min(signalPicks.length, Math.ceil(limit / 2))
  const picked: { time: number; text: string }[] = signalPicks
    .slice(0, signalBudget)
    .map((item) => ({ time: item.time, text: item.text }))
  const remaining = limit - picked.length
  if (remaining > 0 && neutral.length > 0) {
    // 均匀采样：跨窗口取点，头中尾都留样本。
    const step = neutral.length / Math.min(remaining, neutral.length)
    for (let i = 0; i < remaining; i += 1) {
      const index = Math.min(neutral.length - 1, Math.floor(i * step))
      const item = neutral[index]
      if (item) picked.push(item)
      if (picked.length >= limit) break
    }
  }
  // 信号弹幕不止预算内那些时，用剩余预算继续补信号（优先证据），再排序。
  if (picked.length < limit) {
    for (const item of signalPicks.slice(signalBudget)) {
      if (picked.length >= limit) break
      picked.push({ time: item.time, text: item.text })
    }
  }
  picked.sort((a, b) => a.time - b.time)
  return picked
}

/**
 * 弱信号判定（全文兜底的闸门）：整片范围内有广告词/语料词的弹幕，或顶部评论提到广告。
 * 没有任何线索的视频不该花全文定界的 token——召回零命中且无弱信号时直接空结果收尾。
 * 元词表（观众黑话「广告/恰饭」）与语料词都算：观众喊「广告」本身就是最直接的线索。
 */
export function hasWeakSignal(
  danmaku: readonly { time: number; text: string }[],
  comments: readonly { top?: { text?: string } }[],
  corpus: readonly CorpusSignal[],
  minDanmaku: number = WEAK_SIGNAL_MIN_DANMAKU,
): boolean {
  const termHit = (text: string): boolean => {
    for (const term of DANMAKU_AD_TERMS) {
      if (text.includes(term)) return true
    }
    for (const signal of corpus) {
      if (signal.text.length >= 2 && text.includes(signal.text)) return true
    }
    return false
  }
  let hits = 0
  for (const item of danmaku) {
    if (termHit(item.text)) {
      hits += 1
      if (hits >= minDanmaku) return true
    }
  }
  for (const comment of comments) {
    const text = comment.top?.text
    if (typeof text === 'string' && termHit(text)) return true
  }
  return false
}

/** 候选窗口的父级时间范围（±40 秒，钳制在视频时长内）。 */
export function parentSpan(
  window: { start: number; end: number },
  duration: number,
  padding: number = CONTEXT_PADDING_SECONDS,
): { start: number; end: number } {
  return {
    start: Math.max(0, window.start - padding),
    end: duration > 0 ? Math.min(duration, window.end + padding) : window.end + padding,
  }
}

/**
 * 片段合并/归一：按 start 排序，非法段（起止颠倒/起点出界）丢弃，间隙小于 MERGE_GAP_SECONDS
 * 的相邻段合并，end 钳制到视频时长、confidence 取最大值、文案取首个非空。
 */
export function mergeAdSegments(ads: AdSegment[], duration: number): AdSegment[] {
  const valid = ads
    .filter((ad) => Number.isFinite(ad.start) && Number.isFinite(ad.end) && ad.end > ad.start)
    .filter((ad) => duration <= 0 || ad.start < duration)
    .map((ad) => ({
      start: Math.max(0, ad.start),
      end: duration > 0 ? Math.min(duration, ad.end) : ad.end,
      product_name: String(ad.product_name ?? ''),
      ad_content: String(ad.ad_content ?? ''),
      confidence: Math.min(1, Math.max(0, Number.isFinite(ad.confidence) ? ad.confidence : 0.5)),
    }))
    .filter((ad) => ad.end - ad.start >= MIN_AD_SECONDS)
    .sort((a, b) => a.start - b.start)

  const merged: AdSegment[] = []
  for (const ad of valid) {
    const last = merged[merged.length - 1]
    if (last && ad.start <= last.end + MERGE_GAP_SECONDS) {
      last.end = Math.max(last.end, ad.end)
      last.confidence = Math.max(last.confidence, ad.confidence)
      if (last.product_name === '' && ad.product_name !== '') last.product_name = ad.product_name
      if (ad.ad_content !== '') {
        last.ad_content = last.ad_content === '' ? ad.ad_content : `${last.ad_content}；${ad.ad_content}`
      }
    } else {
      merged.push({ ...ad })
    }
  }
  return merged
}

/** 极速匹配兜底段的长度上限（秒）：合并后仍长于此的整段丢弃。 */
export const FALLBACK_MAX_SEGMENT_SECONDS = 120

/**
 * 兜底段限长：纯检索没有定界能力，刷屏词（如整场直播切片里满屏「带货」）会让
 * 相邻命中窗口合并出横跨大半视频的巨段——这种段当广告标记/跳过都是灾难，宁可不要。
 */
function capFallbackAds(ads: AdSegment[]): AdSegment[] {
  return ads.filter((ad) => ad.end - ad.start <= FALLBACK_MAX_SEGMENT_SECONDS)
}

/**
 * 召回窗口兜底成片段（极速匹配：LLM 未配置/不可用/输出不可解析时）：
 * 融合分映射保守置信度（封顶 0.6，明确低于 LLM 定界的可信度）；
 * product_name 取窗口内精确命中的语料短语（品牌/话术词本身就是商品线索）。
 */
function windowsAsFallbackAds(
  windows: SubtitleWindow[],
  ranked: { index: number; score: number }[],
  duration: number,
  corpus: readonly CorpusSignal[] = AD_SIGNAL_CORPUS,
): AdSegment[] {
  return ranked
    .map(({ index, score }) => {
      const window = windows[index]
      const text = window?.text ?? ''
      const hits = Array.from(exactSignalMatches(text, corpus)).slice(0, 3)
      return {
        start: window?.start ?? 0,
        end: window?.end ?? 0,
        product_name: hits.join('、'),
        ad_content: text.slice(0, 200),
        confidence: Math.min(0.6, Math.max(0.3, 0.3 + score * 6)),
      }
    })
    .filter((ad) => ad.end > ad.start)
    .map((ad) => ({ ...ad, end: duration > 0 ? Math.min(duration, ad.end) : ad.end }))
    .filter((ad) => ad.end > ad.start)
}

/** 小转大：候选窗口合并父级 ±40 秒上下文；弹幕（窗口内，精选到常数级）与顶部评论文本并入旁证。 */
function buildCandidateSpans(
  windows: SubtitleWindow[],
  ranked: RrfRankedWindowSorted[],
  input: DetectAdsInput,
  duration: number,
  corpus: readonly CorpusSignal[] = AD_SIGNAL_CORPUS,
): DetectCandidateSpan[] {
  const selected = ranked.slice(0, MAX_CANDIDATE_SPANS)
  const spans: DetectCandidateSpan[] = []
  for (const { index } of selected) {
    const window = windows[index]
    if (!window) continue
    const range = parentSpan(window, duration)
    // 字幕行限长（防超长视频爆量）；弹幕精选（信号优先 + 无偏采样）——两处都是 token 预算闸门。
    const lines = sampleSubtitlesEvenly(
      input.subtitles
        .filter((line) => line.start >= range.start && line.start < range.end)
        .map((line) => ({ start: line.start, text: line.text })),
      MAX_SPAN_LINES,
    )
    const danmaku = curateSpanDanmaku(
      input.danmaku.filter((item) => item.time >= range.start && item.time < range.end),
      corpus,
    )
    spans.push({ start: range.start, end: range.end, lines, danmaku })
  }
  return spans
}

/** 顶部评论文本（限长）：threads 未结构化前一律不送 LLM，只送 top 文本。 */
function collectCommentTexts(input: DetectAdsInput, limit = 20): string[] {
  const texts: string[] = []
  for (const comment of input.comments) {
    const text = comment.top?.text?.trim()
    if (text) texts.push(text)
    if (texts.length >= limit) break
  }
  return texts
}

/** LLM 定界：只喂候选窗口；调用失败/输出不可解析都保留召回窗口兜底（极速匹配收尾 + 一次性提示）。 */
async function delimitWithLlm(
  input: DetectAdsInput,
  endpoint: ChatEndpoint,
  spans: DetectCandidateSpan[],
  fallbacks: AdSegment[],
  hooks: DetectHooks = {},
): Promise<{ ads: AdSegment[]; llmCalls: number; degraded?: boolean; usage?: TokenUsage }> {
  let raw: string
  let usage: TokenUsage | undefined
  try {
    const result = await chatCompletion({
      endpoint,
      messages: buildDetectBoundsMessages(input.video, spans, collectCommentTexts(input)),
      signal: input.signal,
    })
    raw = result.content
    usage = result.usage
  } catch (error) {
    if (isAbortError(error) || input.signal?.aborted) throw error
    hooks.onRetrievalOnly?.()
    return { ads: fallbacks, llmCalls: 1, degraded: true }
  }
  const ads = parseDetectAdResponse(raw, fallbacks, input.video.duration, () =>
    hooks.onRetrievalOnly?.(),
  )
  return { ads, llmCalls: 1, ...(usage === undefined ? {} : { usage }) }
}

/** ④全文兜底：字幕整段交模型找广告；定界不出片段即视为无广告（source none），解析失败同样收尾。 */
async function detectByFulltext(
  input: DetectAdsInput,
  endpoint: ChatEndpoint,
): Promise<DetectAdsResult> {
  try {
    const result = await chatCompletion({
      endpoint,
      messages: buildDetectFulltextMessages(input.video, input.subtitles),
      signal: input.signal,
    })
    const ads = parseDetectAdResponse(result.content, [], input.video.duration)
    return {
      ads: mergeAdSegments(ads, input.video.duration),
      source: ads.length > 0 ? 'llm' : 'none',
      meta: {
        path: 'fulltext',
        llmCalls: 1,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      },
    }
  } catch (error) {
    if (isAbortError(error) || input.signal?.aborted) throw error
    return { ads: [], source: 'none', meta: { path: 'fulltext', llmCalls: 1 } }
  }
}

type RrfRankedWindowSorted = { index: number; score: number }

/**
 * 全链路入口：端口 detectAds 的 local 实现，strategy 本阶段固定 smart（调用方传什么不影响路径）。
 * 端点未配置抛 AiError(config)；其余任何一环失败走降级链，永远返回可渲染结果。
 */
export async function runRagDetect(
  input: DetectAdsInput,
  settings: AiSettings,
  hooks: DetectHooks = {},
): Promise<DetectAdsResult> {
  // 去广告专用端点（默认继承对话端点）：定界是约束很强的结构化任务，可以交给更便宜的模型；
  // 总结/提问仍走对话端点。对话端点可选（极速匹配只需向量/词表检索）；两端点全未配置才是配置错误。
  const detect = resolveDetectEndpoint(settings)
  const chatReady = detect.baseUrl.trim() !== '' && detect.model.trim() !== ''
  const resolvedEmbed = resolveEmbeddingEndpoint(settings)
  const embedReady =
    resolvedEmbed.baseUrl.trim() !== '' && resolvedEmbed.model.trim() !== ''
  if (!chatReady && !embedReady) {
    throw new AiError('config', '还没配置端点，先去设置页填一下（对话端点或向量端点至少配一个）')
  }
  const endpoint: ChatEndpoint | null = chatReady
    ? {
        baseUrl: detect.baseUrl,
        model: detect.model,
        apiKey: detect.apiKey,
        format: detect.format,
      }
    : null
  const embedEndpoint: ChatEndpoint = {
    baseUrl: resolvedEmbed.baseUrl,
    model: resolvedEmbed.model,
    apiKey: resolvedEmbed.apiKey,
  }

  const { video, subtitles } = input
  const duration = video.duration
  // 字幕窗口优先；字幕缺失（无 ASR/未上传）时用弹幕自建窗口兜底——检测退而不亡。
  const subtitleWindows = chunkSubtitleWindows(subtitles)
  const windows = subtitleWindows.length > 0 ? subtitleWindows : chunkDanmakuWindows(input.danmaku ?? [])
  // 生效语料 = 内置词库 + 用户补录（一次读取，各路召回共用同一份，避免口径不一致）；
  // userTexts 标记用户来源，供命中统计区分（内置词条不计入）。
  const { signals: corpus, userTexts } = await effectiveCorpusDetailed()

  // 召回第一路：词表/BM25（纯计算，内部已防御，再兜一层保证永不抛错）。
  let lexicalRanked: LexicalRankedWindow[] = []
  try {
    lexicalRanked = rankWindowsByLexical(windows, corpus)
  } catch {
    lexicalRanked = []
  }

  // 召回第二路：向量语义；不可用退纯词表并触发一次性提示（同次检测最多一次）。
  let vectorRankedIndexes: number[] = []
  let vectorHintFired = false
  if (!input.signal?.aborted && windows.length > 0) {
    try {
      const ranked = await rankWindowsByVector(windows, video, embedEndpoint, input.signal, corpus)
      vectorRankedIndexes = ranked.map((item) => item.index)
    } catch (error) {
      if (isAbortError(error) || input.signal?.aborted) throw error
      vectorRankedIndexes = []
      if (!vectorHintFired) {
        vectorHintFired = true
        hooks.onVectorFallback?.()
      }
    }
  }

  // 召回第三路：弹幕信号（观众自发刷「广告/恰饭/跳过」，抗 ASR 噪声）；纯计算永不抛错。
  let danmakuRankedIndexes: number[] = []
  try {
    danmakuRankedIndexes = rankWindowsByDanmaku(windows, input.danmaku ?? [], corpus).map(
      (item) => item.index,
    )
  } catch {
    danmakuRankedIndexes = []
  }

  // 三路 RRF 融合出候选窗口。
  const fused = rrfFuse([
    lexicalRanked.map((item) => item.index),
    vectorRankedIndexes,
    danmakuRankedIndexes,
  ])

  // 用户补录词条命中统计（设置页展示「命中 N 次」）：只看融合命中窗口的文本，
  // 异步落库、失败静默——统计绝不能拖垮检测主链路。
  if (fused.length > 0) {
    const hitTexts = new Set<string>()
    const fusedIndexes = new Set(fused.map((item) => item.index))
    for (const window of windows) {
      if (!fusedIndexes.has(window.index)) continue
      for (const text of userTexts) {
        if (window.text.includes(text)) hitTexts.add(text)
      }
    }
    if (hitTexts.size > 0) void recordUserCorpusHits([...hitTexts])
  }

  // 双源强一致（免 LLM 通道）：每个候选窗口都被词表命中、且有多条**不同文本**的弹幕指认时，
  // 证据已足够强——直接给 0.75 置信度成段（高于 0.7 自动跳过门槛），零对话调用。
  // 同句刷屏不算多人指认（去重计数），单窗口孤证不算（必须逐窗强一致）。
  if (chatReady && fused.length > 0) {
    const lexicalIndexes = new Set(lexicalRanked.map((item) => item.index))
    let distinctDanmakuHits: number[] = []
    try {
      distinctDanmakuHits = danmakuDistinctHitCounts(windows, input.danmaku ?? [], corpus)
    } catch {
      distinctDanmakuHits = []
    }
    const consensus = fused.every(
      (item) =>
        lexicalIndexes.has(item.index) &&
        (distinctDanmakuHits[item.index] ?? 0) >= CONSENSUS_MIN_DANMAKU_HITS,
    )
    if (consensus) {
      const consensusAds = capFallbackAds(
        mergeAdSegments(
          windowsAsFallbackAds(windows, fused, duration, corpus).map((ad) => ({
            ...ad,
            confidence: CONSENSUS_CONFIDENCE,
          })),
          duration,
        ),
      )
      console.info(
        `[bili-helper] 去广告双源强一致：${fused.length} 个候选窗口均被词表命中且有多人弹幕指认，免 LLM 直接成段`,
      )
      return {
        ads: consensusAds,
        source: 'rag',
        meta: {
          path: 'consensus',
          llmCalls: 0,
          note: `${fused.length} 窗口双源一致`,
        },
      }
    }
  }

  if (fused.length === 0) {
    // ③无命中：先过弱信号闸门——弹幕/评论都没有任何广告线索的视频，不值得花全文定界的 token。
    const noneMeta: DetectMeta = { path: 'none', llmCalls: 0 }
    if (!chatReady) return { ads: [], source: 'none', meta: noneMeta }
    if (subtitles.length === 0) return { ads: [], source: 'none', meta: noneMeta }
    if (!hasWeakSignal(input.danmaku ?? [], input.comments, corpus)) {
      console.info('[bili-helper] 去广告：召回零命中且弹幕/评论均无广告线索，跳过全文兜底（0 token）')
      return {
        ads: [],
        source: 'none',
        meta: { ...noneMeta, note: '无弱信号，未做全文兜底' },
      }
    }
    return detectByFulltext(input, endpoint as ChatEndpoint)
  }

  const spans = buildCandidateSpans(windows, fused, input, duration, corpus)
  // 兜底段先合并再限长：极速匹配与 LLM 失败降级共用这一份，巨段噪声在源头掐掉。
  const fallbacks = capFallbackAds(
    mergeAdSegments(windowsAsFallbackAds(windows, fused, duration, corpus), duration),
  )
  // 极速匹配：对话端点未配置（只配向量）→ 命中窗口直接成段，零对话调用。
  if (!chatReady) {
    return {
      ads: mergeAdSegments(fallbacks, duration),
      source: 'rag',
      meta: { path: 'retrieval', llmCalls: 0, spans: spans.length },
    }
  }
  const delimited = await delimitWithLlm(input, endpoint as ChatEndpoint, spans, fallbacks, hooks)
  return {
    ads: mergeAdSegments(delimited.ads, duration),
    source: 'rag',
    meta: {
      // 对话调用失败降级成极速匹配时如实标注——成本与路径对得上账。
      path: delimited.degraded ? 'retrieval' : 'llm',
      llmCalls: delimited.llmCalls,
      spans: spans.length,
      ...(delimited.usage === undefined ? {} : { usage: delimited.usage }),
      ...(delimited.degraded ? { note: '对话调用失败，极速匹配收尾' } : {}),
    },
  }
}