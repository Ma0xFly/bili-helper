import { describe, expect, it } from 'vitest'
import { corpusContentHash, corpusDocuments } from './corpus'
import { cjkBigrams, exactSignalMatches, rankWindowsByLexical, tokenize } from './bm25'

describe('tokenize（英文词 + 中文 bigram）', () => {
  it('英文按词、中文按 bigram 切分，混合文本各归各道', () => {
    expect(tokenize('iPhone 15 Pro 真香')).toEqual(
      expect.arrayContaining(['iphone', '15', 'pro', '真香']),
    )
    expect(tokenize('恰饭时间到了')).toEqual(['恰饭', '饭时', '时间', '间到', '到了'])
    // 中英邻接处按各自通道切分，无粘连 token。
    const tokens = tokenize('OPPO手机618大促')
    expect(tokens).toEqual(expect.arrayContaining(['oppo', '618']))
    expect(tokens.some((t) => /[\u4e00-\u9fff]/.test(t))).toBe(true)
  })

  it('cjkBigrams 单字原样保留', () => {
    expect(cjkBigrams('恰')).toEqual(['恰'])
  })
})

describe('词表精确匹配', () => {
  it('语料短语原样出现即命中（含多重命中）', () => {
    const hits = exactSignalMatches('本期视频由某音乐App赞助播出，恰饭时间到了，评论区置顶有优惠券')
    expect(hits.has('本期视频由')).toBe(true)
    expect(hits.has('恰饭时间')).toBe(true)
    expect(hits.has('优惠券')).toBe(true)
  })

  it('无信号文本零命中', () => {
    expect(exactSignalMatches('今天天气不错，出门散步')).toEqual(new Set())
  })
})

describe('rankWindowsByLexical（召回第一路）', () => {
  const windows = [
    { text: '大家好，今天横评八款耳机，先看外观' },
    { text: '这一代的声音表现出乎意料，声场开阔' },
    { text: '感谢本期视频由某某音乐App赞助播出，恰饭时间到了' },
    { text: '接下来看看续航测试，成绩如下' },
  ]

  it('恰饭窗口得分最高排第一，无信号窗口被排除', () => {
    const ranked = rankWindowsByLexical(windows)
    expect(ranked[0]?.index).toBe(2)
    expect(ranked[0]?.score).toBeGreaterThan(0)
    expect(ranked.map((item) => item.index)).not.toContain(1)
  })

  it('空窗口集返回空排名', () => {
    expect(rankWindowsByLexical([])).toEqual([])
  })
})

describe('语料库与内容哈希', () => {
  it('语料文档非空且哈希确定', () => {
    expect(corpusDocuments().length).toBeGreaterThan(20)
    expect(corpusContentHash()).toBe(corpusContentHash())
    expect(corpusContentHash()).toMatch(/^[0-9a-f]{8}$/)
  })
})