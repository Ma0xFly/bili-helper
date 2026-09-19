// 拦截明细测试：归一（脏条目丢弃）、追加（合批 + 环形截断 + 同视频同规则去重）、清空。
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendFilterLogEntries,
  clearFilterLog,
  FILTER_LOG_LIMIT,
  FILTER_LOG_STORAGE_KEY,
  normalizeFilterLogEntry,
  readFilterLog,
  resetFilterLogBuffer,
} from './filter-log'

/** 结算 fire-and-forget 的落库 promise（immediate 模式）。 */
async function flushWrites(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

afterEach(() => {
  resetFilterLogBuffer()
})

describe('normalizeFilterLogEntry', () => {
  it('非法条目（缺 bvid/reason/非对象）丢弃；字段归一', () => {
    expect(normalizeFilterLogEntry(null)).toBeNull()
    expect(normalizeFilterLogEntry({ bvid: '', reason: 'x' })).toBeNull()
    expect(normalizeFilterLogEntry({ bvid: 'BV1x', reason: '' })).toBeNull()
    expect(
      normalizeFilterLogEntry({ bvid: 'BV1x', reason: '标题关键词:带货', title: 42, surface: '首页', time: 'x' }),
    ).toEqual({ bvid: 'BV1x', reason: '标题关键词:带货', title: '', surface: '首页', time: 0 })
  })
})

describe('appendFilterLogEntries', () => {
  it('immediate 模式立即落库，最新在前', async () => {
    let tick = 1000
    appendFilterLogEntries(
      [
        { bvid: 'BV1aa', title: 'A', reason: '标题关键词:带货', surface: '首页' },
        { bvid: 'BV2bb', title: 'B', reason: '广告标识', surface: '首页' },
      ],
      { now: () => (tick += 1), immediate: true },
    )
    await flushWrites()
    const entries = await readFilterLog()
    expect(entries.map((entry) => entry.bvid)).toEqual(['BV2bb', 'BV1aa'])
    expect(entries[0]).toMatchObject({ reason: '广告标识', surface: '首页' })
  })

  it('合批窗口内的多条一次落库（300ms 定时器）', async () => {
    vi.useFakeTimers()
    try {
      appendFilterLogEntries([{ bvid: 'BV1aa', title: '', reason: '时长', surface: '热门' }])
      appendFilterLogEntries([{ bvid: 'BV2bb', title: '', reason: '时长', surface: '热门' }])
      expect((await readFilterLog()).length).toBe(0) // 窗口内未落库
      await vi.advanceTimersByTimeAsync(400)
      const entries = await readFilterLog()
      expect(entries.length).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('同 bvid + 同规则去重（翻页重复出现不刷屏）；环形截断到上限', async () => {
    const events = Array.from({ length: FILTER_LOG_LIMIT + 20 }, (_unused, index) => ({
      bvid: `BV1xx${index}`,
      title: `t${index}`,
      reason: '标题关键词:带货',
      surface: '搜索',
    }))
    appendFilterLogEntries(events, { immediate: true })
    await flushWrites()
    let entries = await readFilterLog()
    expect(entries.length).toBe(FILTER_LOG_LIMIT)
    expect(entries[0]?.bvid).toBe(`BV1xx${FILTER_LOG_LIMIT + 19}`) // 最新在前

    // 同视频同规则再来一次：不新增。
    appendFilterLogEntries(
      [{ bvid: `BV1xx${FILTER_LOG_LIMIT + 19}`, title: 'dup', reason: '标题关键词:带货', surface: '搜索' }],
      { immediate: true },
    )
    await flushWrites()
    entries = await readFilterLog()
    expect(entries.length).toBe(FILTER_LOG_LIMIT)
  })

  it('clearFilterLog 清空存储与缓冲', async () => {
    appendFilterLogEntries([{ bvid: 'BV1aa', title: '', reason: 'r', surface: '首页' }], {
      immediate: true,
    })
    await flushWrites()
    expect((await readFilterLog()).length).toBe(1)
    await clearFilterLog()
    expect(await readFilterLog()).toEqual([])
    const raw = (await chrome.storage.local.get(FILTER_LOG_STORAGE_KEY)) as Record<string, unknown>
    expect(raw[FILTER_LOG_STORAGE_KEY]).toBeUndefined()
  })
})
