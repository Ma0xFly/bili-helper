// RAG 主体：召回（词表 BM25 + 向量语义，RRF 融合去重）→ 小转大（命中窗口回取父级 ±40 秒上下文）→
// LLM 精确定界（只喂候选窗口、JSON 先解析后宽松、最终保留召回窗口）→ 片段合并/置信度归一。
//
// 降级链（顺序）：①混合检索 RAG → ②/embeddings 不可用：纯词表召回续跑 + 向量故障一次性提示 →
// ③纯词表召回无命中且字幕可用：LLM 全文兜底 → ④无字幕/全部不可用：{ads:[], source:"none"}。
// 检索层对外永不抛错：唯一外抛是端点未配置的 AiError(config)，内容脚本据此静默不弹 UI。

import { AiError } from '../../shared/error'
import type { AiSettings } from '../../settings'
import { resolveEmbeddingEndpoint } from '../../settings'
import { chatCompletion, isAbortError } from '../llm/client'
import type { ChatEndpoint } from '../llm/client'
import type { AdSegment, DetectAdsInput, DetectAdsResult } from '../port'
import { buildDetectBoundsMessages, buildDetectFulltextMessages, parseDetectAdResponse } from '../prompts'
import type { DetectCandidateSpan } from '../prompts'
import type { LexicalRankedWindow } from './bm25'
import { rankWindowsByLexical } from './bm25'
import { chunkSubtitleWindows } from './vector'
import type { SubtitleWindow } from './vector'
import { rankWindowsByVector } from './vector'
import { effectiveCorpus } from './user-corpus'
import { rrfFuse } from './rrf'

export interface DetectHooks {
  /** 向量端点（/embeddings）不可用、退纯词表检索时回调；同一次检测最多触发一次。 */
  onVectorFallback?: () => void
}

/** 小转大：命中窗口两边回取的父级上下文秒数。 */
export const CONTEXT_PADDING_SECONDS = 40
/** 单次定界最多喂给模型的候选窗口数（合并后），控制上下文规模。 */
export const MAX_CANDIDATE_SPANS = 10
/** 片段合并的间隙容忍（秒）：间隙小于该值视为同一段广告。 */
export const MERGE_GAP_SECONDS = 2
/** 低于该时长的片段视为噪声丢弃。 */
export const MIN_AD_SECONDS = 2

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

/** 召回窗口兜底成片段（LLM 不可用/输出不可解析时）：融合分映射保守置信度。 */
function windowsAsFallbackAds(
  windows: SubtitleWindow[],
  ranked: { index: number; score: number }[],
  duration: number,
): AdSegment[] {
  return ranked
    .map(({ index, score }) => {
      const window = windows[index]
      return {
        start: window?.start ?? 0,
        end: window?.end ?? 0,
        product_name: '',
        ad_content: window ? window.text.slice(0, 200) : '',
        confidence: Math.min(0.6, Math.max(0.3, 0.3 + score * 6)),
      }
    })
    .filter((ad) => ad.end > ad.start)
    .map((ad) => ({ ...ad, end: duration > 0 ? Math.min(duration, ad.end) : ad.end }))
    .filter((ad) => ad.end > ad.start)
}

/** 小转大：候选窗口合并父级 ±40 秒上下文；弹幕（窗口时间范围内）与顶部评论文本并入旁证。 */
function buildCandidateSpans(
  windows: SubtitleWindow[],
  ranked: RrfRankedWindowSorted[],
  input: DetectAdsInput,
  duration: number,
): DetectCandidateSpan[] {
  const selected = ranked.slice(0, MAX_CANDIDATE_SPANS)
  const spans: DetectCandidateSpan[] = []
  for (const { index } of selected) {
    const window = windows[index]
    if (!window) continue
    const range = parentSpan(window, duration)
    const lines = input.subtitles
      .filter((line) => line.start >= range.start && line.start < range.end)
      .map((line) => ({ start: line.start, text: line.text }))
    const danmaku = input.danmaku
      .filter((item) => item.time >= range.start && item.time < range.end)
      .map((item) => ({ time: item.time, text: item.text }))
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

/** LLM 定界：只喂候选窗口；调用失败/输出不可解析都保留召回窗口兜底（降级链保证可渲染）。 */
async function delimitWithLlm(
  input: DetectAdsInput,
  endpoint: ChatEndpoint,
  spans: DetectCandidateSpan[],
  fallbacks: AdSegment[],
): Promise<AdSegment[]> {
  let raw: string
  try {
    const result = await chatCompletion({
      endpoint,
      messages: buildDetectBoundsMessages(input.video, spans, collectCommentTexts(input)),
      signal: input.signal,
    })
    raw = result.content
  } catch (error) {
    if (isAbortError(error) || input.signal?.aborted) throw error
    return fallbacks
  }
  return parseDetectAdResponse(raw, fallbacks, input.video.duration)
}

/** ③全文兜底：字幕整段交模型找广告；定界不出片段即视为无广告（source none），解析失败同样收尾。 */
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
    }
  } catch (error) {
    if (isAbortError(error) || input.signal?.aborted) throw error
    return { ads: [], source: 'none' }
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
  const chatUrl = settings.apiUrl.trim()
  const chatModel = settings.model.trim()
  if (!chatUrl || !chatModel) {
    throw new AiError('config', '还没配置端点，先去设置页填一下')
  }
  const endpoint: ChatEndpoint = {
    baseUrl: chatUrl,
    model: chatModel,
    apiKey: settings.apiKey.trim(),
    format: settings.apiFormat,
  }
  const resolvedEmbed = resolveEmbeddingEndpoint(settings)
  const embedEndpoint: ChatEndpoint = {
    baseUrl: resolvedEmbed.baseUrl,
    model: resolvedEmbed.model,
    apiKey: resolvedEmbed.apiKey,
  }

  const { video, subtitles } = input
  const duration = video.duration
  const windows = chunkSubtitleWindows(subtitles)
  // 生效语料 = 内置词库 + 用户补录（一次读取，两路召回共用同一份，避免两路口径不一致）。
  const corpus = await effectiveCorpus()

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

  // 两路 RRF 融合出候选窗口。
  const fused = rrfFuse([lexicalRanked.map((item) => item.index), vectorRankedIndexes])
  if (fused.length === 0) {
    // ③无命中且字幕可用：LLM 全文兜底；④无字幕：空结果收尾。
    return subtitles.length === 0
      ? { ads: [], source: 'none' }
      : detectByFulltext(input, endpoint)
  }

  const spans = buildCandidateSpans(windows, fused, input, duration)
  const fallbacks = mergeAdSegments(windowsAsFallbackAds(windows, fused, duration), duration)
  const ads = await delimitWithLlm(input, endpoint, spans, fallbacks)
  return { ads: mergeAdSegments(ads, duration), source: 'rag' }
}