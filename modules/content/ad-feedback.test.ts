// 误判反馈纯逻辑 + 存储测试：区间相减/合并、检测结果叠加（误报剔除碎片化/漏报并入）、
// 持久化归一与 LRU 淘汰。
import { describe, expect, it } from 'vitest'
import {
  AD_FEEDBACK_MAX_VIDEOS,
  AD_FEEDBACK_STORAGE_KEY,
  adFeedbackKey,
  applyAdFeedback,
  mergeAdIntervals,
  normalizeAdFeedback,
  readAdFeedback,
  subtractInterval,
  writeAdFeedback,
  type AdFeedback,
} from './ad-feedback'
import type { AdSegment } from '../ai/port'

const AD: AdSegment = {
  start: 100,
  end: 130,
  product_name: '某耳机',
  ad_content: '',
  confidence: 0.9,
}

describe('区间运算', () => {
  it('subtractInterval：不重叠原样；中切两片；边界对齐吃掉整段', () => {
    expect(subtractInterval({ start: 100, end: 130 }, { start: 0, end: 50 })).toEqual([
      { start: 100, end: 130 },
    ])
    expect(subtractInterval({ start: 100, end: 130 }, { start: 110, end: 120 })).toEqual([
      { start: 100, end: 110 },
      { start: 120, end: 130 },
    ])
    expect(subtractInterval({ start: 100, end: 130 }, { start: 100, end: 130 })).toEqual([])
    expect(subtractInterval({ start: 100, end: 130 }, { start: 90, end: 140 })).toEqual([])
  })

  it('mergeAdIntervals：重叠/近邻（间隙 ≤2s）合并，乱序输入按 start 归位', () => {
    expect(
      mergeAdIntervals([
        { start: 200, end: 260 },
        { start: 100, end: 130 },
        { start: 131, end: 160 }, // 与上一段间隙 1s → 合并
        { start: 300, end: 320 },
      ]),
    ).toEqual([
      { start: 100, end: 160 },
      { start: 200, end: 260 },
      { start: 300, end: 320 },
    ])
  })
})

describe('applyAdFeedback 检测结果叠加', () => {
  it('无反馈：原样返回（排序副本）', () => {
    expect(applyAdFeedback([AD], null)).toEqual([AD])
    expect(applyAdFeedback([AD], { notAds: [], missedAds: [] })).toEqual([AD])
  })

  it('误报整段命中：该段消失；其余段保留', () => {
    const other: AdSegment = { ...AD, start: 300, end: 330 }
    expect(
      applyAdFeedback([AD, other], { notAds: [{ start: 100, end: 130 }], missedAds: [] }),
    ).toEqual([other])
  })

  it('误报中切：碎片继承元数据；不足 2s 的碎片丢弃', () => {
    const pieces = applyAdFeedback([AD], { notAds: [{ start: 110, end: 120 }], missedAds: [] })
    expect(pieces).toEqual([
      { ...AD, start: 100, end: 110 },
      { ...AD, start: 120, end: 130 },
    ])
    // 切掉 128–132：残片 100–128 保留，130 后残片 0s 丢弃。
    const tiny = applyAdFeedback([AD], { notAds: [{ start: 128, end: 140 }], missedAds: [] })
    expect(tiny).toEqual([{ ...AD, start: 100, end: 128 }])
  })

  it('漏报并入：confidence 1（直接可跳），手动标记段名；与检测结果按 start 排序共存', () => {
    const merged = applyAdFeedback([AD], { notAds: [], missedAds: [{ start: 200, end: 230 }] })
    expect(merged).toEqual([
      AD,
      { start: 200, end: 230, product_name: '手动标记', ad_content: '', confidence: 1 },
    ])
  })

  it('双向叠加：先剔除再并入（notAds 不会误伤 missedAds）', () => {
    const merged = applyAdFeedback(
      [AD],
      { notAds: [{ start: 0, end: 999 }], missedAds: [{ start: 200, end: 230 }] },
    )
    expect(merged).toEqual([
      { start: 200, end: 230, product_name: '手动标记', ad_content: '', confidence: 1 },
    ])
  })
})

describe('反馈存储', () => {
  const FEEDBACK: AdFeedback = {
    cid: 11,
    notAds: [{ start: 100, end: 130 }],
    missedAds: [],
    updatedAt: 1,
  }

  it('写入后按 bvid:cid 读回；不同 cid 互不串味；cid null 不读', async () => {
    await writeAdFeedback('BV1ee', FEEDBACK)
    expect(await readAdFeedback('BV1ee', 11)).toMatchObject({
      cid: 11,
      notAds: [{ start: 100, end: 130 }],
    })
    expect(await readAdFeedback('BV1ee', 22)).toBeNull()
    expect(await readAdFeedback('BV1ee', null)).toBeNull()
  })

  it('normalize：坏条目丢弃，两类都空 = 无反馈', () => {
    expect(normalizeAdFeedback({ cid: 1, notAds: [{ start: 5, end: 3 }], missedAds: [] })).toBeNull()
    expect(normalizeAdFeedback({ notAds: [{ start: 5, end: 9 }] })).toBeNull() // 缺 cid
    expect(normalizeAdFeedback('junk')).toBeNull()
    expect(
      normalizeAdFeedback({ cid: 1, notAds: [{ start: 5, end: 9 }, 'bad'], missedAds: [] }),
    ).toEqual({ cid: 1, notAds: [{ start: 5, end: 9 }], missedAds: [], updatedAt: 0 })
  })

  it('storage 里的脏视频条目在下次写入时清理；超上限按 updatedAt 淘汰最旧', async () => {
    // 预置：一条脏数据 + 超上限的合法反馈。
    const preset: Record<string, unknown> = { 'BV1bad:1': 'garbage' }
    for (let index = 0; index < AD_FEEDBACK_MAX_VIDEOS; index += 1) {
      preset[adFeedbackKey(`BV1ff${index}`, index)] = {
        cid: index,
        notAds: [{ start: 1, end: 9 }],
        missedAds: [],
        updatedAt: index,
      }
    }
    await chrome.storage.local.set({ [AD_FEEDBACK_STORAGE_KEY]: preset })
    await writeAdFeedback('BV1new', { cid: 99, notAds: [{ start: 1, end: 9 }], missedAds: [], updatedAt: 0 })
    const raw = (await chrome.storage.local.get(AD_FEEDBACK_STORAGE_KEY)) as Record<string, unknown>
    const map = raw[AD_FEEDBACK_STORAGE_KEY] as Record<string, unknown>
    expect(map['BV1bad:1']).toBeUndefined() // 脏数据被清
    expect(Object.keys(map).length).toBe(AD_FEEDBACK_MAX_VIDEOS)
    expect(map[adFeedbackKey('BV1ff0', 0)]).toBeUndefined() // 最旧淘汰
    expect(map[adFeedbackKey('BV1new', 99)]).toBeDefined()
  })
})
