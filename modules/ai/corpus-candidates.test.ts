import { describe, expect, it } from 'vitest'
import { extractCorpusCandidates } from './corpus-candidates'
import type { Subtitle } from '../video/types'

const SUBS: Subtitle[] = [
  { start: 350, end: 360, text: '好在已经入手了，床铺除螨工具' },
  { start: 360, end: 375, text: '飓风吸力，强力拍打' },
  { start: 375, end: 390, text: '现在限时国博优惠，评论区链接下单' },
  { start: 500, end: 510, text: '这段在范围外，不该出现' },
]

describe('extractCorpusCandidates（漏检补录候选词）', () => {
  it('按标点切分、只取时间范围内的行、去重保序', () => {
    const candidates = extractCorpusCandidates(SUBS, 345, 395)
    expect(candidates).toContain('好在已经入手了')
    expect(candidates).toContain('床铺除螨工具')
    expect(candidates).toContain('飓风吸力')
    expect(candidates).toContain('现在限时国博优惠')
    expect(candidates).toContain('评论区链接下单')
    expect(candidates.some((c) => c.includes('范围外'))).toBe(false)
  })

  it('超长片段整段丢弃（信号是短语不是句子）', () => {
    const long: Subtitle[] = [{ start: 0, end: 5, text: '羊妈推荐你的床铺除螨工具' }]
    expect(extractCorpusCandidates(long, 0, 10)).toEqual([])
  })

  it('泛词整段丢弃、超长段丢弃、封顶 12 个', () => {
    const noisy: Subtitle[] = [
      { start: 0, end: 5, text: '我们，这个，什么，现在' },
      { start: 5, end: 10, text: '一二三四五六七八九十十一' },
      ...Array.from({ length: 20 }, (_, i) => ({ start: 10 + i, end: 11 + i, text: `信号词${i}号` })),
    ]
    const candidates = extractCorpusCandidates(noisy, 0, 100)
    expect(candidates).not.toContain('我们')
    expect(candidates).not.toContain('这个')
    expect(candidates.every((c) => c.length <= 10)).toBe(true)
    expect(candidates.length).toBeLessThanOrEqual(12)
  })

  it('范围无字幕回空数组', () => {
    expect(extractCorpusCandidates(SUBS, 0, 10)).toEqual([])
    expect(extractCorpusCandidates([], 0, 100)).toEqual([])
  })
})
