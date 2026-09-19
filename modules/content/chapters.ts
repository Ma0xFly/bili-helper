// 进度条章节标记（功能：章节导航）——纯逻辑 + 轻量缓存，不碰 DOM。
// 两个来源：
//   official：B 站官方「看点/章节」（player/wbi/v2 的 view_points，UP 主或平台标注，零 token）；
//   ai：视频总结产出的分段时间线（SummarizeResult.segments，手动点总结时花过 token 的产物）。
// 合并原则：官方章节全保留（作者口径优先）；AI 分段边界只补官方没覆盖到的位置——
//   与任一官方章节起点距离小于去重窗、或位于片头（<5s）的 AI 边界丢弃，避免两套标记叠罗汉。

import type { SummarySegment } from '../ai/port'

export type ChapterSource = 'official' | 'ai'

export interface ChapterMark {
  /** 章节起点（秒）。 */
  start: number
  /** 章节终点（秒；官方有 to，AI 分段有 end）。 */
  end: number
  label: string
  source: ChapterSource
}

/** AI 边界与官方章节起点的去重窗（秒）：窗内视为同一处切割，不重复标记。 */
export const CHAPTER_DEDUPE_WINDOW_SECONDS = 20
/** 片头窗（秒）：视频开头的分段边界没有导航价值，不标记。 */
export const CHAPTER_HEAD_SKIP_SECONDS = 5
/** 标记数量上限：超长视频也只保留前 N 个，进度条不做成梳子。 */
export const MAX_CHAPTER_MARKS = 80

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 解析官方 view_points（player/wbi/v2 的 data.view_points 原始数组）：
 * 条目形状 {from, to, content}；from/to/content 任一非法即丢弃（宁可少标不可乱标）。
 * 同起点的重复条目保留首个。
 */
export function parseViewPoints(raw: unknown): ChapterMark[] {
  if (!Array.isArray(raw)) return []
  const out: ChapterMark[] = []
  const seenStarts = new Set<number>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const from = asFiniteNumber(record.from)
    const to = asFiniteNumber(record.to)
    const content = typeof record.content === 'string' ? record.content.trim() : ''
    if (from === null || to === null || content === '') continue
    if (from < 0 || to <= from) continue
    const startKey = Math.round(from * 10) / 10
    if (seenStarts.has(startKey)) continue
    seenStarts.add(startKey)
    out.push({ start: from, end: to, label: content, source: 'official' })
  }
  return out.sort((a, b) => a.start - b.start)
}

/** AI 分段 → 章节标记：跳过空标签与片头边界，按去重窗剔除与官方重复的边界。 */
export function mergeChapterSources(
  official: ChapterMark[],
  aiSegments: SummarySegment[],
  limits: {
    dedupeWindowSeconds?: number
    headSkipSeconds?: number
    max?: number
  } = {},
): ChapterMark[] {
  const dedupeWindow = limits.dedupeWindowSeconds ?? CHAPTER_DEDUPE_WINDOW_SECONDS
  const headSkip = limits.headSkipSeconds ?? CHAPTER_HEAD_SKIP_SECONDS
  const max = limits.max ?? MAX_CHAPTER_MARKS
  const merged: ChapterMark[] = [...official]
  for (const segment of aiSegments) {
    if (segment.label.trim() === '') continue
    if (!(segment.end > segment.start)) continue
    if (segment.start < headSkip) continue
    const nearOfficial = official.some(
      (chapter) => Math.abs(chapter.start - segment.start) < dedupeWindow,
    )
    if (nearOfficial) continue
    merged.push({ start: segment.start, end: segment.end, label: segment.label, source: 'ai' })
  }
  const sorted = merged.sort((a, b) => a.start - b.start)
  return sorted.length > max ? sorted.slice(0, max) : sorted
}

// ---------- AI 时间线缓存（总结花过 token，别让时间线随刷新蒸发） ----------

