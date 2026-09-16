// 弹幕信号召回（第三路）与无字幕兜底建窗的单测。
import { describe, expect, it } from 'vitest'
import {
  DANMAKU_AD_TERMS,
  MIN_DANMAKU_HITS,
  chunkDanmakuWindows,
  rankWindowsByDanmaku,
} from './danmaku-signal'
import type { SubtitleWindow } from './vector'
import type { Danmaku } from '../../video/types'
import type { CorpusSignal } from './corpus'

const CORPUS: CorpusSignal[] = [
  { text: '除螨仪', kind: 'brand', weight: 1, category: 'brands-appliance' },
  { text: '恰饭', kind: 'script', weight: 2, category: 'scripts' },
]

function windowOf(index: number, start: number, end: number): SubtitleWindow {
  return { index, start, end, text: `窗口${index}` }
}

const WINDOWS: SubtitleWindow[] = [windowOf(0, 0, 30), windowOf(1, 30, 60), windowOf(2, 60, 90)]

describe('rankWindowsByDanmaku（弹幕信号召回）', () => {
  it('窗口内 ≥2 条信号弹幕才进入排名；元信号词 +2 分', () => {
    const danmaku: Danmaku[] = [
      { time: 31, text: '广告来了' },
      { time: 35, text: '恰饭时间' },
      { time: 61, text: '跳过' }, // 窗口2 只有 1 条 → 不过门槛
      { time: 5, text: '哈哈哈' }, // 窗口0 无信号
    ]
    const ranked = rankWindowsByDanmaku(WINDOWS, danmaku, CORPUS)
    expect(ranked).toEqual([{ index: 1, score: 4 }])
    expect(MIN_DANMAKU_HITS).toBe(2)
  })

  it('语料短语命中按 weight 计分（品牌词进弹幕也能召回）', () => {
    const danmaku: Danmaku[] = [
      { time: 61, text: 'UWANT除螨仪好用吗' },
      { time: 62, text: '除螨仪多少钱' },
    ]
    const ranked = rankWindowsByDanmaku(WINDOWS, danmaku, CORPUS)
    expect(ranked).toEqual([{ index: 2, score: 2 }])
  })

  it('多窗口按分数降序；空输入回空', () => {
    const danmaku: Danmaku[] = [
      { time: 1, text: '广告' }, { time: 2, text: '广告' }, { time: 3, text: '广告' },
      { time: 31, text: '恰饭' }, { time: 32, text: '恰饭' },
    ]
    const ranked = rankWindowsByDanmaku(WINDOWS, danmaku, CORPUS)
    expect(ranked.map((item) => item.index)).toEqual([0, 1])
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score)
    expect(rankWindowsByDanmaku([], danmaku, CORPUS)).toEqual([])
    expect(rankWindowsByDanmaku(WINDOWS, [], CORPUS)).toEqual([])
  })

  it('弹幕乱序也能正确归窗（内部排序）', () => {
    const danmaku: Danmaku[] = [
      { time: 35, text: '广告' },
      { time: 31, text: '广告' },
    ]
    expect(rankWindowsByDanmaku(WINDOWS, danmaku, CORPUS)).toEqual([{ index: 1, score: 4 }])
  })

  it('元信号词表覆盖观众常用黑话', () => {
    for (const term of ['广告', '恰饭', '跳过', '赞助']) {
      expect(DANMAKU_AD_TERMS).toContain(term)
    }
  })
})

describe('chunkDanmakuWindows（无字幕兜底建窗）', () => {
  it('按 30 秒装窗，文本为弹幕拼接；窗口 index 递增', () => {
    const danmaku: Danmaku[] = [
      { time: 5, text: '开场' },
      { time: 29, text: '还在第一段' },
      { time: 31, text: '广告' },
      { time: 95, text: '结尾' },
    ]
    const windows = chunkDanmakuWindows(danmaku)
    expect(windows.length).toBeGreaterThanOrEqual(2)
    expect(windows[0]).toMatchObject({ index: 0, start: 5 })
    expect(windows[0]!.text).toContain('开场')
    expect(windows.every((w) => w.text !== '')).toBe(true)
    expect(windows.map((w) => w.index)).toEqual(windows.map((_, i) => i))
  })

  it('空弹幕回空数组；超长文本截到上限', () => {
    expect(chunkDanmakuWindows([])).toEqual([])
    const many: Danmaku[] = Array.from({ length: 200 }, (_, i) => ({ time: i * 0.1, text: '哈哈哈哈哈哈' }))
    const windows = chunkDanmakuWindows(many)
    expect(windows.every((w) => w.text.length <= 400)).toBe(true)
  })
})
