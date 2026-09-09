// 内容脚本交互层纯函数测试（倒计时/跳过判定/成就累计/文案），不碰 DOM 与 chrome API。
import { describe, expect, it } from 'vitest'
import {
  BANNER_LEAD_SECONDS,
  adsAheadOf,
  accumulateDailyStats,
  bannerCopy,
  bannerSubCopy,
  countdownAdAt,
  countdownSeconds,
  formatHms,
  formatSavedDuration,
  insideAdAt,
  remainingSeconds,
  savedChipText,
  segmentKey,
  shouldSkipManually,
  sortedAds,
  todayString,
} from '../modules/content/logic'
import type { AdSegment } from '../modules/ai/port'

const AD: AdSegment = {
  start: 100,
  end: 130,
  product_name: '某音乐App',
  ad_content: '',
  confidence: 0.9,
}
const LATER: AdSegment = { start: 200, end: 230, product_name: 'B', ad_content: '', confidence: 0.7 }

describe('倒计时判定', () => {
  it(`播放至 ad.start−${BANNER_LEAD_SECONDS} 进入倒计时窗口，到点即退出`, () => {
    expect(countdownAdAt([AD], 97)).toEqual(AD)
    expect(countdownAdAt([AD], 96.9)).toBeNull()
    expect(countdownAdAt([AD], 100)).toBeNull() // 到点：不算倒计时，改走段内判定
  })

  it('多段按 start 先后取先进入者', () => {
    const ads = [LATER, AD]
    expect(countdownAdAt(ads, 197)).toEqual(LATER)
    expect(countdownAdAt(ads, 97)).toEqual(AD)
  })

  it('倒计时环整秒恒在 1..3', () => {
    expect(countdownSeconds(AD, 97)).toBe(3)
    expect(countdownSeconds(AD, 98.1)).toBe(2)
    expect(countdownSeconds(AD, 99.9)).toBe(1)
    expect(countdownSeconds(AD, 100)).toBe(0)
  })
})

describe('段内判定与手动跳过', () => {
  it('t 落在段内命中；段尾不命中', () => {
    expect(insideAdAt([AD], 110)).toEqual(AD)
    expect(insideAdAt([AD], 130)).toBeNull()
  })

  it('剩余 > 2 秒才立即跳（残段不打扰）', () => {
    expect(remainingSeconds(AD, 110)).toBe(20)
    expect(shouldSkipManually(AD, 110)).toBe(true)
    expect(shouldSkipManually(AD, 129)).toBe(false)
  })

  it('已越过的段不再相关（adsAheadOf）', () => {
    expect(adsAheadOf([AD, LATER], 150).map((ad) => ad.start)).toEqual([200])
  })
})

describe('广告段身份与排序', () => {
  it('segmentKey 由起止秒合成，同日统计去重依赖其稳定性', () => {
    expect(segmentKey(AD)).toBe('100:130')
    expect(segmentKey({ start: 100, end: 130 })).toBe('100:130')
  })

  it('sortedAds 返回按 start 升序的副本', () => {
    const sorted = sortedAds([LATER, AD])
    expect(sorted.map((ad) => ad.start)).toEqual([100, 200])
    expect(sorted).not.toBe([LATER, AD])
  })
})

describe('成就累计（按日）', () => {
  it('跨日重置、同段当日只计一次、不同段秒数累加', () => {
    const dayOne = accumulateDailyStats(null, '2026-09-09', '100:130', 30)
    expect(dayOne).toEqual({ date: '2026-09-09', savedSeconds: 30, skippedKeys: ['100:130'] })

    const repeated = accumulateDailyStats(dayOne, '2026-09-09', '100:130', 30)
    expect(repeated.savedSeconds).toBe(30)
    expect(repeated.skippedKeys).toEqual(['100:130'])

    const more = accumulateDailyStats(dayOne, '2026-09-09', '200:230', 30)
    expect(more.savedSeconds).toBe(60)
    expect(more.skippedKeys).toEqual(['100:130', '200:230'])

    const nextDay = accumulateDailyStats(dayOne, '2026-09-10', '100:130', 10)
    expect(nextDay).toEqual({ date: '2026-09-10', savedSeconds: 10, skippedKeys: ['100:130'] })
  })

  it('空记录首次累计直接起新日', () => {
    expect(accumulateDailyStats(undefined, '2026-09-09', 'k', 5)).toEqual({
      date: '2026-09-09',
      savedSeconds: 5,
      skippedKeys: ['k'],
    })
  })

  it('todayString 为本地 YYYY-MM-DD', () => {
    expect(todayString(new Date(2026, 8, 9))).toBe('2026-09-09')
    expect(todayString(new Date(2026, 0, 1))).toBe('2026-01-01')
  })
})

describe('微文案与时间格式化', () => {
  it('主文案有商品名前置、无商品名保底', () => {
    expect(bannerCopy(AD)).toBe('前方恰饭：某音乐App，3 秒后带你跳过～')
    expect(bannerCopy({ ...AD, product_name: '' })).toBe('前方恰饭，3 秒后带你跳过～')
  })

  it('副文案带 HH:MM:SS 区间与自动跳过声明', () => {
    expect(bannerSubCopy(AD)).toBe('恰饭段 00:01:40–00:02:10 · 不点也会自动跳')
  })

  it('formatHms 输出 HH:MM:SS', () => {
    expect(formatHms(0)).toBe('00:00:00')
    expect(formatHms(65)).toBe('00:01:05')
    expect(formatHms(492)).toBe('00:08:12')
    expect(formatHms(3600 + 580)).toBe('01:09:40')
  })

  it('节省时长文案：整分/带秒/纯秒', () => {
    expect(formatSavedDuration(42)).toBe('42 秒')
    expect(formatSavedDuration(88)).toBe('1 分 28 秒')
    expect(formatSavedDuration(120)).toBe('2 分')
    expect(formatSavedDuration(0)).toBe('0 秒')
  })

  it('成就整句文案', () => {
    expect(savedChipText(88)).toBe('今天帮你省了 1 分 28 秒')
  })
})