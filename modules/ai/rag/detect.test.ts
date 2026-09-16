import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiSettings } from '../../settings'
import { DEFAULT_SETTINGS } from '../../settings'
import { AiError } from '../../shared/error'
import type { Subtitle } from '../../video/types'
import type { DetectAdsInput } from '../port'
import { tokenize } from './bm25'
import { FALLBACK_MAX_SEGMENT_SECONDS, runRagDetect } from './detect'

// 与语料一致的窗口：开头 bigram 与语料「恰饭时间」「本期视频由」重合 → 向量路必然召回。
// 以下填空行刻意避开语料词汇（含「游戏」这类品牌词里的字），保证只有恰饭窗口被召回。
const AD_SUBTITLES: Subtitle[] = [
  { start: 0, end: 10, text: '大家好，今天横评八款设备，先看外观' },
  { start: 12, end: 20, text: '第一款的设计语言很克制' },
  { start: 42, end: 50, text: '接下来是接口与拓展性' },
  { start: 122, end: 132, text: '先说性能释放，成绩很顶' },
  { start: 262, end: 272, text: '屏幕素质这次真的可以' },
  { start: 402, end: 412, text: '高负载实测帧率稳定' },
  { start: 492, end: 512, text: '恰饭时间到了，感谢本期视频由某某音乐App赞助播出' },
  { start: 512, end: 540, text: '今天给大家种草这款降噪耳机，评论区置顶有优惠券' },
  { start: 540, end: 580, text: '领券下单更划算，还能粉丝专属价' },
  { start: 590, end: 600, text: '好，我们回到正文' },
]

const NO_SIGNAL_SUBTITLES: Subtitle[] = [
  { start: 0, end: 10, text: '大家好，今天讲讲续航' },
  { start: 30, end: 40, text: '接下来看测试数据' },
]

// 刷屏噪声 + 孤立恰饭段：前 300 秒每 10 秒一句「恰饭」（窗口连成一片，合并后 >120s 巨段，
// 应被限长丢弃），492–580 是正常长度的恰饭段（应保留）。
const SPAM_THEN_AD_SUBTITLES: Subtitle[] = [
  ...Array.from({ length: 31 }, (_, i) => ({
    start: i * 10,
    end: i * 10 + 8,
    text: '恰饭时间到啦',
  })),
  { start: 492, end: 512, text: '恰饭时间到了，感谢本期视频由某某音乐App赞助播出' },
  { start: 512, end: 540, text: '今天给大家种草这款降噪耳机，评论区置顶有优惠券' },
  { start: 540, end: 580, text: '领券下单更划算，还能粉丝专属价' },
]

function makeSettings(overrides: Partial<AiSettings> = {}): AiSettings {
  return {
    ...DEFAULT_SETTINGS,
    apiUrl: 'https://llm.example/v1',
    model: 'm-1',
    apiKey: 'k-1',
    embedBaseUrl: 'https://emb.example',
    embedModel: 'emb-m',
    embedKey: '',
    ...overrides,
  }
}

function makeInput(
  subtitles: Subtitle[],
  danmaku: { time: number; text: string }[] = [],
  comments: { top?: { text: string } }[] = [],
): DetectAdsInput {
  return {
    video: { bvid: 'BV1xx411c7mD', cid: 1, title: '设备横评', duration: 600 },
    subtitles,
    danmaku,
    comments,
    strategy: 'smart',
  }
}

function completionResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
}

/**
 * 测试用确定性嵌入：只有出现在 EMBED_VOCAB 里的 token 才点亮对应维度（无哈希碰撞噪声），
 * 恰饭窗口与语料「恰饭时间」「本期视频由」余弦 ≥ 阈值，其余窗口全零向量 → 0 分。
 */
const EMBED_VOCAB = ['恰饭', '饭时', '时间', '本期', '期视', '视频', '频由']

function tokenEmbeddingResponse(inputs: string[]): Response {
  const embeddingOf = (text: string) => {
    const tokens = new Set(tokenize(text))
    const vec = EMBED_VOCAB.map((token) => (tokens.has(token) ? 1 : 0))
    const norm = Math.sqrt(vec.reduce<number>((sum, value) => sum + value * value, 0))
    return norm > 0 ? vec.map((value) => value / norm) : vec
  }
  return new Response(
    JSON.stringify({ data: inputs.map((input, index) => ({ index, embedding: embeddingOf(input) })) }),
    { status: 200 },
  )
}

