// 漏检补录的候选词提取：从指定时间范围的字幕文本里切出「可能是广告信号」的短语，
// 让用户从「猜词」变成「选词」。规则刻意保守：按标点/空白切分、长度 2-10 字、
// 去掉纯虚词与高频泛词，其余按出现顺序去重供挑选——宁可多给几个让用户划掉，
// 也不做激进的自动入库（污染精确匹配词表的代价是全库召回质量）。

import type { Subtitle } from '../video/types'

/** 整段等于这些泛词时直接丢弃（口语高频但无信号价值）。 */
const STOP_FRAGMENTS = new Set([
  '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '现在', '觉得', '知道',
  '真的', '可以', '没有', '东西', '时候', '大家', '一下', '这么', '那么', '还是',
  '就是', '但是', '因为', '所以', '如果', '虽然', '不过', '已经', '可能', '应该',
  '感觉', '开始', '继续', '回来', '出来', '看到', '说说', '讲讲', '不是', '还有',
  '这种', '那种', '自己', '今天', '明天', '昨天', '时候', '问题', '朋友', '兄弟',
])

/** 切分符：中英文标点与空白。 */
const SPLIT_PATTERN = /[，。！？、；：…～~,.!?;:\s"'"'（）()【】\[\]]+/u

export const MIN_CANDIDATE_LENGTH = 2
export const MAX_CANDIDATE_LENGTH = 10
export const MAX_CANDIDATES = 12

/**
 * 取 [start, end) 秒内字幕行的文本，切分出候选短语（去重保序、封顶 12 个）。
 * 与字幕行有交叠即纳入（广告话术常跨行）。
 */
export function extractCorpusCandidates(
  subtitles: readonly Subtitle[],
  start: number,
  end: number,
  limit: number = MAX_CANDIDATES,
): string[] {
  const texts: string[] = []
  for (const line of subtitles) {
    if (line.end > start && line.start < end) texts.push(line.text)
  }
  if (texts.length === 0) return []
  const seen = new Set<string>()
  const candidates: string[] = []
  for (const text of texts) {
    for (const raw of text.split(SPLIT_PATTERN)) {
      const fragment = raw.trim()
      if (
        fragment.length < MIN_CANDIDATE_LENGTH ||
        fragment.length > MAX_CANDIDATE_LENGTH ||
        STOP_FRAGMENTS.has(fragment) ||
        seen.has(fragment)
      ) {
        continue
      }
      seen.add(fragment)
      candidates.push(fragment)
      if (candidates.length >= limit) return candidates
    }
  }
  return candidates
}
