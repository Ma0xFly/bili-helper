// 广告误判反馈（用户纠错闭环）：按视频记住两类人工裁决，检测加载时叠加上去——
//   notAds（这段不是广告）：检测出的段减去这些区间，剩余碎片够长才保留；
//   missedAds（漏掉的广告段）：直接并入可跳列表（置信度 1，手动裁决最高优先）。
// 反馈与检测结果分仓存储（检测结果缓存在 result-cache，反馈在这里）：语料/端点变化
// 触发重检测时反馈依然生效——用户的纠错不能被一次重新检测冲掉。
// 纯逻辑（区间运算/应用）与存储读写同文件，纯函数部分不碰 chrome API 可单测。

import type { AdSegment } from '../ai/port'
import { sortedAds } from './logic'

export interface AdFeedbackInterval {
  start: number
  end: number
}

export interface AdFeedback {
  cid: number
  notAds: AdFeedbackInterval[]
  missedAds: AdFeedbackInterval[]
  updatedAt: number
}

export const AD_FEEDBACK_STORAGE_KEY = 'biliHelperAdFeedback'
/** 反馈视频数上限：按 updatedAt 从最旧淘汰（反馈是低频动作，50 个视频绰绰有余）。 */
export const AD_FEEDBACK_MAX_VIDEOS = 50
/** 单类区间条数上限（防脏数据无限膨胀）。 */
export const AD_FEEDBACK_MAX_INTERVALS = 200
/** 减掉误报区间后，剩余碎片不足该秒数即丢弃（两秒内的碎片没有跳转价值）。 */
export const MIN_AD_PIECE_SECONDS = 2
/** 漏报标记的最小段长：不足 1 秒的点击大概率是误触。 */
export const MIN_MISSED_SECONDS = 1

function asInterval(raw: unknown): AdFeedbackInterval | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const start = typeof record.start === 'number' ? record.start : NaN
  const end = typeof record.end === 'number' ? record.end : NaN
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0) return null
  return { start, end }
}

function asIntervalList(raw: unknown): AdFeedbackInterval[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map(asInterval)
    .filter((item): item is AdFeedbackInterval => item !== null)
    .slice(0, AD_FEEDBACK_MAX_INTERVALS)
}

/** 读侧归一：形状坏的条目丢弃；两类区间都空 = 没有反馈（null）。 */
export function normalizeAdFeedback(raw: unknown): AdFeedback | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const cid = typeof record.cid === 'number' && Number.isFinite(record.cid) ? record.cid : null
  if (cid === null) return null
  const notAds = asIntervalList(record.notAds)
  const missedAds = asIntervalList(record.missedAds)
  if (notAds.length === 0 && missedAds.length === 0) return null
  return {
    cid,
    notAds,
    missedAds,
    updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
      ? record.updatedAt
      : 0,
  }
}

export function adFeedbackKey(bvid: string, cid: number | null): string {
  return cid === null ? `${bvid}:` : `${bvid}:${cid}`
}

export async function readAdFeedback(bvid: string, cid: number | null): Promise<AdFeedback | null> {
  if (cid === null) return null
  const result = (await chrome.storage.local.get(AD_FEEDBACK_STORAGE_KEY)) as Record<
    string,
    unknown
  >
  const raw = result[AD_FEEDBACK_STORAGE_KEY]
  if (typeof raw !== 'object' || raw === null) return null
  return normalizeAdFeedback((raw as Record<string, unknown>)[adFeedbackKey(bvid, cid)])
}

