// 功能配置层测试（Epic1-S1.1）：默认值不落库、脏值归一不回写、并发写串行不覆盖、
// 写失败上抛、日统计跨日归零。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FEATURE_IDS,
  FEATURE_REGISTRY,
  clearFeatureStorage,
  bumpFeatureStat,
  readFeatureConfig,
  readFeatureConfigs,
  readFeatureStats,
  setFeatureEnabled,
  writeFeatureConfig,
} from './config'

beforeEach(async () => {
  await chrome.storage.local.clear()
})

describe('功能注册表', () => {
  it('6 个功能、两个分组齐全（布局优化与换一换历史已按产品裁决移除）；全部默认关闭', () => {
    expect(FEATURE_IDS).toHaveLength(6)
    const groups = new Set(FEATURE_IDS.map((id) => FEATURE_REGISTRY[id].group))
    expect([...groups].sort()).toEqual(['enhance', 'filter'])
    for (const id of FEATURE_IDS) {
      const entry = FEATURE_REGISTRY[id]
      expect(entry.title.length).toBeGreaterThan(0)
      expect(entry.description.length).toBeGreaterThan(0)
    }
  })

  it('只有两个 DOM 拦截器参与「今日拦截」统计', () => {
    const counted = FEATURE_IDS.filter((id) => FEATURE_REGISTRY[id].counted)
    expect(counted).toEqual(['adVideoBlocker', 'promotedVideoBlocker'])
  })
})

describe('读取：默认值与脏值归一', () => {
  it('从未写入 → 每个功能返回完整默认值，且不写存储', async () => {
    const map = await readFeatureConfigs()
    expect(map.steplessVideoRate).toEqual({ config: { rate: 1 }, enabled: false })
    expect(map.videoFilter.config.titleKeywords).toEqual([])
    // 不落库：存储里没有该键。
    const raw = await chrome.storage.local.get(null)
    expect(Object.keys(raw)).toEqual([])
  })

  it('脏值归一：倍速越界截断、天数取整、非法维度回 null、列表去重去空', async () => {
    await chrome.storage.local.set({
      biliHelperFeatures: {
        steplessVideoRate: { config: { rate: 9.9 }, enabled: 'yes' },
        videoFilter: {
          config: {
            titleKeywords: ['广告, 恰饭', '广告', '  ', '广告'],
            authorBlacklist: ['UP甲\nUP乙，UP甲'],
            durationMinSeconds: -5,
            pubdateMinDays: 3.7,
            likeRateMin: 2.5,
          },
          enabled: true,
        },
      },
    })
    const rate = await readFeatureConfig('steplessVideoRate')
    expect(rate).toEqual({ config: { rate: 5 }, enabled: false }) // 9.9 截到 5；'yes' 归 false
    const filter = await readFeatureConfig('videoFilter')
    expect(filter.enabled).toBe(true)
    expect(filter.config.titleKeywords).toEqual(['广告', '恰饭'])
    expect(filter.config.authorBlacklist).toEqual(['UP甲', 'UP乙'])
    expect(filter.config.durationMinSeconds).toBeNull()
    expect(filter.config.pubdateMinDays).toBe(4)
    expect(filter.config.likeRateMin).toBe(2.5)
    // 归一只发生在读取结果里，不回写存储。
    const stored = (await chrome.storage.local.get('biliHelperFeatures')) as Record<string, unknown>
    expect((stored.biliHelperFeatures as Record<string, unknown>).steplessVideoRate).toMatchObject({
      config: { rate: 9.9 },
    })
  })


})

describe('写入：串行链与失败上抛', () => {
  it('部分写入与合并：patch 落到当前值上，读改写在链内串行', async () => {
    await writeFeatureConfig('videoFilter', { titleKeywords: ['广告'] })
    await setFeatureEnabled('videoFilter', true)
    const entry = await readFeatureConfig('videoFilter')
    expect(entry.enabled).toBe(true)
    expect(entry.config.titleKeywords).toEqual(['广告'])
  })

  it('并发两次写同一功能不互相覆盖（链内串行读改写）', async () => {
    await setFeatureEnabled('videoFilter', true)
    // 两个并发 patch 各改一个字段，最终两个字段都在。
    await Promise.all([
      writeFeatureConfig('videoFilter', { titleKeywords: ['广告'] }),
      writeFeatureConfig('videoFilter', { authorBlacklist: ['某UP'] }),
    ])
    const entry = await readFeatureConfig('videoFilter')
    expect(entry.config.titleKeywords).toEqual(['广告'])
    expect(entry.config.authorBlacklist).toEqual(['某UP'])
    expect(entry.enabled).toBe(true)
  })

  it('存储写失败上抛（不静默成功），且不毒化写链（后续写仍可用）', async () => {
    const realSet = chrome.storage.local.set
    const failingSet = vi.fn(async (items: Record<string, unknown>) => {
      if ('biliHelperFeatures' in items) throw new Error('quota')
      return realSet(items)
    })
    chrome.storage.local.set = failingSet as typeof chrome.storage.local.set
    await expect(setFeatureEnabled('adVideoBlocker', true)).rejects.toThrow(/quota/)
    chrome.storage.local.set = realSet
    await expect(setFeatureEnabled('adVideoBlocker', true)).resolves.toMatchObject({ enabled: true })
  })
})

describe('日统计（今日拦截）', () => {
  it('bump 累加；读取时跨日归零并写回', async () => {
    // 先伪造昨天的推广拦截记录（整键写入会覆盖，故放在 bump 之前）。
    await chrome.storage.local.set({
      biliHelperFeatureStats: { promotedVideoBlocker: { statsDate: '2020-01-01', totalBlocked: 99 } },
    })
    expect(await bumpFeatureStat('adVideoBlocker')).toBe(1)
    expect(await bumpFeatureStat('adVideoBlocker')).toBe(2)

    const stats = await readFeatureStats()
    expect(stats.promotedVideoBlocker).toEqual({ statsDate: expect.any(String), totalBlocked: 0 })
    expect(stats.adVideoBlocker).toEqual({ statsDate: expect.any(String), totalBlocked: 2 })
    // 归零已写回：再 bump 从 1 起步。
    expect(await bumpFeatureStat('promotedVideoBlocker')).toBe(1)
  })
})

describe('clearFeatureStorage', () => {
  it('清空两个键', async () => {
    await setFeatureEnabled('videoFilter', true)
    await bumpFeatureStat('adVideoBlocker')
    await clearFeatureStorage()
    const raw = await chrome.storage.local.get(null)
    expect(Object.keys(raw)).toEqual([])
  })
})
