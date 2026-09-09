import { describe, expect, it } from 'vitest'
import { rrfFuse, RRF_K } from './rrf'

describe('rrfFuse（RRF 融合，k=60）', () => {
  it('两路都命中同一窗口得分更高，排在最前', () => {
    const fused = rrfFuse([
      [5, 3, 1],
      [5, 8],
    ])
    expect(fused[0]?.index).toBe(5)
    // 双路第一名的融合分 = 2 / (60 + 1)。
    expect(fused[0]?.score).toBeCloseTo(2 / (RRF_K + 1))
  })

  it('只出现在一路的窗口同样保留，按其名次折算分', () => {
    const fused = rrfFuse([[9, 4], []])
    expect(fused.map((item) => item.index)).toEqual([9, 4])
    expect(fused[0]?.score).toBeCloseTo(1 / (RRF_K + 1))
  })

  it('同名次并列按窗口下标稳定排序', () => {
    const fused = rrfFuse([
      [2, 5],
      [2, 5],
    ])
    expect(fused.map((item) => item.index)).toEqual([2, 5])
  })

  it('空输入出空结果', () => {
    expect(rrfFuse([])).toEqual([])
  })
})