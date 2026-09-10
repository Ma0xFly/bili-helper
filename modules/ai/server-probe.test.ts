import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiError } from '../shared/error'
import { describeServerFailure, probeServerEndpoint } from './server-probe'

function jsonResponse(status: number): Response {
  return new Response(JSON.stringify({ ok: true }), { status })
}

type FetchSpy = ReturnType<typeof vi.fn>

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): FetchSpy {
  const spy = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
    impl(String(url), init),
  )
  vi.stubGlobal('fetch', spy)
  return spy
}

function headersOf(spy: FetchSpy): Record<string, string> {
  const init = spy.mock.calls[0]?.[1] as RequestInit | undefined
  return (init?.headers ?? {}) as Record<string, string>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('probeServerEndpoint', () => {
  it('200 → 绿灯，探活地址为 {base}/ai/health（尾斜杠不重复）', async () => {
    const spy = stubFetch(async () => jsonResponse(200))
    const result = await probeServerEndpoint({ baseUrl: 'https://srv.example/', token: '' })
    expect(result).toMatchObject({ ok: true, healthSupported: true })
    if (result.ok) expect(result.ms).toBeGreaterThanOrEqual(0)
    expect(spy.mock.calls[0]?.[0]).toBe('https://srv.example/ai/health')
  })

  it('token 非空携带 Bearer；留空不带 Authorization 头', async () => {
    const withToken = stubFetch(async () => jsonResponse(200))
    await probeServerEndpoint({ baseUrl: 'https://srv.example', token: 'tok' })
    expect(headersOf(withToken).Authorization).toBe('Bearer tok')

    vi.unstubAllGlobals()
    const withoutToken = stubFetch(async () => jsonResponse(200))
    await probeServerEndpoint({ baseUrl: 'https://srv.example', token: '   ' })
    expect(headersOf(withoutToken).Authorization).toBeUndefined()
  })

  it('404/405 → 可达但未体检（黄灯，不算失败）', async () => {
    stubFetch(async () => jsonResponse(404))
    expect(await probeServerEndpoint({ baseUrl: 'https://srv.example', token: '' })).toMatchObject({
      ok: true,
      healthSupported: false,
    })

    vi.unstubAllGlobals()
    stubFetch(async () => jsonResponse(405))
    expect(await probeServerEndpoint({ baseUrl: 'https://srv.example', token: '' })).toMatchObject({
      ok: true,
      healthSupported: false,
    })
  })

  it('401 → 红灯直指 Server Token', async () => {
    stubFetch(async () => jsonResponse(401))
    const result = await probeServerEndpoint({ baseUrl: 'https://srv.example', token: 'bad' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('未授权')
      expect(result.reason).toContain('Server Token')
    }
  })

  it('5xx → 红灯说明地址可达但服务异常', async () => {
    stubFetch(async () => jsonResponse(502))
    const result = await probeServerEndpoint({ baseUrl: 'https://srv.example', token: '' })
    if (!result.ok) expect(result.reason).toContain('服务器返回 502')
    else throw new Error('应当失败')
  })

  it('网络失败 → 红灯给地址/网络排查方向（不误导去查 CORS）', async () => {
    stubFetch(async () => Promise.reject(new TypeError('Failed to fetch')))
    const result = await probeServerEndpoint({ baseUrl: 'https://srv.example', token: '' })
    if (!result.ok) {
      expect(result.reason).toContain('请求没发出去')
      expect(result.reason).not.toContain('CORS')
    } else throw new Error('应当失败')
  })

  it('地址留空 → 不发请求，直接提示先填地址', async () => {
    const spy = stubFetch(async () => jsonResponse(200))
    const result = await probeServerEndpoint({ baseUrl: '   ', token: '' })
    expect(result).toEqual({ ok: false, reason: '先填写服务器地址' })
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('describeServerFailure', () => {
  it('超时与配置缺失各有专门文案', () => {
    expect(describeServerFailure(new AiError('network', '请求超时'))).toContain('请求超时')
    expect(describeServerFailure(new AiError('config', '先填写服务器地址'))).toBe('先填写服务器地址')
  })
})
