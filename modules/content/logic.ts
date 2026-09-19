// 内容脚本交互层的纯判定逻辑：倒计时触发/跳过判定/段内判定/成就累计与文案。
// 全部纯函数、不碰 DOM 与 chrome API，可直接单测。

import type { AdSegment } from '../ai/port'

/** 提示条提前量（秒）：播放到 ad.start - 3 秒时弹出。 */
export const BANNER_LEAD_SECONDS = 3
/** 手动拖入广告段立即跳过的最小剩余时长（秒），残段小于该值不打扰。 */
export const MIN_MANUAL_REMAINING_SECONDS = 2
/** 跳过成功后校验 seek 是否生效的容差（秒）。 */
export const SEEK_VERIFY_TOLERANCE_SECONDS = 1.5

/** 广告段身份键：同视频内（起止秒）唯一定位一段，用于「这段想看」与当日去重统计。 */
export function segmentKey(ad: { start: number; end: number }): string {
  return `${Math.round(ad.start * 10) / 10}:${Math.round(ad.end * 10) / 10}`
}

/** 按 start 排序（返回副本）。 */
export function sortedAds(ads: AdSegment[]): AdSegment[] {
  return [...ads].sort((a, b) => a.start - b.start)
}

/** 播放位置 t 仍相关的广告段：段未完全过去（t < end），供倒计时与段内判定。 */
export function adsAheadOf(ads: AdSegment[], currentTime: number): AdSegment[] {
  return sortedAds(ads).filter((ad) => currentTime < ad.end)
}

/** 倒计时态：t 落在 [ad.start - 3, ad.start) 的段；多段重叠时取先进入者。 */
export function countdownAdAt(ads: AdSegment[], currentTime: number): AdSegment | null {
  const candidates = sortedAds(ads).filter(
    (ad) => currentTime >= ad.start - BANNER_LEAD_SECONDS && currentTime < ad.start,
  )
  return candidates[0] ?? null
}

/** 段内态：t 落在 [ad.start, ad.end) 的段。 */
export function insideAdAt(ads: AdSegment[], currentTime: number): AdSegment | null {
  const candidates = sortedAds(ads).filter(
    (ad) => currentTime >= ad.start && currentTime < ad.end,
  )
  return candidates[0] ?? null
}

/** 剩余秒数（距段尾）。 */
export function remainingSeconds(ad: { end: number }, currentTime: number): number {
  return ad.end - currentTime
}

/** 手动拖入段内且残段足够长 → 立即跳过。 */
export function shouldSkipManually(ad: AdSegment, currentTime: number): boolean {
  return remainingSeconds(ad, currentTime) > MIN_MANUAL_REMAINING_SECONDS
}

/** 倒计时环上显示的整秒数：距段开始的余秒向上取整（恒在 1..3）。 */
export function countdownSeconds(ad: { start: number }, currentTime: number): number {
  const remaining = ad.start - currentTime
  return Math.min(BANNER_LEAD_SECONDS, Math.max(0, Math.ceil(remaining - 1e-9)))
}

/** 提示条主文案；商品名已知时前置。倒计时秒数由 BANNER_LEAD_SECONDS 派生，不硬编码。 */
export function bannerCopy(ad: AdSegment): string {
  const product = ad.product_name.trim()
  return product
    ? `前方恰饭：${product}，${BANNER_LEAD_SECONDS} 秒后带你跳过～`
    : `前方恰饭，${BANNER_LEAD_SECONDS} 秒后带你跳过～`
}

/** 提示条副文案：恰饭段时间区间 + 自动跳过声明。 */
export function bannerSubCopy(ad: AdSegment): string {
  return `恰饭段 ${formatHms(ad.start)}–${formatHms(ad.end)} · 不点也会自动跳`
}

/** UI 层时间格式化：秒 → HH:MM:SS（端口内时间一律秒，只有 UI 层才格式化）。 */
export function formatHms(seconds: number): string {
  if (!Number.isFinite(seconds)) return '00:00:00'
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  return [hours, minutes, rest].map((part) => String(part).padStart(2, '0')).join(':')
}

/** 紧凑时间（章节/刻度 tooltip 用）：不足 1 小时出 mm:ss，超出出 H:mm:ss。 */
export function formatCompactTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '00:00'
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  const mm = String(minutes).padStart(2, '0')
  const ss = String(rest).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

export interface DailyStats {
  /** 本地日期（YYYY-MM-DD）。 */
  date: string
  savedSeconds: number
  /** 当日已计过分的片段键，防重复累计。 */
  skippedKeys: string[]
}

/** 本地日期串（YYYY-MM-DD），按本地时区。 */
export function todayString(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 成就累计：跨日重置；同片段键当日只计一次；返回新统计（可绑定原值缺失=全新一天）。 */
export function accumulateDailyStats(
  previous: DailyStats | null | undefined,
  today: string,
  key: string,
  seconds: number,
): DailyStats {
  if (!previous || previous.date !== today) {
    return { date: today, savedSeconds: Math.max(0, seconds), skippedKeys: [key] }
  }
  if (previous.skippedKeys.includes(key)) return { ...previous, skippedKeys: [...previous.skippedKeys] }
  return {
    date: today,
    savedSeconds: previous.savedSeconds + Math.max(0, seconds),
    skippedKeys: [...previous.skippedKeys, key],
  }
}

/** 成就文案：「今天帮你省了 X 分 X 秒」（不足 1 分只出秒、整分出分）。 */
export function formatSavedDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  if (minutes === 0) return `${rest} 秒`
  if (rest === 0) return `${minutes} 分`
  return `${minutes} 分 ${rest} 秒`
}

/** 成就整句微文案（popup 与 chip 共用）。 */
export function savedChipText(totalSavedSeconds: number): string {
  return `今天帮你省了 ${formatSavedDuration(totalSavedSeconds)}`
}