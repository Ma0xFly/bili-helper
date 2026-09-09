import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Subtitle } from '../../video/types'
import type { ChatEndpoint } from '../llm/client'
import { corpusVectorKey, pruneStaleWindowVectors, readVectors, windowVectorKey } from './cache'
import { corpusDocuments } from './corpus'
import {
  cosineSimilarity,
  chunkSubtitleWindows,
  getCorpusVectors,
  getWindowVectors,
  rankWindowsByVector,
} from './vector'

// 语料哈希注入：hash 变化 = 语料版本变化，向量缓存必须全量重算。
const state = vi.hoisted(() => ({ hash: 'hash-a' }))
vi.mock('./corpus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./corpus')>()
  return { ...actual, corpusContentHash: () => state.hash }
})

const ENDPOINT: ChatEndpoint = { baseUrl: 'https://emb.example', model: 'emb-m', apiKey: '' }

function embeddingResponse(inputs: string[]): Response {
  return new Response(
    JSON.stringify({ data: inputs.map((_input, index) => ({ index, embedding: [1, 0, 0] })) }),
    { status: 200 },
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('chunkSubtitleWindows（30 秒窗口切块）', () => {
  it('按约 30 秒贪心装窗，跨窗线开新窗', () => {
    const subtitles: Subtitle[] = [
      { start: 0, end: 10, text: '第一窗' },
      { start: 12, end: 25, text: '还在第一窗' },
      { start: 29, end: 33, text: '越界开新窗' },
      { start: 60, end: 70, text: '第三窗' },
    ]
    const windows = chunkSubtitleWindows(subtitles)
    expect(windows.map((window) => window.index)).toEqual([0, 1, 2])
    expect(windows[0]).toMatchObject({ start: 0, end: 25, text: '第一窗 还在第一窗' })
    expect(windows[1]).toMatchObject({ start: 29, end: 33 })
    expect(windows[2]).toMatchObject({ start: 60, end: 70 })
  })

  it('单行超长文本独立成窗，不撑爆后续窗口', () => {
    const subtitles: Subtitle[] = [
      { start: 0, end: 1, text: '长'.repeat(500) },
      { start: 2, end: 3, text: '后一行' },
    ]
    const windows = chunkSubtitleWindows(subtitles)
    expect(windows.length).toBe(2)
    expect(windows[1]?.text).toBe('后一行')
  })

  it('空字幕出空窗口', () => {
    expect(chunkSubtitleWindows([])).toEqual([])
  })
})

describe('cosineSimilarity', () => {
  it('同向量余弦为 1、正交为 0', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0)
  })

  it('零向量得 0 不抛 NaN', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })
})

describe('语料向量缓存失效（模型/baseUrl/语料哈希任一变化全量重算）', () => {
  it('同键命中缓存不再请求；三个键成分各自变化都触发重算', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const inputs = (JSON.parse(String(init?.body)) as { input: string[] }).input
      return embeddingResponse(inputs)
    })
    vi.stubGlobal('fetch', fetchMock)

    state.hash = 'hash-a'
    const first = await getCorpusVectors(ENDPOINT)
    expect(first.length).toBe(corpusDocuments().length)
    const calls = () => fetchMock.mock.calls.length

    await getCorpusVectors(ENDPOINT) // 缓存命中
    expect(calls()).toBe(1)

    await getCorpusVectors({ ...ENDPOINT, baseUrl: 'https://emb2.example' }) // baseUrl 变
    expect(calls()).toBe(2)

    await getCorpusVectors({ ...ENDPOINT, model: 'emb-m2' }) // 模型变
    expect(calls()).toBe(3)

    state.hash = 'hash-b' // 语料内容哈希变
    await getCorpusVectors(ENDPOINT)
    expect(calls()).toBe(4)
  })

  it('缓存键由 模型+baseUrl+语料哈希 / bvid:cid+模型+baseUrl 拼接', () => {
    expect(
      corpusVectorKey({ model: 'm', baseUrl: 'https://b', corpusHash: 'hash-a' }),
    ).toBe('corpus:m:https://b:hash-a')
    expect(
      windowVectorKey({ videoKey: 'BV1:1', model: 'm', baseUrl: 'https://b' }),
    ).toBe('windows:BV1:1:m:https://b')
  })
})

