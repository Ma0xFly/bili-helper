import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type AiSettings } from '../../settings'
import type { AiChatEvent, AiContext } from '../port'
import { createLocalBackend } from './local'

const CONTEXT: AiContext = {
  video: { bvid: 'BV1xx411c7mD', cid: 1, title: '测试视频', duration: 600 },
  subtitles: [
    { start: 0, end: 10, text: '大家好' },
    { start: 30, end: 40, text: '感谢赞助商' },
  ],
  danmaku: [{ time: 5, text: '顶' }],
  comments: [],
}

const SUMMARIZE_INPUT = {
  video: CONTEXT.video,
  subtitles: CONTEXT.subtitles,
  danmaku: CONTEXT.danmaku,
}

function settingsOf(overrides: Partial<AiSettings>): AiSettings {
  return {
    ...DEFAULT_SETTINGS,
    apiUrl: 'https://llm.example/v1',
    model: 'm-1',
    apiKey: 'k-1',
    mode: 'local',
    ...overrides,
  }
}

function completionResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
}

function sseResponse(lines: string[], status = 200): Response {
  return new Response(lines.map((line) => `${line}\n`).join(''), { status })
}

// 读取过程中等待外部 signal 中止后抛 AbortError 的响应体，模拟已中止连接的读失败。
function abortableStream(signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull() {
      if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
      throw new DOMException('The operation was aborted.', 'AbortError')
    },
  })
}

async function collectChat(
  backend: ReturnType<typeof createLocalBackend>,
  signal?: AbortSignal,
): Promise<AiChatEvent[]> {
  const events: AiChatEvent[] = []
  await backend.chat(
    { messages: [{ role: 'user', content: '讲了什么？' }], context: CONTEXT, signal },
    { onEvent: (event) => events.push(event) },
  )
  return events
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('local summarize（直连补全）', () => {
  it('直连补全成功且按端口形状返回', async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        completionResponse(JSON.stringify({ summary: '这是一期测试', segments: [{ start: 0, end: 40, label: '开场' }] })),
      )
    vi.stubGlobal('fetch', fetchMock)
    const backend = createLocalBackend(settingsOf({}))
    const result = await backend.summarize(SUMMARIZE_INPUT)
    expect(result.summary).toBe('这是一期测试')
    expect(result.segments).toEqual([{ start: 0, end: 40, label: '开场' }])

    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect((sent.messages as { role: string; content: string }[])[0]?.role).toBe('system')
    expect((sent.messages as { role: string; content: string }[])[0]?.content).toContain('严禁编造')
    expect((sent.messages as { role: string; content: string }[])[1]?.content).toContain('[00:30] 感谢赞助商')
  })

  it('输出非 JSON 时退化：原文整体作为 summary、segments 空', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => completionResponse('模型直接输出的一段总结。')))
    const backend = createLocalBackend(settingsOf({}))
    const result = await backend.summarize(SUMMARIZE_INPUT)
    expect(result).toEqual({ summary: '模型直接输出的一段总结。', segments: [] })
  })

  it('网络失败上抛 AiError network', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    const backend = createLocalBackend(settingsOf({}))
    await expect(backend.summarize(SUMMARIZE_INPUT)).rejects.toMatchObject({ kind: 'network' })
  })

  it('apiUrl 未配置上抛 config「先去设置页配置端点」', async () => {
    const backend = createLocalBackend(settingsOf({ apiUrl: '' }))
    await expect(backend.summarize(SUMMARIZE_INPUT)).rejects.toMatchObject({
      kind: 'config',
      message: '先去设置页配置端点',
    })
  })
})