export const CHAPTER_CACHE_STORAGE_KEY = 'biliHelperChapterCache'
/** 缓存视频数上限：按 savedAt 从最旧淘汰。 */
export const CHAPTER_CACHE_LIMIT = 30

export interface ChapterCacheEntry {
  bvid: string
  cid: number
  segments: SummarySegment[]
  savedAt: number
}

interface ChapterCacheShape {
  [videoKey: string]: ChapterCacheEntry
}

function cacheKey(bvid: string, cid: number | undefined | null): string {
  return cid === undefined || cid === null || !Number.isFinite(cid) ? `${bvid}:` : `${bvid}:${cid}`
}

/** 缓存键（导出给备份/排障用）：cid 缺失时退化为 bvid:，正常路径不会走到。 */
export function chapterCacheKey(bvid: string, cid: number | undefined | null): string {
  return cacheKey(bvid, cid)
}

function normalizeCacheEntry(raw: unknown): ChapterCacheEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const bvid = typeof record.bvid === 'string' ? record.bvid : ''
  const cid = asFiniteNumber(record.cid)
  const savedAt = asFiniteNumber(record.savedAt) ?? 0
  if (bvid === '' || cid === null) return null
  const segments: SummarySegment[] = []
  if (Array.isArray(record.segments)) {
    for (const item of record.segments) {
      if (typeof item !== 'object' || item === null) continue
      const segment = item as Record<string, unknown>
      const start = asFiniteNumber(segment.start)
      const end = asFiniteNumber(segment.end)
      const label = typeof segment.label === 'string' ? segment.label.trim() : ''
      if (start === null || end === null || label === '') continue
      segments.push({ start, end, label })
    }
  }
  if (segments.length === 0) return null
  return { bvid, cid, segments, savedAt }
}

function normalizeCacheMap(raw: unknown): ChapterCacheShape {
  if (typeof raw !== 'object' || raw === null) return {}
  const out: ChapterCacheShape = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = normalizeCacheEntry(value)
    if (entry !== null) out[key] = entry
  }
  return out
}

/** 读某视频的 AI 时间线缓存；cid 缺失（罕见）不给缓存——不同分 P 的时间线不能混。 */
export async function readChapterCache(
  bvid: string,
  cid: number | undefined | null,
): Promise<ChapterCacheEntry | null> {
  if (cid === undefined || cid === null) return null
  const result = (await chrome.storage.local.get(CHAPTER_CACHE_STORAGE_KEY)) as Record<
    string,
    unknown
  >
  const map = normalizeCacheMap(result[CHAPTER_CACHE_STORAGE_KEY])
  return map[cacheKey(bvid, cid)] ?? null
}

/** 写入并按 savedAt LRU 淘汰到上限。 */
export async function writeChapterCache(
  bvid: string,
  cid: number,
  segments: SummarySegment[],
): Promise<void> {
  const clean = segments.filter(
    (segment) =>
      Number.isFinite(segment.start) &&
      Number.isFinite(segment.end) &&
      segment.end > segment.start &&
      segment.label.trim() !== '',
  )
  if (clean.length === 0) return
  const result = (await chrome.storage.local.get(CHAPTER_CACHE_STORAGE_KEY)) as Record<
    string,
    unknown
  >
  const map = normalizeCacheMap(result[CHAPTER_CACHE_STORAGE_KEY])
  map[cacheKey(bvid, cid)] = { bvid, cid, segments: clean, savedAt: Date.now() }
  const keys = Object.keys(map)
  if (keys.length > CHAPTER_CACHE_LIMIT) {
    const byOldest = keys.sort((a, b) => map[a]!.savedAt - map[b]!.savedAt)
    for (const key of byOldest.slice(0, keys.length - CHAPTER_CACHE_LIMIT)) delete map[key]
  }
  await chrome.storage.local.set({ [CHAPTER_CACHE_STORAGE_KEY]: map })
}
