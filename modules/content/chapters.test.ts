// 章节标记纯逻辑测试：官方看点解析（非法条目丢弃/同起点去重/排序）、
// 官方×AI 双源合并（去重窗/片头剔除/上限）、AI 时间线缓存（归一/LRU 淘汰/cid 缺失不缓存）。
import { describe, expect, it } from 'vitest'
import {
  CHAPTER_CACHE_LIMIT,
  CHAPTER_CACHE_STORAGE_KEY,
  chapterCacheKey,
  mergeChapterSources,
  parseViewPoints,
  readChapterCache,
  writeChapterCache,
} from './chapters'
import type { SummarySegment } from '../ai/port'

describe('parseViewPoints 官方看点解析', () => {
  it('合法条目解析并按 start 排序；from/to/content 任一非法或区间倒挂丢弃', () => {
    const raw = [
      { from: 120, to: 300, content: '开箱' },
      { from: 30, to: 120, content: '  前言  ' }, // label 需 trim
      { from: 'x', to: 10, content: '坏的' }, // from 非数字
      { from: 10, to: 5, content: '倒挂' }, // to <= from
      { from: 300, to: 400, content: '   ' }, // 空标签
      { from: 500, to: 600 }, // 缺 content
      'not-an-object',
    ]
    expect(parseViewPoints(raw)).toEqual([
      { start: 30, end: 120, label: '前言', source: 'official' },
      { start: 120, end: 300, label: '开箱', source: 'official' },
    ])
  })

  it('同起点重复条目只保留首个；非数组输入返回空', () => {
    expect(
      parseViewPoints([
        { from: 60, to: 90, content: '第一' },
        { from: 60.02, to: 120, content: '重复' },
        { from: 90, to: 120, content: '下一章' },
      ]),
    ).toEqual([
      { start: 60, end: 90, label: '第一', source: 'official' },
      { start: 90, end: 120, label: '下一章', source: 'official' },
    ])
    expect(parseViewPoints(undefined)).toEqual([])
    expect(parseViewPoints({})).toEqual([])
  })
})

describe('mergeChapterSources 双源合并', () => {
  const official = parseViewPoints([
    { from: 60, to: 300, content: '正片' },
  ])

  it('AI 边界落在官方去重窗（默认 20s）内丢弃；窗外保留并标注 ai 来源', () => {
    const ai: SummarySegment[] = [
      { start: 2, end: 60, label: '片头寒暄' }, // 片头窗（<5s）丢弃
      { start: 65, end: 200, label: '与官方 60s 仅差 5s' }, // 窗内丢弃
      { start: 200, end: 300, label: '中段拆解' }, // 窗外保留
    ]
    const merged = mergeChapterSources(official, ai)
    expect(merged).toEqual([
      { start: 60, end: 300, label: '正片', source: 'official' },
      { start: 200, end: 300, label: '中段拆解', source: 'ai' },
    ])
  })

  it('空标签/倒挂的 AI 分段丢弃；无官方章节时 AI 边界独立成条', () => {
    const ai: SummarySegment[] = [
      { start: 10, end: 0, label: '倒挂' },
      { start: 30, end: 60, label: '  ' },
      { start: 90, end: 120, label: '有效' },
    ]
    expect(mergeChapterSources([], ai)).toEqual([
      { start: 90, end: 120, label: '有效', source: 'ai' },
    ])
  })

  it('超过上限截断（保序保留前 N 个）', () => {
    const ai: SummarySegment[] = Array.from({ length: 10 }, (_unused, index) => ({
      start: 100 + index * 100,
      end: 200 + index * 100,
      label: `段${index}`,
    }))
    expect(mergeChapterSources([], ai, { max: 3 })).toHaveLength(3)
    expect(mergeChapterSources([], ai, { max: 3 })[0]).toMatchObject({ label: '段0' })
  })
})

describe('AI 时间线缓存', () => {
  const segments: SummarySegment[] = [
    { start: 0, end: 60, label: '开场' },
    { start: 60, end: 300, label: '正片' },
  ]

  it('写入后按 bvid:cid 读回；脏条目在归一化时丢弃', async () => {
    await writeChapterCache('BV1aa', 11, segments)
    const entry = await readChapterCache('BV1aa', 11)
    expect(entry).not.toBeNull()
    expect(entry?.segments).toEqual(segments)
    expect(entry?.bvid).toBe('BV1aa')

    // 同 bvid 不同 cid：互不串味。
    expect(await readChapterCache('BV1aa', 22)).toBeNull()
    // cid 缺失（页面状态未就绪）：不给缓存。
    expect(await readChapterCache('BV1aa', undefined)).toBeNull()
  })

  it('读侧防御：storage 里的脏形状（非对象/缺字段/空分段）整体丢弃', async () => {
    await chrome.storage.local.set({
      [CHAPTER_CACHE_STORAGE_KEY]: {
        'BV1bb:1': { bvid: 'BV1bb', cid: 1, segments: [], savedAt: 1 },
        'BV1bb:2': { cid: 2, segments, savedAt: 2 }, // 缺 bvid
        'BV1bb:3': 'garbage',
      },
    })
    expect(await readChapterCache('BV1bb', 1)).toBeNull()
    expect(await readChapterCache('BV1bb', 2)).toBeNull()
  })

  it('超上限按 savedAt 淘汰最旧（LRU）', async () => {
    for (let index = 0; index < CHAPTER_CACHE_LIMIT + 3; index += 1) {
      const raw = (await chrome.storage.local.get(CHAPTER_CACHE_STORAGE_KEY)) as Record<
        string,
        unknown
      >
      const map = (raw[CHAPTER_CACHE_STORAGE_KEY] ?? {}) as Record<string, unknown>
      map[chapterCacheKey(`BV1cc${index}`, index)] = {
        bvid: `BV1cc${index}`,
        cid: index,
        segments,
        savedAt: index, // 越小越旧
      }
      await chrome.storage.local.set({ [CHAPTER_CACHE_STORAGE_KEY]: map })
    }
    // writeChapterCache 走一次触发淘汰。
    await writeChapterCache('BV1final', 99, segments)
    const raw = (await chrome.storage.local.get(CHAPTER_CACHE_STORAGE_KEY)) as Record<
      string,
      unknown
    >
    const map = raw[CHAPTER_CACHE_STORAGE_KEY] as Record<string, unknown>
    expect(Object.keys(map).length).toBe(CHAPTER_CACHE_LIMIT)
    expect(map[chapterCacheKey('BV1cc0', 0)]).toBeUndefined() // 最旧的已被淘汰
    expect(map[chapterCacheKey('BV1final', 99)]).toBeDefined()
  })

  it('空分段不写缓存（避免占位脏数据）', async () => {
    await writeChapterCache('BV1dd', 1, [{ start: 1, end: 0, label: 'x' }])
    expect(await readChapterCache('BV1dd', 1)).toBeNull()
  })
})
