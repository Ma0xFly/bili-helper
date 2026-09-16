import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAiSettings, writeAiSettings, type AiSettings } from '../../settings'
import type { AiChatEvent, AiContext } from '../port'
import { resolveBackend } from './resolve'

const CONTEXT: AiContext = {
  video: { bvid: 'BV1xx411c7mD', cid: 1, title: '测试视频', duration: 600 },
  subtitles: [{ start: 0, end: 10, text: '大家好' }],
  danmaku: [],
  comments: [],
}

const SUMMARIZE_INPUT = { video: CONTEXT.video, subtitles: CONTEXT.subtitles, danmaku: CONTEXT.danmaku }

async function settingsOf(mode: AiSettings['mode']): Promise<AiSettings> {
  await writeAiSettings({
    apiUrl: 'https://llm.example/v1',
    model: 'm-1',
    apiKey: 'k-1',
    serverBaseUrl: 'https://srv.example',
    serverToken: 'tok-1',
    mode,
  })
  return readAiSettings()
}

function serverSummaryResponse(): Response {
  return new Response(JSON.stringify({ summary: '服务器总结', segments: [] }), { status: 200 })
}

function localCompletionResponse(): Response {
  // summarize 走流式：本地通道用 SSE 回总结全文（两个 delta 验证聚合）。
  const content = JSON.stringify({ summary: '本地总结', segments: [] })
  const half = Math.ceil(content.length / 2)
  return new Response(
    [
      `data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(0, half) } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(half) } }] })}`,
      'data: [DONE]',
    ].join('\n') + '\n',
    { status: 200 },
  )
}

function chatSseResponse(chunk: string): Response {
  return new Response(
    ['data: {"choices":[{"delta":{"content":"' + chunk + '"}}]}', 'data: [DONE]'].join('\n') + '\n',
    { status: 200 },
  )
}

function routedFetch(serverFails: boolean): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: RequestInfo | URL) => {
    const target = String(url)
    if (target.startsWith('https://srv.example')) {
      return serverFails ? new Response('boom', { status: 500 }) : serverSummaryResponse()
    }
    return localCompletionResponse()
  })
}

