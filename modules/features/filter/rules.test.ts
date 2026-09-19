// 视频筛选规则引擎测试（Epic2-S2.4）：八维度语义、完整性门槛、BV 提取、空配置、校验。
import { describe, expect, it } from 'vitest'
import type { VideoFilterConfig } from '../config'
import {
  ageDaysOf,
  extractBvid,
  filterReason,
  hasAnyCriteria,
  itemIsComplete,
  likeRateOf,
  validateFilterConfig,
  type FeedItem,
} from './rules'

const EMPTY: VideoFilterConfig = {
  titleKeywords: [],
  authorBlacklist: [],
  durationMinSeconds: null,
  durationMaxSeconds: null,
  danmakuMin: null,
  danmakuMax: null,
  likeMin: null,
  likeMax: null,
  viewMin: null,
  viewMax: null,
  likeRateMin: null,
  likeRateMax: null,
  pubdateMinDays: null,
  pubdateMaxDays: null,
}

function itemOf(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    bvid: 'BV18vY969EHJ',
    title: '这是一期普通的设备横评',
    owner: { name: '某UP主', mid: 42 },
    duration: 600,
    goto: 'av',
    stat: { danmaku: 100, like: 1000, view: 10_000 },
    pubdate: Math.floor(Date.now() / 1000) - 86_400, // 一天前
    ...overrides,
  }
}

describe('extractBvid / itemIsComplete', () => {
  it('BV 提取：bvid 字段优先，uri 兜底，都无 → null', () => {
    expect(extractBvid({ bvid: 'BV18vY969EHJ' })).toBe('BV18vY969EHJ')
    expect(extractBvid({ bvid: 'BV18vY969EHJ?p=2' })).toBe('BV18vY969EHJ')
    expect(extractBvid({ uri: 'bilibili://video/BV2xx411c7mE?x=1' })).toBe('BV2xx411c7mE')
    expect(extractBvid({ title: '无标识' })).toBeNull()
  })

  it('完整性门槛：goto≠av / 缺 owner / 缺 stat / 缺 pubdate 都不筛', () => {
    expect(itemIsComplete(itemOf())).toBe(true)
    expect(itemIsComplete(itemOf({ goto: 'picture' }))).toBe(false)
    expect(itemIsComplete(itemOf({ owner: undefined }))).toBe(false)
    expect(itemIsComplete(itemOf({ stat: undefined }))).toBe(false)
    expect(itemIsComplete(itemOf({ pubdate: undefined }))).toBe(false)
  })
})

describe('filterReason（八维度）', () => {
  it('标题关键词：子串、忽略大小写、多值 OR', () => {
    const config = { ...EMPTY, titleKeywords: [' iPhone ', '鸿蒙'] }
    expect(filterReason(itemOf({ title: 'iPhone 17 深度体验' }), config)).toContain('标题关键词')
    expect(filterReason(itemOf({ title: '鸿蒙 NEXT 上手' }), config)).toContain('标题关键词')
    expect(filterReason(itemOf({ title: '安卓旗舰横评' }), config)).toBeNull()
  })

  it('UP 黑名单：mid 全等或名字全等（trim+忽略大小写），子串不命中', () => {
    const config = { ...EMPTY, authorBlacklist: ['42', '某up主'] }
    expect(filterReason(itemOf(), config)).toContain('UP黑名单') // mid=42
    expect(filterReason(itemOf({ owner: { name: '某UP主', mid: 99 } }), config)).toContain('UP黑名单')
    expect(filterReason(itemOf({ owner: { name: '某UP主的分身', mid: 99 } }), config)).toBeNull()
  })

  it('时长/弹幕/点赞/浏览量：闭区间，null=不限，数据缺失不筛', () => {
    expect(filterReason(itemOf({ duration: 30 }), { ...EMPTY, durationMaxSeconds: 60 })).toBeNull()
    expect(filterReason(itemOf({ duration: 90 }), { ...EMPTY, durationMaxSeconds: 60 })).toContain('时长')
    expect(filterReason(itemOf(), { ...EMPTY, viewMin: 100_000 })).toContain('浏览量')
    expect(filterReason(itemOf({ stat: { danmaku: 5, like: 1, view: 2 } }), { ...EMPTY, danmakuMin: 10 })).toContain('弹幕数')
    // 弹幕数据缺失：该维度不筛（宁放过）。
    expect(filterReason(itemOf({ stat: { like: 1, view: 2 } }), { ...EMPTY, danmakuMin: 10 })).toBeNull()
  })

  it('点赞率 = 点赞/浏览×100；浏览 ≤0 视为不限', () => {
    expect(likeRateOf(itemOf({ stat: { like: 500, view: 10_000 } }))).toBe(5)
    expect(likeRateOf(itemOf({ stat: { like: 500, view: 0 } }))).toBeNull()
    // 点赞率 1% < 下限 5% → 筛掉；10% 在区间内 → 保留。
    expect(filterReason(itemOf({ stat: { like: 100, view: 10_000 } }), { ...EMPTY, likeRateMin: 5 })).toContain('点赞率')
    expect(filterReason(itemOf({ stat: { like: 1000, view: 10_000 } }), { ...EMPTY, likeRateMin: 5 })).toBeNull()
  })

  it('发布时间：距今天数区间', () => {
    expect(filterReason(itemOf(), { ...EMPTY, pubdateMaxDays: 0.5 })).toContain('发布时间')
    expect(filterReason(itemOf(), { ...EMPTY, pubdateMinDays: 3 })).toContain('发布时间')
    expect(filterReason(itemOf(), { ...EMPTY, pubdateMinDays: 0.5, pubdateMaxDays: 2 })).toBeNull()
    expect(ageDaysOf(itemOf({ pubdate: Math.floor(Date.now() / 1000) }))).toBeLessThan(0.01)
  })

  it('不完整条目直接不筛（宁放过不误杀）', () => {
    expect(filterReason(itemOf({ goto: 'picture' }), { ...EMPTY, titleKeywords: ['普通'] })).toBeNull()
  })
})

describe('hasAnyCriteria / validateFilterConfig', () => {
  it('全空 = 未配置任何规则', () => {
    expect(hasAnyCriteria(EMPTY)).toBe(false)
    expect(hasAnyCriteria({ ...EMPTY, viewMin: 0 })).toBe(true)
  })

  it('min>max 仅在两值都填时报错，按字段定位', () => {
    expect(validateFilterConfig(EMPTY)).toEqual([])
    expect(validateFilterConfig({ ...EMPTY, durationMinSeconds: 60, durationMaxSeconds: 30 })).toEqual([
      '视频时长最小值不能大于最大值',
    ])
    expect(validateFilterConfig({ ...EMPTY, viewMin: 100 })).toEqual([])
    const two = validateFilterConfig({
      ...EMPTY,
      likeMin: 10,
      likeMax: 1,
      pubdateMinDays: 30,
      pubdateMaxDays: 7,
    })
    expect(two).toHaveLength(2)
  })
})