/** 全量替换该视频的反馈并 LRU 淘汰最旧。 */
export async function writeAdFeedback(
  bvid: string,
  feedback: AdFeedback,
): Promise<void> {
  const normalized = normalizeAdFeedback(feedback)
  if (normalized === null) return
  const result = (await chrome.storage.local.get(AD_FEEDBACK_STORAGE_KEY)) as Record<
    string,
    unknown
  >
  const raw = result[AD_FEEDBACK_STORAGE_KEY]
  const map: Record<string, AdFeedback> =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, AdFeedback>) : {}
  // 先逐值归一（坏条目不留），再写新值。
  for (const key of Object.keys(map)) {
    const entry = normalizeAdFeedback(map[key])
    if (entry === null) delete map[key]
    else map[key] = entry
  }
  map[adFeedbackKey(bvid, feedback.cid)] = { ...normalized, updatedAt: Date.now() }
  const keys = Object.keys(map)
  if (keys.length > AD_FEEDBACK_MAX_VIDEOS) {
    const byOldest = keys.sort((a, b) => map[a]!.updatedAt - map[b]!.updatedAt)
    for (const key of byOldest.slice(0, keys.length - AD_FEEDBACK_MAX_VIDEOS)) delete map[key]
  }
  await chrome.storage.local.set({ [AD_FEEDBACK_STORAGE_KEY]: map })
}

// ---------- 纯逻辑：区间运算 ----------

function overlaps(a: AdFeedbackInterval, b: AdFeedbackInterval): boolean {
  return a.start < b.end && a.end > b.start
}

/** 区间相减：cut 切掉 segment 的重叠部分，返回剩余碎片（0~2 段）。 */
export function subtractInterval(
  segment: AdFeedbackInterval,
  cut: AdFeedbackInterval,
): AdFeedbackInterval[] {
  if (!overlaps(segment, cut)) return [segment]
  const pieces: AdFeedbackInterval[] = []
  if (segment.start < cut.start) pieces.push({ start: segment.start, end: Math.min(segment.end, cut.start) })
  if (segment.end > cut.end) pieces.push({ start: Math.max(segment.start, cut.end), end: segment.end })
  return pieces
}

/** 区间列表合并：重叠或间隙不足 2s 的相邻段并成一段（反馈累积防碎片化）。 */
export function mergeAdIntervals(
  intervals: AdFeedbackInterval[],
  gapSeconds = 2,
): AdFeedbackInterval[] {
  const sorted = [...intervals]
    .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start)
    .sort((a, b) => a.start - b.start)
  const out: AdFeedbackInterval[] = []
  for (const item of sorted) {
    const last = out[out.length - 1]
    if (last && item.start - last.end <= gapSeconds) {
      last.end = Math.max(last.end, item.end)
    } else {
      out.push({ ...item })
    }
  }
  return out
}

/**
 * 检测结果 × 反馈叠加：
 *   notAds 把命中段切成碎片（碎片 ≥2s 才保留，继承元数据与置信度）；
 *   missedAds 追加为 confidence 1 的段（高于自动跳过门槛，手动裁决直接可跳）。
 * 返回按 start 排序的新数组；无反馈时原样返回（新数组）。
 */
export function applyAdFeedback(
  ads: AdSegment[],
  feedback: Pick<AdFeedback, 'notAds' | 'missedAds'> | null,
): AdSegment[] {
  if (feedback === null || (feedback.notAds.length === 0 && feedback.missedAds.length === 0)) {
    return sortedAds(ads)
  }
  const out: AdSegment[] = []
  for (const ad of ads) {
    let pieces: AdFeedbackInterval[] = [{ start: ad.start, end: ad.end }]
    for (const cut of feedback.notAds) {
      pieces = pieces.flatMap((piece) => subtractInterval(piece, cut))
    }
    for (const piece of pieces) {
      if (piece.end - piece.start < MIN_AD_PIECE_SECONDS) continue
      out.push({ ...ad, start: piece.start, end: piece.end })
    }
  }
  for (const missed of feedback.missedAds) {
    if (missed.end - missed.start < MIN_MISSED_SECONDS) continue
    out.push({
      start: missed.start,
      end: missed.end,
      product_name: '手动标记',
      ad_content: '',
      confidence: 1,
    })
  }
  return sortedAds(out)
}