describe('rankWindowsByVector（召回第二路）', () => {
  it('与语料向量相似的窗口得分高，低于门槛的窗口被滤掉', async () => {
    // 确定性嵌入：恰饭词表内的 token 才点亮维度（无哈希碰撞噪声）。
    const VOCAB = ['恰饭', '饭时', '时间']
    const embeddingOf = (text: string) => {
      const vec = VOCAB.map((token) => (text.includes(token) ? 1 : 0))
      const norm = Math.sqrt(vec.reduce<number>((sum, value) => sum + value * value, 0))
      return norm > 0 ? vec.map((value) => value / norm) : vec
    }
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] }
      const embeddings = body.input.map(embeddingOf)
      return new Response(
        JSON.stringify({ data: embeddings.map((embedding, index) => ({ index, embedding })) }),
        { status: 200 },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const subtitles: Subtitle[] = [
      { start: 0, end: 10, text: '大家好' },
      { start: 40, end: 70, text: '恰饭时间到了，感谢赞助' },
      { start: 70, end: 90, text: '性能测试' },
    ]
    const windows = chunkSubtitleWindows(subtitles)
    const ranked = await rankWindowsByVector(windows, { bvid: 'BV1', cid: 1 }, ENDPOINT)
    expect(ranked[0]?.index).toBe(1)
    expect(ranked[0]?.score).toBeGreaterThanOrEqual(0.35)
    expect(ranked.map((item) => item.index)).not.toContain(0)
  })

  it('空窗口集直接空结果，不发向量请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const ranked = await rankWindowsByVector([], { bvid: 'BV1', cid: 1 }, ENDPOINT)
    expect(ranked).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('窗口缓存：文本哈希命中判定与换视频清旧', () => {
  function countingFetch(): ReturnType<typeof vi.fn> {
    return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const inputs = (JSON.parse(String(init?.body)) as { input: string[] }).input
      return new Response(
        JSON.stringify({ data: inputs.map((_input, index) => ({ index, embedding: [1, 0] })) }),
        { status: 200 },
      )
    })
  }

  it('同字幕同键命中缓存；字幕切块内容变化（文本哈希不一致）→ 全量重算', async () => {
    const fetchMock = countingFetch()
    vi.stubGlobal('fetch', fetchMock)

    const windows = chunkSubtitleWindows([{ start: 0, end: 5, text: '恰饭' }])
    await getWindowVectors(windows, 'BV1:1', ENDPOINT)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await getWindowVectors(windows, 'BV1:1', ENDPOINT) // 同文本：命中
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // 字幕修正：窗口文本变了 → 哈希不匹配 → 重算。
    const corrected = chunkSubtitleWindows([{ start: 0, end: 5, text: '修正后的恰饭' }])
    await getWindowVectors(corrected, 'BV1:1', ENDPOINT)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('换视频 prune：清掉旧视频窗口键、保留当前视频键', async () => {
    const fetchMock = countingFetch()
    vi.stubGlobal('fetch', fetchMock)

    const windows = chunkSubtitleWindows([{ start: 0, end: 5, text: '恰饭' }])
    await getWindowVectors(windows, 'BV1:1', ENDPOINT)
    const oldKey = windowVectorKey({ videoKey: 'BV1:1', model: ENDPOINT.model, baseUrl: ENDPOINT.baseUrl })
    expect(await readVectors(oldKey)).not.toBeNull()

    await pruneStaleWindowVectors('BV1:1') // 仍是当前视频：保留
    expect(await readVectors(oldKey)).not.toBeNull()

    await pruneStaleWindowVectors('BV2:2') // 已换视频：清除
    expect(await readVectors(oldKey)).toBeNull()
  })

  it('rankWindowsByVector 自带 prune 调用点：换视频后旧键被清', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const inputs = (JSON.parse(String(init?.body)) as { input: string[] }).input
      return new Response(
        JSON.stringify({ data: inputs.map((_input, index) => ({ index, embedding: [1, 0] })) }),
        { status: 200 },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const windows = chunkSubtitleWindows([{ start: 0, end: 5, text: '恰饭' }])
    await getWindowVectors(windows, 'BV1:1', ENDPOINT)
    const oldKey = windowVectorKey({ videoKey: 'BV1:1', model: ENDPOINT.model, baseUrl: ENDPOINT.baseUrl })
    expect(await readVectors(oldKey)).not.toBeNull()

    await rankWindowsByVector(windows, { bvid: 'BV2', cid: 2 }, ENDPOINT)
    expect(await readVectors(oldKey)).toBeNull()
  })
})