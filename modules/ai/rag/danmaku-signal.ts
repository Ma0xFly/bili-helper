// 弹幕信号召回（第三路）：观众在广告段的自发弹幕（「广告」「恰饭」「跳过」）是极强且
// 抗 ASR 噪声的信号——字幕把「国补」写成「国博」时，弹幕仍然会刷「广告」。
// 纯词表计算零成本：窗口内命中信号弹幕 ≥2 条才进入排名（单条零散弹幕防误伤），
// 排名并入 RRF 融合；词表/向量两路全空时它还能独撑召回。
// 附带无字幕兜底：字幕缺失的视频（无 ASR/未上传）用弹幕自建窗口，检测退而不亡。

import type { CorpusSignal } from './corpus'
import { MAX_WINDOW_CHARS, WINDOW_SECONDS, type SubtitleWindow } from './vector'
import type { Danmaku } from '../../video/types'

/** 弹幕元信号词：与广告语料无关的观众黑话，命中即强信号。 */
export const DANMAKU_AD_TERMS: readonly string[] = [
  '广告',
  '恰饭',
  '广子',
  '赞助',
  '商单',
  '跳过',
  '植入',
  '带货',
  '硬广',
  '软广',
  '推广',
  '前方高能广告',
]

/** 窗口进入排名的最少命中弹幕数：一条孤零零的「广告」可能只是在聊视频内容。 */
export const MIN_DANMAKU_HITS = 2

export interface DanmakuRankedWindow {
  /** 对应 windows 数组下标。 */
  index: number
  score: number
}

/**
 * 弹幕信号扫描：时间指针扫一遍弹幕（两侧都已排序），每条弹幕只落进它所属的窗口。
 * 元信号词命中 +2 分，语料短语命中 +weight；返回每窗的命中条数与分数。
 * 排名与「双源强一致」判定共用这一份扫描，避免两处口径漂移。
 */
function scanDanmakuWindows(
  windows: readonly SubtitleWindow[],
  danmaku: readonly Danmaku[],
  corpus: readonly CorpusSignal[],
): { hits: number[]; distinct: number[]; scores: number[] } {
  const hits = new Array<number>(windows.length).fill(0)
  const distinct = new Array<number>(windows.length).fill(0)
  const scores = new Array<number>(windows.length).fill(0)
  const seen = new Array<Set<string> | undefined>(windows.length).fill(undefined)
  if (windows.length === 0 || danmaku.length === 0) return { hits, distinct, scores }
  const sorted = [...danmaku].sort((a, b) => a.time - b.time)
  let cursor = 0
  for (const item of sorted) {
    // 指针推进到包含该弹幕时刻的窗口（窗口按时间有序且不重叠）。
    while (cursor < windows.length && (windows[cursor] as SubtitleWindow).end <= item.time) cursor += 1
    if (cursor >= windows.length) break
    const window = windows[cursor] as SubtitleWindow
    if (item.time < window.start) continue
    const text = item.text
    let score = 0
    for (const term of DANMAKU_AD_TERMS) {
      if (text.includes(term)) {
        score += 2
        break
      }
    }
    if (score === 0) {
      for (const signal of corpus) {
        if (signal.text.length >= 2 && text.includes(signal.text)) {
          score += signal.weight
          break
        }
      }
    }
    if (score > 0) {
      hits[cursor] = (hits[cursor] ?? 0) + 1
      scores[cursor] = (scores[cursor] ?? 0) + score
      // 去重计数：同一条弹幕刷屏（「广告」「广告」「广告」）不该等价于多人指认。
      const bucket = seen[cursor] ?? new Set<string>()
      seen[cursor] = bucket
      bucket.add(text.trim())
      distinct[cursor] = bucket.size
    }
  }
  return { hits, distinct, scores }
}

/** 窗口级弹幕命中条数（与排名同一判定）：双源强一致免 LLM 用。 */
export function danmakuHitCounts(
  windows: readonly SubtitleWindow[],
  danmaku: readonly Danmaku[],
  corpus: readonly CorpusSignal[],
): number[] {
  return scanDanmakuWindows(windows, danmaku, corpus).hits
}

/** 窗口级弹幕命中**去重文本**数：同句刷屏只算一次，作为「多人在指认」的代理信号。 */
export function danmakuDistinctHitCounts(
  windows: readonly SubtitleWindow[],
  danmaku: readonly Danmaku[],
  corpus: readonly CorpusSignal[],
): number[] {
  return scanDanmakuWindows(windows, danmaku, corpus).distinct
}

/**
 * 弹幕信号排名：命中条数过门槛后以分数降序。
 */
export function rankWindowsByDanmaku(
  windows: readonly SubtitleWindow[],
  danmaku: readonly Danmaku[],
  corpus: readonly CorpusSignal[],
): DanmakuRankedWindow[] {
  const { hits, scores } = scanDanmakuWindows(windows, danmaku, corpus)
  const ranked: DanmakuRankedWindow[] = []
  for (let index = 0; index < windows.length; index += 1) {
    if ((hits[index] ?? 0) >= MIN_DANMAKU_HITS) {
      ranked.push({ index: (windows[index] as SubtitleWindow).index, score: scores[index] ?? 0 })
    }
  }
  ranked.sort((a, b) => b.score - a.score || a.index - b.index)
  return ranked
}

/**
 * 无字幕兜底建窗：把弹幕按时间装进 30 秒窗口（与字幕窗口同形状），
 * 文本 = 窗口内弹幕拼接（截到 MAX_WINDOW_CHARS）——词表/向量/LLM 定界都能直接消费。
 */
export function chunkDanmakuWindows(
  danmaku: readonly Danmaku[],
  windowSeconds: number = WINDOW_SECONDS,
  maxChars: number = MAX_WINDOW_CHARS,
): SubtitleWindow[] {
  if (danmaku.length === 0) return []
  const sorted = [...danmaku].sort((a, b) => a.time - b.time)
  const windows: SubtitleWindow[] = []
  let start = Math.max(0, Math.floor((sorted[0] as Danmaku).time))
  let parts: string[] = []
  let chars = 0
  const seal = (end: number): void => {
    if (parts.length > 0) {
      windows.push({ index: windows.length, start, end, text: parts.join(' ').slice(0, maxChars) })
    }
    parts = []
    chars = 0
    start = end
  }
  for (const item of sorted) {
    if (item.time >= start + windowSeconds) seal(Math.floor(item.time))
    if (item.time < start) continue
    if (chars < maxChars) {
      parts.push(item.text)
      chars += item.text.length
    }
  }
  const last = sorted[sorted.length - 1] as Danmaku
  seal(Math.max(start + 1, Math.ceil(last.time)))
  return windows
}