describe('local chat（直连流式转 SSE 事件）', () => {
  it('事件序为 start→message{chunk}→end，[DONE] 收束', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).includes('/chat/completions')) {
          expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true })
          return sseResponse([
            'data: {"choices":[{"delta":{"content":"你"}}]}',
            'data: {"choices":[{"delta":{"content":"好"}}]}',
            'data: [DONE]',
          ])
        }
        return new Response('', { status: 404 })
      }),
    )
    const backend = createLocalBackend(settingsOf({}))
    const events = await collectChat(backend)
    expect(events).toEqual([
      { type: 'start' },
      { type: 'message', chunk: '你' },
      { type: 'message', chunk: '好' },
      { type: 'end' },
    ])
  })

  it('401 错误以 end{error auth} 收尾，不悬挂', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([], 401)))
    const backend = createLocalBackend(settingsOf({}))
    const events = await collectChat(backend)
    expect(events[0]).toEqual({ type: 'start' })
    expect(events[1]).toMatchObject({ type: 'end', error: { kind: 'auth', status: 401 } })
    expect(events[events.length - 1]?.type).toBe('end')
  })

  it('外部中止以 end{error} 收尾（error 含中止原因）', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(abortableStream(controller.signal))))
    const backend = createLocalBackend(settingsOf({}))
    const events: AiChatEvent[] = []
    const promise = backend.chat(
      { messages: [{ role: 'user', content: '问' }], context: CONTEXT, signal: controller.signal },
      { onEvent: (event) => events.push(event) },
    )
    const first = new Promise<void>((resolve) => setTimeout(resolve, 0))
    await first
    controller.abort()
    await promise
    expect(events[0]).toEqual({ type: 'start' })
    expect(events[events.length - 1]).toMatchObject({
      type: 'end',
      error: { kind: 'network', message: '请求已中止' },
    })
  })

  it('apiUrl 未配置：start 后以 end{error config} 收尾', async () => {
    const backend = createLocalBackend(settingsOf({ apiUrl: '' }))
    const events = await collectChat(backend)
    expect(events).toEqual([
      { type: 'start' },
      { type: 'end', error: { kind: 'config', message: '先去设置页配置端点' } },
    ])
  })

  it('handler 在 start 抛错时仍以 end{error} 收尾（终止性不因 handler 异常打破）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(['data: [DONE]'])))
    const backend = createLocalBackend(settingsOf({}))
    const events: AiChatEvent[] = []
    await backend.chat(
      { messages: [{ role: 'user', content: '问' }], context: CONTEXT },
      {
        onEvent: (event) => {
          events.push(event)
          if (event.type === 'start') throw new Error('handler 崩了')
        },
      },
    )
    expect(events[0]).toEqual({ type: 'start' })
    expect(events.at(-1)).toMatchObject({
      type: 'end',
      error: { kind: 'network', message: 'handler 崩了' },
    })
  })
})

describe('local detectAds（RAG 链路接线）', () => {
  it('端点未配置抛 AiError config（内容脚本据此静默不弹 UI）', async () => {
    const backend = createLocalBackend(
      settingsOf({ apiUrl: '', model: '', embedBaseUrl: '', embedModel: '' }),
    )
    await expect(backend.detectAds({ ...CONTEXT, strategy: 'smart' })).rejects.toMatchObject({
      kind: 'config',
      message: /至少配一个/,
    })
  })

  it('smart 策略走 RAG：恰饭字幕给出 rag 结果（检索与定界两端点都被请求）', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url)
      if (target.includes('/embeddings')) {
        const inputs = (JSON.parse(String(init?.body)) as { input: string[] }).input
        return new Response(
          JSON.stringify({ data: inputs.map((_input, index) => ({ index, embedding: [1, 0] })) }),
          { status: 200 },
        )
      }
      if (target.includes('/chat/completions')) {
        return completionResponse(
          JSON.stringify({
            ads: [{ start: 492, end: 580, product_name: '赞助商', ad_content: '', confidence: 0.8 }],
          }),
        )
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createLocalBackend(settingsOf({}))
    const result = await backend.detectAds({ ...CONTEXT, strategy: 'smart' })
    expect(result.source).toBe('rag')
    expect(result.ads).toEqual([
      { start: 492, end: 580, product_name: '赞助商', ad_content: '', confidence: 0.8 },
    ])
  })
})