function pipeFetch(handlers: {
  embeddings?: (inputs: string[]) => Response
  chat?: () => Response
}): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url)
    if (target.includes('/embeddings')) {
      const inputs = (JSON.parse(String(init?.body)) as { input: string[] }).input
      return handlers.embeddings?.(inputs) ?? new Response('{}', { status: 500 })
    }
    if (target.includes('/chat/completions')) {
      return handlers.chat?.() ?? new Response('{}', { status: 500 })
    }
    return new Response('{}', { status: 404 })
  })
}

const HAPPY_CHAT_BODY = JSON.stringify({
  ads: [{ start: 492, end: 580, product_name: '某音乐App', ad_content: '会员推广', confidence: 0.9 }],
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('runRagDetect（全链路）', () => {
  it('①混合检索：召回 → 小转大（±40 秒上下文，含弹幕/评论旁证）→ LLM 定界 → source:rag', async () => {
    const fetchMock = pipeFetch({
      embeddings: (inputs) => tokenEmbeddingResponse(inputs),
      chat: () => completionResponse(HAPPY_CHAT_BODY),
    })
    vi.stubGlobal('fetch', fetchMock)

    const input = makeInput(
      AD_SUBTITLES,
      [{ time: 520, text: '恰饭啦' }, { time: 5, text: '无关弹幕' }],
      [{ top: { text: '这波广告太明显了' } }],
    )
    const result = await runRagDetect(input, makeSettings(), {})
    expect(result.source).toBe('rag')
    expect(result.ads).toEqual([
      { start: 492, end: 580, product_name: '某音乐App', ad_content: '会员推广', confidence: 0.9 },
    ])

    // 定界只喂候选窗口：prompt 里带父级上下文字幕行（[08:12] 恰饭…），而不是全文；
    // 命中窗口 ±40s 内的弹幕与顶部评论文本作为旁证并入，无时间信息的评论整段附后。
    const chatBody = JSON.parse(String(fetchMock.mock.calls.find((c) => String(c[0]).includes('/chat/completions'))?.[1]?.body)) as {
      messages: { role: string; content: string }[]
    }
    const systemContent = chatBody.messages.find((m) => m.role === 'system')?.content ?? ''
    const userContent = chatBody.messages.find((m) => m.role === 'user')?.content ?? ''
    expect(systemContent).toContain('候选窗口')
    expect(systemContent).toContain('弹幕与评论只作旁证')
    expect(userContent).toContain('候选窗口 1')
    expect(userContent).toContain('[08:12] 恰饭时间到了')
    expect(userContent).not.toContain('[00:00] 大家好')
    expect(userContent).toContain('[520s] 恰饭啦')
    expect(userContent).not.toContain('无关弹幕')
    expect(userContent).toContain('这波广告太明显了')

    // 向量请求共两批（语料 + 窗口），同键第二次运行命中缓存不再请求。
    const embeddingCalls = () =>
      fetchMock.mock.calls.filter((call) => String(call[0]).includes('/embeddings')).length
    expect(embeddingCalls()).toBe(2)
    await runRagDetect(makeInput(AD_SUBTITLES), makeSettings(), {})
    expect(embeddingCalls()).toBe(2)
  })

  it('②/embeddings 不可用：退纯词表仍返回 ads，降级提示只触发一次', async () => {
    const fetchMock = pipeFetch({
      embeddings: () => new Response('{}', { status: 500 }),
      chat: () => completionResponse(HAPPY_CHAT_BODY),
    })
    vi.stubGlobal('fetch', fetchMock)
    const onVectorFallback = vi.fn()

    const result = await runRagDetect(makeInput(AD_SUBTITLES), makeSettings(), { onVectorFallback })
    expect(result.source).toBe('rag')
    expect(result.ads[0]).toMatchObject({ start: 492, end: 580 })
    expect(onVectorFallback).toHaveBeenCalledTimes(1)
  })

  it('③纯词表无命中且字幕可用：LLM 全文兜底，source:llm', async () => {
    const fetchMock = pipeFetch({
      embeddings: (inputs) => tokenEmbeddingResponse(inputs),
      chat: () =>
        completionResponse(
          JSON.stringify({ ads: [{ start: 30, end: 40, product_name: 'X', ad_content: 'y', confidence: 0.6 }] }),
        ),
    })
    vi.stubGlobal('fetch', fetchMock)
    const onVectorFallback = vi.fn()

    const result = await runRagDetect(makeInput(NO_SIGNAL_SUBTITLES), makeSettings(), { onVectorFallback })
    expect(result.source).toBe('llm')
    expect(result.ads).toEqual([{ start: 30, end: 40, product_name: 'X', ad_content: 'y', confidence: 0.6 }])
    expect(onVectorFallback).not.toHaveBeenCalled()
  })

  it('③全文兜底解析失败/无片段：{ads:[], source:"none"}', async () => {
    const fetchMock = pipeFetch({
      embeddings: (inputs) => tokenEmbeddingResponse(inputs),
      chat: () => completionResponse('这段字幕我没有什么好说的。'),
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await runRagDetect(makeInput(NO_SIGNAL_SUBTITLES), makeSettings(), {})
    expect(result).toEqual({ ads: [], source: 'none' })
  })

  it('④无字幕/全部不可用：{ads:[], source:"none"}，不发请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await runRagDetect(makeInput([]), makeSettings(), {})
    expect(result).toEqual({ ads: [], source: 'none' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('端点全未配置：抛 AiError(config)，且不发任何请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      runRagDetect(
        makeInput(AD_SUBTITLES),
        makeSettings({ apiUrl: '', model: '', embedBaseUrl: '', embedModel: '' }),
        {},
      ),
    ).rejects.toMatchObject({ kind: 'config', message: /至少配一个/ })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('极速匹配：只配向量端点（对话未配置）→ 命中窗口成段、product_name 取命中语料词、零对话调用', async () => {
    const fetchMock = pipeFetch({ embeddings: tokenEmbeddingResponse })
    vi.stubGlobal('fetch', fetchMock)
    const result = await runRagDetect(
      makeInput(AD_SUBTITLES),
      makeSettings({ apiUrl: '', model: '' }),
      {},
    )
    expect(result.source).toBe('rag')
    expect(result.ads.length).toBeGreaterThan(0)
    // 置信度保守封顶（极速模式明确低于 LLM 定界的可信度）。
    for (const ad of result.ads) expect(ad.confidence).toBeLessThanOrEqual(0.6)
    // product_name 来自窗口内精确命中的语料短语。
    const names = result.ads.flatMap((ad) => ad.product_name.split('、')).filter(Boolean)
    expect(names.some((name) => name.includes('恰饭') || name.includes('赞助'))).toBe(true)
    // 零对话调用：请求只有 /embeddings。
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0)
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain('/embeddings')
    }
  })

  it('极速模式无命中：{ads:[], source:"none"}，不触发 LLM 全文兜底', async () => {
    const fetchMock = pipeFetch({ embeddings: tokenEmbeddingResponse })
    vi.stubGlobal('fetch', fetchMock)
    const result = await runRagDetect(
      makeInput(NO_SIGNAL_SUBTITLES),
      makeSettings({ apiUrl: '', model: '' }),
      {},
    )
    expect(result).toEqual({ ads: [], source: 'none' })
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0)
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain('/embeddings')
    }
  })

  it('对话端点调用失败：onRetrievalOnly 触发一次，退回召回窗口（极速匹配收尾）', async () => {
    const fetchMock = pipeFetch({
      embeddings: tokenEmbeddingResponse,
      chat: () => new Response('{}', { status: 500 }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const onRetrievalOnly = vi.fn()
    const result = await runRagDetect(makeInput(AD_SUBTITLES), makeSettings(), { onRetrievalOnly })
    expect(result.source).toBe('rag')
    expect(result.ads.length).toBeGreaterThan(0)
    expect(onRetrievalOnly).toHaveBeenCalledTimes(1)
  })

  it('兜底段限长：刷屏词合并出的巨段（>120s）整段丢弃，孤立正常段保留', async () => {
    const fetchMock = pipeFetch({ embeddings: tokenEmbeddingResponse })
    vi.stubGlobal('fetch', fetchMock)
    const result = await runRagDetect(
      makeInput(SPAM_THEN_AD_SUBTITLES),
      makeSettings({ apiUrl: '', model: '' }),
      {},
    )
    expect(result.source).toBe('rag')
    for (const ad of result.ads) {
      expect(ad.end - ad.start).toBeLessThanOrEqual(FALLBACK_MAX_SEGMENT_SECONDS)
    }
    // 492–580 的恰饭段没被巨段连坐。
    expect(result.ads.some((ad) => ad.start >= 450 && ad.end <= 600)).toBe(true)
  })

  it('兜底段限长：全片刷屏时不产出任何巨段标记', async () => {
    const fetchMock = pipeFetch({ embeddings: tokenEmbeddingResponse })
    vi.stubGlobal('fetch', fetchMock)
    const spamOnly = SPAM_THEN_AD_SUBTITLES.filter((line) => line.start <= 300)
    const result = await runRagDetect(makeInput(spamOnly), makeSettings({ apiUrl: '', model: '' }), {})
    expect(result).toEqual({ ads: [], source: 'rag' })
  })

  it('LLM 定界输出不可解析：宽松解析失败后退回召回窗口（留窗口不悬挂）', async () => {
    const fetchMock = pipeFetch({
      embeddings: (inputs) => tokenEmbeddingResponse(inputs),
      chat: () => completionResponse('抱歉，我无法判断哪些是广告。'),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await runRagDetect(makeInput(AD_SUBTITLES), makeSettings(), {})
    expect(result.source).toBe('rag')
    expect(result.ads.length).toBeGreaterThan(0)
    expect(result.ads[0]).toMatchObject({ start: 492, end: 580 })
    expect(result.ads[0]?.confidence).toBeGreaterThan(0)
  })

  it('LLM 排 JSON 但 gap≤2s 的相邻段合并为一段', async () => {
    const fetchMock = pipeFetch({
      embeddings: (inputs) => tokenEmbeddingResponse(inputs),
      chat: () =>
        completionResponse(
          JSON.stringify({
            ads: [
              { start: 492, end: 512, product_name: 'A', ad_content: 'x', confidence: 0.7 },
              { start: 513, end: 540, product_name: 'B', ad_content: 'y', confidence: 0.8 },
            ],
          }),
        ),
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await runRagDetect(makeInput(AD_SUBTITLES), makeSettings(), {})
    expect(result.ads).toEqual([{ start: 492, end: 540, product_name: 'A', ad_content: 'x；y', confidence: 0.8 }])
  })
})

describe('AiError 边界', () => {
  it('parse 永远不把非 AiError 之外的错误形状漏出', async () => {
    const fetchMock = pipeFetch({
      embeddings: () => {
        throw new AiError('auth', '401 未授权')
      },
      chat: () => completionResponse(HAPPY_CHAT_BODY),
    })
    vi.stubGlobal('fetch', fetchMock)
    // embeddings 抛错应被降级链吞掉：纯词表仍出结果。
    const onVectorFallback = vi.fn()
    const result = await runRagDetect(makeInput(AD_SUBTITLES), makeSettings(), { onVectorFallback })
    expect(result.source).toBe('rag')
    expect(onVectorFallback).toHaveBeenCalledTimes(1)
  })
})
describe('用户补录词条进入全链路（detect 用的是合并后的生效语料）', () => {
  // 这段字幕刻意避开内置词库与 EMBED_VOCAB：补录前词表路不命中、向量路零分。
  const USER_WORD_SUBTITLES: Subtitle[] = [
    { start: 0, end: 10, text: '大家好，今天讲讲续航' },
    { start: 300, end: 330, text: '然后说说某新品牌的日常表现' },
  ]
  const USER_WORD_AD_BODY = JSON.stringify({
    ads: [{ start: 300, end: 330, product_name: '某新品牌', ad_content: '口播', confidence: 0.8 }],
  })

  function corpusEmbeddingInputs(fetchMock: ReturnType<typeof vi.fn>): string[] {
    // 语料那批请求的特征：input 里含内置词条「恰饭」；窗口那批只含字幕文本。
    // 取最后一次：本用例跑了两轮检测，要看的始终是最新那份生效语料。
    const corpusCall = fetchMock.mock.calls
      .filter((call) => String(call[0]).includes('/embeddings'))
      .map((call) => (JSON.parse(String(call[1]?.body)) as { input: string[] }).input)
      .findLast((inputs) => inputs.includes('恰饭'))
    return corpusCall ?? []
  }

  it('补录前走全文兜底（source:llm），补录后词表路召回并定界（source:rag）', async () => {
    const fetchMock = pipeFetch({
      embeddings: (inputs) => tokenEmbeddingResponse(inputs),
      chat: () => completionResponse(USER_WORD_AD_BODY),
    })
    vi.stubGlobal('fetch', fetchMock)

    // 基线：用户层为空 → 两路都召回不到 → 降级到 LLM 全文兜底。
    const baseline = await runRagDetect(makeInput(USER_WORD_SUBTITLES), makeSettings(), {})
    expect(baseline.source).toBe('llm')
    expect(corpusEmbeddingInputs(fetchMock)).not.toContain('某新品牌')

    // 补录同一个词 → 生效语料含它 → 词表路召回，走完整 RAG 定界。
    await chrome.storage.local.set({
      biliHelperUserCorpus: [{ text: '某新品牌', category: 'brands-digital' }],
    })
    const after = await runRagDetect(makeInput(USER_WORD_SUBTITLES), makeSettings(), {})
    expect(after.source).toBe('rag')
    expect(after.ads).toEqual([
      { start: 300, end: 330, product_name: '某新品牌', ad_content: '口播', confidence: 0.8 },
    ])

    // 两路共用同一份合并语料：向量路请求的语料里也必须有用户词（否则只是词表路生效）。
    expect(corpusEmbeddingInputs(fetchMock)).toContain('某新品牌')
  })
})