async function collectChat(caps: ReturnType<typeof resolveBackend>): Promise<AiChatEvent[]> {
  const events: AiChatEvent[] = []
  await caps.chat(
    { messages: [{ role: 'user', content: '问' }], context: CONTEXT },
    { onEvent: (event) => events.push(event) },
  )
  return events
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolveBackend（mode 分派唯一入口）', () => {
  it('mode=server：只走 server 通道', async () => {
    const fetchMock = routedFetch(false)
    vi.stubGlobal('fetch', fetchMock)
    const caps = resolveBackend(await settingsOf('server'))
    const result = await caps.summarize(SUMMARIZE_INPUT)
    expect(result.summary).toBe('服务器总结')
    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls).toEqual(['https://srv.example/ai/summary'])
  })

  it('mode=local：只走本地直连通道', async () => {
    const fetchMock = routedFetch(false)
    vi.stubGlobal('fetch', fetchMock)
    const caps = resolveBackend(await settingsOf('local'))
    const result = await caps.summarize(SUMMARIZE_INPUT)
    expect(result.summary).toBe('本地总结')
    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls).toEqual(['https://llm.example/v1/chat/completions'])
  })

  it('mode=auto：server 成功则不再调用 local', async () => {
    const fetchMock = routedFetch(false)
    vi.stubGlobal('fetch', fetchMock)
    const caps = resolveBackend(await settingsOf('auto'))
    const result = await caps.summarize(SUMMARIZE_INPUT)
    expect(result.summary).toBe('服务器总结')
    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls).toEqual(['https://srv.example/ai/summary'])
  })

  it('mode=auto：server 失败回退 local 并返回其结果', async () => {
    const fetchMock = routedFetch(true)
    vi.stubGlobal('fetch', fetchMock)
    const caps = resolveBackend(await settingsOf('auto'))
    const result = await caps.summarize(SUMMARIZE_INPUT)
    expect(result.summary).toBe('本地总结')
    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls).toEqual(['https://srv.example/ai/summary', 'https://llm.example/v1/chat/completions'])
  })

  it('mode=auto：server 与 local 均失败时上抛 local 的 AiError', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).startsWith('https://srv.example')) {
        return new Response('boom', { status: 500 })
      }
      // local 的 llm 调用返回 429——上抛的应是 local 的错误而非 server 的。
      return new Response('slow', { status: 429 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const caps = resolveBackend(await settingsOf('auto'))
    await expect(caps.summarize(SUMMARIZE_INPUT)).rejects.toMatchObject({ kind: 'http', status: 429 })
  })

  it('mode=auto detectAds：server 失败回退 local，local 走 RAG 降级链', async () => {
    const fetchMock = routedFetch(true)
    vi.stubGlobal('fetch', fetchMock)
    const caps = resolveBackend(await settingsOf('auto'))
    // local 的 embeddings 收到补全形状响应 → 向量路解析失败 → 纯词表无命中 → 全文兜底：
    // 兜底 chat 返回的 "本地总结" JSON 不是 ads 形状 → 定界无片段 → {ads:[], source:"none"}。
    const result = await caps.detectAds({ ...CONTEXT, strategy: 'smart' })
    expect(result).toEqual({ ads: [], source: 'none' })
    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls[0]).toBe('https://srv.example/ai/ad-detection')
    expect(urls[urls.length - 1]).toBe('https://llm.example/v1/chat/completions')
  })

  it('mode=auto：用户中止时原样上抛，不回退 local 二次请求', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn((url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(url).startsWith('https://srv.example')) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted.', 'AbortError')),
            { once: true },
          )
        })
      }
      return Promise.resolve(localCompletionResponse())
    })
    vi.stubGlobal('fetch', fetchMock)
    const caps = resolveBackend(await settingsOf('auto'))
    const promise = caps.summarize({ ...SUMMARIZE_INPUT, signal: controller.signal })
    controller.abort()
    await expect(promise).rejects.toMatchObject({ kind: 'network', message: '请求已中止' })
    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls).toEqual(['https://srv.example/ai/summary'])
  })

  it('mode=auto chat：server 流开始前失败时回退 local，事件流等于 local 结果', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).startsWith('https://srv.example')) {
        return new Response('boom', { status: 401 })
      }
      return chatSseResponse('本地回答')
    })
    vi.stubGlobal('fetch', fetchMock)
    const caps = resolveBackend(await settingsOf('auto'))
    const events = await collectChat(caps)
    expect(events).toEqual([
      { type: 'start' },
      { type: 'message', chunk: '本地回答' },
      { type: 'end' },
    ])
  })

  it('mode=auto chat：server 成功时不再调用 local', async () => {
    let localCalls = 0
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const target = String(url)
      if (target.startsWith('https://srv.example')) {
        // 服务器返回端口同构 SSE 事件流。
        return new Response(
          'data: {"type":"message","chunk":"服务器回答"}\ndata: {"type":"end"}\n',
          { status: 200 },
        )
      }
      localCalls += 1
      return localCompletionResponse()
    })
    vi.stubGlobal('fetch', fetchMock)
    const caps = resolveBackend(await settingsOf('auto'))
    const events = await collectChat(caps)
    expect(events).toEqual([
      { type: 'start' },
      { type: 'message', chunk: '服务器回答' },
      { type: 'end' },
    ])
    expect(localCalls).toBe(0)
  })

  it('mode=auto chat：server 流开始后（已 emit start）失败不回退，以 end{error} 收束', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).startsWith('https://srv.example')) {
        // 服务器先发一条消息事件、随后连接中断——流已开始，auto 不再回退。
        let enqueued = false
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!enqueued) {
              enqueued = true
              controller.enqueue(new TextEncoder().encode('data: {"type":"message","chunk":"半截"}\n'))
            } else {
              controller.error(new Error('connection reset'))
            }
          },
        })
        return new Response(stream, { status: 200 })
      }
      return chatSseResponse('不该出现')
    })
    vi.stubGlobal('fetch', fetchMock)
    const caps = resolveBackend(await settingsOf('auto'))
    const events = await collectChat(caps)
    expect(events[0]).toEqual({ type: 'start' })
    expect(events[1]).toEqual({ type: 'message', chunk: '半截' })
    expect(events.at(-1)).toMatchObject({ type: 'end', error: { kind: 'network' } })
  })
})