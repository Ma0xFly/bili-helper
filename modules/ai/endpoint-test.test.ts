import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiError } from '../shared/error'
import { describeTestFailure, testChatEndpoint, testEmbeddingEndpoint } from './endpoint-test'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('testChatEndpoint', () => {
  it('有效端点返回 { ok:true, model, ms }', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'pong' } }] })),
    )
    const result = await testChatEndpoint({ baseUrl: 'https://llm.example/v1', model: 'm-1', apiKey: 'k-1' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.model).toBe('m-1')
      expect(result.ms).toBeGreaterThanOrEqual(0)
    }
  })

  it('401 红灯：reason 摘要直指 Key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'wrong key' }, 401)))
    const result = await testChatEndpoint({ baseUrl: 'https://llm.example/v1', model: 'm-1', apiKey: 'bad' })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) {
      expect(result.reason).toContain('401 未授权')
      expect(result.reason).toContain('API Key')
    }
  })

  it('空回复判失败（reason「端点返回了空回复」）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ choices: [{ message: { content: '' } }] })),
    )
    const result = await testChatEndpoint({ baseUrl: 'https://llm.example/v1', model: 'm-1', apiKey: 'k' })
    expect(result).toEqual({ ok: false, reason: '端点返回了空回复' })
  })

  it('网络失败红灯：reason 覆盖 CORS 未放行排查提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    const result = await testChatEndpoint({ baseUrl: 'https://llm.example/v1', model: 'm-1', apiKey: 'k' })
    if (!result.ok) expect(result.reason).toContain('CORS')
    else throw new Error('应当失败')
  })

  it('未配置 apiUrl：reason 为「先去设置页配置端点」', async () => {
    const result = await testChatEndpoint({ baseUrl: '', model: 'm-1', apiKey: '' })
    if (!result.ok) expect(result.reason).toBe('先去设置页配置端点')
    else throw new Error('应当失败')
  })
})

describe('testEmbeddingEndpoint', () => {
  it('最小向量成功返回 { ok:true }', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ data: [{ index: 0, embedding: [0.1, 0.2] }] })),
    )
    const result = await testEmbeddingEndpoint({ baseUrl: 'https://llm.example/v1', model: 'emb-1', apiKey: 'k-1' })
    expect(result.ok).toBe(true)
  })

  it('非所选协议的响应红灯：reason 提示确认协议', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [] })))
    const result = await testEmbeddingEndpoint({ baseUrl: 'https://llm.example/v1', model: 'emb-1', apiKey: 'k-1' })
    if (!result.ok) expect(result.reason).toContain('协议')
    else throw new Error('应当失败')
  })

  it('向量端点按继承解析后的对话端点值探测（端到端模拟）', async () => {
    // 向量三字段留空时继承对话端点：此处直接以解析后的值调用，验证探测通道可用。
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ data: [{ index: 0, embedding: [1] }] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const result = await testEmbeddingEndpoint({ baseUrl: 'https://chat.example/v1', model: 'gpt-4o-mini', apiKey: 'chat-key' })
    expect(result.ok).toBe(true)
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://chat.example/v1/embeddings')
  })
})

describe('describeTestFailure（kind → 红灯文案映射）', () => {
  it('覆盖五类 kind', () => {
    expect(describeTestFailure(new AiError('config', '先去设置页配置端点'))).toBe('先去设置页配置端点')
    expect(describeTestFailure(new AiError('auth', '端点返回了 403', { status: 403 }))).toContain('未授权')
    expect(describeTestFailure(new AiError('http', '端点返回了 502', { status: 502 }))).toContain('端点返回 502')
    expect(describeTestFailure(new AiError('parse', '坏格式'))).toContain('协议')
    expect(describeTestFailure(new AiError('network', '断了'))).toContain('CORS')
    expect(describeTestFailure(new Error('未知'))).toContain('未知错误')
  })
})