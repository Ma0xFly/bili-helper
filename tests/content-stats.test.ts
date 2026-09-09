// 成就统计的 storage.local 存取：按日累计、同段去重、写失败返回 null（不显示 chip）。
import { describe, expect, it } from 'vitest'
import { readDailyStats, recordSkipped } from '../modules/content/stats'
import { todayString } from '../modules/content/logic'

describe('成就统计（storage.local 按日累计）', () => {
  it('无历史时记一笔即当日总量', async () => {
    const total = await recordSkipped('100:130', 30)
    expect(total).toBe(30)
    expect(await readDailyStats()).toEqual({
      date: todayString(),
      savedSeconds: 30,
      skippedKeys: ['100:130'],
    })
  })

  it('同段当日只计一次，不同段累加', async () => {
    await recordSkipped('100:130', 30)
    expect(await recordSkipped('100:130', 30)).toBe(30)
    expect(await recordSkipped('200:230', 58)).toBe(88)
  })

  it('跨日记录首日重置', async () => {
    await chrome.storage.local.set({
      biliHelperAdSkipStats: { date: '2000-01-01', savedSeconds: 999, skippedKeys: ['old'] },
    })
    const total = await recordSkipped('100:130', 12)
    expect(total).toBe(12)
    const stats = await readDailyStats()
    expect(stats?.date).toBe(todayString())
    expect(stats?.savedSeconds).toBe(12)
  })

  it('坏形状存储按无记录处理', async () => {
    await chrome.storage.local.set({ biliHelperAdSkipStats: { date: 42 } })
    expect(await readDailyStats()).toBeNull()
    expect(await recordSkipped('k', 8)).toBe(8)
  })

  it('并发记两段不丢累计（写入串行）', async () => {
    const results = await Promise.all([recordSkipped('a', 10), recordSkipped('b', 20)])
    // 顺序不定但总量必须等于 30：两个结果一个是 10、一个是 30。
    expect([...results].sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual([10, 30])
    expect((await readDailyStats())?.savedSeconds).toBe(30)
  })
})