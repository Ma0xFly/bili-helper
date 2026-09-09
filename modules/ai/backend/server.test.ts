import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type AiSettings } from '../../settings'
import type { AiChatEvent, AiContext } from '../port'
import { createServerBackend } from './server'

const CONTEXT: AiContext = {
  video: { bvid: 'BV1xx411c7mD', cid: 1, title: '测试视频', duration: 600 },
  subtitles: [{ start: 0, end: 10, text: '大家好' }],
  danmaku: [{ time: 5, text: '顶' }],
  comments: [{ top: { text: '前排' } }],
}

function settingsOf(overrides: Partial<AiSettings>): AiSettings {
  return {
    ...DEFAULT_SETTINGS,
    serverBaseUrl: 'https://srv.example',
    serverToken: 'tok-1',
    mode: 'server',
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function sseResponse(lines: string[], status = 200): Response {
  return new Response(lines.map((line) => `${line}\n`).join(''), { status })
}

function fetchCall(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
  const call = fetchMock.mock.calls[index]
  return { url: String(call?.[0]), init: call?.[1] as RequestInit | undefined }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('server detectAds / summarize（转发契约）', () => {
  it('detectAds POST {serverBaseUrl}/ai/ad-detection，携带原始 context + 策略 + Bearer', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ads: [{ start: 30, end: 40, product_name: '耳机', ad_content: '恰饭', confidence: 0.9 }], source: 'rag' }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const backend = createServerBackend(settingsOf({}))
    const result = await backend.detectAds({ ...CONTEXT, strategy: 'smart' })

    expect(result).toEqual({
      ads: [{ start: 30, end: 40, product_name: '耳机', ad_content: '恰饭', confidence: 0.9 }],
      source: 'rag',
    })

    const { url, init } = fetchCall(fetchMock)
    expect(url).toBe('https://srv.example/ai/ad-detection')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-1')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      video: CONTEXT.video,
      subtitles: CONTEXT.subtitles,
      danmaku: CONTEXT.danmaku,
      comments: CONTEXT.comments,
      strategy: 'smart',
    })
  })

  it('summarize POST {serverBaseUrl}/ai/summary 并按端口形状解析', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ summary: '服务器总结', segments: [{ start: 0, end: 10, label: '开场' }] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const backend = createServerBackend(settingsOf({}))
    const result = await backend.summarize({
      video: CONTEXT.video,
      subtitles: CONTEXT.subtitles,
      danmaku: CONTEXT.danmaku,
    })
    expect(result).toEqual({ summary: '服务器总结', segments: [{ start: 0, end: 10, label: '开场' }] })
    expect(fetchCall(fetchMock).url).toBe('https://srv.example/ai/summary')
  })

  it('serverToken 为空时不发送 Authorization 头', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ads: [], source: 'none' }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const backend = createServerBackend(settingsOf({ serverToken: '' }))
    await backend.detectAds({ ...CONTEXT, strategy: 'free' })
    const { init } = fetchCall(fetchMock)
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it('401 映射 auth（带 status）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401)))
    const backend = createServerBackend(settingsOf({}))
    await expect(backend.detectAds({ ...CONTEXT, strategy: 'free' })).rejects.toMatchObject({
      kind: 'auth',
      status: 401,
    })
  })

  it('非 2xx 映射 http、网络失败映射 network、坏 JSON 映射 parse', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 502)))
    await expect(
      createServerBackend(settingsOf({})).detectAds({ ...CONTEXT, strategy: 'free' }),
    ).rejects.toMatchObject({ kind: 'http', status: 502 })

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    await expect(
      createServerBackend(settingsOf({})).detectAds({ ...CONTEXT, strategy: 'free' }),
    ).rejects.toMatchObject({ kind: 'network' })

    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(
      createServerBackend(settingsOf({})).detectAds({ ...CONTEXT, strategy: 'free' }),
    ).rejects.toMatchObject({ kind: 'parse' })
  })

  it('响应形状不合法（缺 ads 数组）映射 parse', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ nope: true })))
    await expect(
      createServerBackend(settingsOf({})).detectAds({ ...CONTEXT, strategy: 'free' }),
    ).rejects.toMatchObject({ kind: 'parse' })
  })

  it('serverBaseUrl 未配置映射 config', async () => {
    const backend = createServerBackend(settingsOf({ serverBaseUrl: '' }))
    await expect(backend.summarize({ video: CONTEXT.video, subtitles: [], danmaku: [] })).rejects.toMatchObject({
      kind: 'config',
      message: expect.stringContaining('服务器端点'),
    })
  })
})

