// 语料入参在向量路的真实接线（vector.test.ts 把 corpusContentHash mock 成了忽略入参的开关，
// 证明不了「传入不同语料 → 键变 → 重算」这条链，这里用真哈希补上）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatEndpoint } from '../llm/client'
import type { CorpusSignal } from './corpus'
import { AD_SIGNAL_CORPUS } from './corpus'
import type { SubtitleWindow } from './vector'
import { getCorpusVectors, rankWindowsByVector } from './vector'

const ENDPOINT: ChatEndpoint = { baseUrl: 'https://emb.example', model: 'emb-m', apiKey: '' }

const USER_SIGNAL: CorpusSignal = {
  text: '某新品牌',
  kind: 'brand',
  weight: 1,
  category: 'brands-digital',
}
const CORPUS_WITH_USER: CorpusSignal[] = [...AD_SIGNAL_CORPUS, USER_SIGNAL]

/** 记录每次 /embeddings 请求的 input，便于断言「向量化的是哪一份语料」。 */
function stubEmbeddings(): { calls: string[][] } {
  const calls: string[][] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const inputs = (JSON.parse(String(init?.body)) as { input: string[] }).input
      calls.push(inputs)
      return new Response(
        JSON.stringify({ data: inputs.map((_input, index) => ({ index, embedding: [1, 0, 0] })) }),
        { status: 200 },
      )
    }),
  )
  return { calls }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getCorpusVectors 的语料入参', () => {
  it('同一份语料命中缓存不重复请求；换一份语料即重算并向量化新语料', async () => {
    const { calls } = stubEmbeddings()

    const first = await getCorpusVectors(ENDPOINT, undefined, AD_SIGNAL_CORPUS)
    expect(first).toHaveLength(AD_SIGNAL_CORPUS.length)
    await getCorpusVectors(ENDPOINT, undefined, AD_SIGNAL_CORPUS)
    expect(calls).toHaveLength(1) // 缓存命中

    const second = await getCorpusVectors(ENDPOINT, undefined, CORPUS_WITH_USER)
    expect(calls).toHaveLength(2) // 语料哈希变 → 全量重算
    expect(second).toHaveLength(CORPUS_WITH_USER.length)
    // 重算向量化的是「传入的那份语料」，不是模块级内置常量。
    expect(calls[1]).toContain('某新品牌')
    expect(calls[0]).not.toContain('某新品牌')
  })

  it('缺省入参等价于内置词库（同键命中，不产生额外请求）', async () => {
    const { calls } = stubEmbeddings()
    await getCorpusVectors(ENDPOINT)
    await getCorpusVectors(ENDPOINT, undefined, AD_SIGNAL_CORPUS)
    expect(calls).toHaveLength(1)
  })
})

describe('rankWindowsByVector 把语料透传到向量路', () => {
  const windows: SubtitleWindow[] = [
    { index: 0, start: 0, end: 30, text: '这段提到某新品牌的冠名' },
    { index: 1, start: 30, end: 60, text: '完全无关的日常内容' },
  ]

  it('语料入参参与语料向量化（用户补录的词进了向量空间）', async () => {
    const { calls } = stubEmbeddings()
    await rankWindowsByVector(windows, { bvid: 'BV1user', cid: 7 }, ENDPOINT, undefined, CORPUS_WITH_USER)
    // 两批请求：语料 + 窗口；语料那批必须含用户词。
    expect(calls).toHaveLength(2)
    expect(calls.some((inputs) => inputs.includes('某新品牌'))).toBe(true)
  })
})

describe('旧语料向量键清理（配额只增不减会反噬写入）', () => {
  const CACHE_PREFIX = 'biliHelperRagVectorCache:'

  it('换语料重算后清掉别的端点/模型留下的旧键，保留同前缀与窗口键', async () => {
    stubEmbeddings()
    await chrome.storage.local.set({
      // 别的模型/端点留下的旧语料键：必须清掉（用户补录会让哈希高频变化，不清必然打满配额）。
      [`${CACHE_PREFIX}corpus:other-model:https://other:deadbeef`]: { vectors: [[1]] },
      [`${CACHE_PREFIX}corpus:emb-m:https://emb.example:oldhash0`]: { vectors: [[2]] },
      [`${CACHE_PREFIX}windows:BV1x:1:emb-m:https://emb.example`]: { vectors: [[3]], textHash: 'h' },
      unrelatedKey: 'keep-me',
    })

    await getCorpusVectors(ENDPOINT, undefined, CORPUS_WITH_USER)

    const keys = Object.keys(await chrome.storage.local.get(null)).sort()
    // 新键 + 同 model:baseUrl 前缀的旧哈希 + 窗口键 + 无关键；别的端点那条被清掉。
    expect(keys).toHaveLength(4)
    expect(keys.filter((key) => key.startsWith(`${CACHE_PREFIX}corpus:`))).toHaveLength(2)
    expect(keys).toContain(`${CACHE_PREFIX}corpus:emb-m:https://emb.example:oldhash0`)
    expect(keys).toContain(`${CACHE_PREFIX}windows:BV1x:1:emb-m:https://emb.example`)
    expect(keys).toContain('unrelatedKey')
    expect(keys.some((key) => key.includes('other-model'))).toBe(false)
  })

  it('缓存命中时不触发清理（没有新键写入就不动别人的缓存）', async () => {
    stubEmbeddings()
    await getCorpusVectors(ENDPOINT, undefined, AD_SIGNAL_CORPUS)
    await chrome.storage.local.set({
      [`${CACHE_PREFIX}corpus:other-model:https://other:deadbeef`]: { vectors: [[1]] },
    })

    await getCorpusVectors(ENDPOINT, undefined, AD_SIGNAL_CORPUS) // 命中缓存

    const all = await chrome.storage.local.get(null)
    expect(`${CACHE_PREFIX}corpus:other-model:https://other:deadbeef` in all).toBe(true)
  })
})
