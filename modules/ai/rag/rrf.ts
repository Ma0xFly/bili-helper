// 融合层：两路排名 RRF 融合（k=60）去重出候选窗口。
// 每个窗口的融合分 = Σ 1 / (k + 名次 + 1)，名次 1 起算；同分按窗口顺序稳定排序。

export const RRF_K = 60

export interface RrfRankedWindow {
  /** 窗口下标（对应召回层的窗口数组顺序）。 */
  index: number
  /** RRF 融合分，仅用于排序/置信度参考。 */
  score: number
}

/**
 * 输入各路已去重、已按得分降序的窗口下标序列，输出融合排名。
 * 只出现在一路里的窗口也会保留（该路名次折算的融合分）。
 */
export function rrfFuse(rankings: number[][], k: number = RRF_K): RrfRankedWindow[] {
  const fused = new Map<number, number>()
  for (const ranking of rankings) {
    for (let rank = 0; rank < ranking.length; rank += 1) {
      const index = ranking[rank]
      if (index === undefined) continue
      fused.set(index, (fused.get(index) ?? 0) + 1 / (k + rank + 1))
    }
  }
  return [...fused.entries()]
    .map(([index, score]) => ({ index, score }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
}