describe('server chat（SSE 透传）', () => {
  async function collectChat(backend: ReturnType<typeof createServerBackend>): Promise<AiChatEvent[]> {
    const events: AiChatEvent[] = []
    await backend.chat(
      { messages: [{ role: 'user', content: '问' }], context: CONTEXT },
      { onEvent: (event) => events.push(event) },
    )
    return events
  }

  it('POST {serverBaseUrl}/ai/chat 且透传服务端 start/message/end 同构事件', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        'data: {"type":"start"}',
        'data: {"type":"message","chunk":"服务器回答"}',
        'data: {"type":"end"}',
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)
    const backend = createServerBackend(settingsOf({}))
    const events = await collectChat(backend)

    expect(fetchCall(fetchMock).url).toBe('https://srv.example/ai/chat')
    expect((fetchCall(fetchMock).init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok-1',
    )
    const body = JSON.parse(String(fetchCall(fetchMock).init?.body))
    expect(body).toMatchObject({
      messages: [{ role: 'user', content: '问' }],
      context: { video: CONTEXT.video, subtitles: CONTEXT.subtitles },
    })

    // 服务端自己发的 start 被适配器跳过：消费方恰好收到一次 start 且在最前。
    expect(events.filter((event) => event.type === 'start')).toHaveLength(1)
    expect(events[0]).toEqual({ type: 'start' })
    expect(events).toEqual([
      { type: 'start' },
      { type: 'message', chunk: '服务器回答' },
      { type: 'end' },
    ])
  })

  it('服务端 end.error 透传', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse(['data: {"type":"message","chunk":"半"}', 'data: {"type":"end","error":{"kind":"auth","message":"x","status":403}}']),
      ),
    )
    const events = await collectChat(createServerBackend(settingsOf({})))
    expect(events.at(-1)).toEqual({
      type: 'end',
      error: { kind: 'auth', message: 'x', status: 403 },
    })
  })

  it('normalizeServerError 退化分支：未知 kind/缺 message/非对象归一为 network', async () => {
    const cases: { error: unknown; expected: { kind: string; message: string } }[] = [
      { error: { kind: 'bogus', message: 'x' }, expected: { kind: 'network', message: 'x' } },
      { error: {}, expected: { kind: 'network', message: '服务器返回了未知错误' } },
      { error: null, expected: { kind: 'network', message: '服务器返回了未知错误' } },
      { error: { message: 'x' }, expected: { kind: 'network', message: 'x' } },
    ]
    for (const { error, expected } of cases) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => sseResponse([`data: ${JSON.stringify({ type: 'end', error })}`])),
      )
      const events = await collectChat(createServerBackend(settingsOf({})))
      expect(events.at(-1)).toMatchObject({ type: 'end', error: expected })
    }
  })

  it('流开始前的非 2xx 直接 reject（auto 回退据此感知），不 emit 任何事件', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 401)))
    const events: AiChatEvent[] = []
    await expect(
      createServerBackend(settingsOf({})).chat(
        { messages: [{ role: 'user', content: '问' }], context: CONTEXT },
        { onEvent: (event) => events.push(event) },
      ),
    ).rejects.toMatchObject({ kind: 'auth', status: 401 })
    expect(events).toEqual([])
  })

  it('serverBaseUrl 未配置时流开始前 reject config', async () => {
    const events: AiChatEvent[] = []
    await expect(
      createServerBackend(settingsOf({ serverBaseUrl: '' })).chat(
        { messages: [{ role: 'user', content: '问' }], context: CONTEXT },
        { onEvent: (event) => events.push(event) },
      ),
    ).rejects.toMatchObject({ kind: 'config' })
    expect(events).toEqual([])
  })
})