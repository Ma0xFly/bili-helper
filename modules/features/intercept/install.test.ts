// @vitest-environment happy-dom
// 网络补丁测试（Epic1-S1.3）：fetch 与 XHR 的 observe-only / 短路两语义。
// fetch 用注入桩；XHR 用继承 EventTarget 的假类（真网络不需要）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NetworkInterceptor } from './protocol'
import { InterceptRuntime } from './runtime'
import { deliverShortCircuitXhr, installFetchPatch, installXhrPatch } from './install'

function runtimeWith(interceptor: Partial<NetworkInterceptor> & { id: string }): InterceptRuntime {
  const runtime = new InterceptRuntime()
  runtime.setInterceptors([
    { priority: 20, match: () => false, ...interceptor } as NetworkInterceptor,
  ])
  return runtime
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('fetch 补丁', () => {
  it('observe-only：原响应原样交给页面（字节与状态码不变），拦截器收到解析后的 JSON', async () => {
    const afterResponse = vi.fn()
    const runtime = runtimeWith({
      id: 'obs',
      match: (url) => url.includes('/api/feed'),
      afterResponse,
    })
    const realFetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: { item: [1, 2] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const restore = installFetchPatch(runtime, window, realFetch as unknown as typeof fetch)
    try {
      const response = await window.fetch('https://api.bilibili.com/x/api/feed?ps=20')
      expect(response.status).toBe(200)
      // 原响应体没被消费/改动：页面照常读完整个 body。
      expect(await response.json()).toEqual({ data: { item: [1, 2] } })
      await vi.waitFor(() => expect(afterResponse).toHaveBeenCalled())
      expect(afterResponse.mock.calls[0]?.[0]).toMatchObject({
        url: 'https://api.bilibili.com/x/api/feed?ps=20',
        method: 'GET',
        status: 200,
        responseJson: { data: { item: [1, 2] } },
      })
    } finally {
      restore()
    }
  })

  it('未命中 URL 零开销：不进回调，请求原样发出', async () => {
    const afterResponse = vi.fn()
    const runtime = runtimeWith({
      id: 'obs',
      match: (url) => url.includes('/api/feed'),
      afterResponse,
    })
    const realFetch = vi.fn(async () => new Response('{"other":1}', { status: 200 }))
    const restore = installFetchPatch(runtime, window, realFetch as unknown as typeof fetch)
    try {
      await window.fetch('https://api.bilibili.com/x/other-endpoint')
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(afterResponse).not.toHaveBeenCalled()
      expect(realFetch).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

  it('短路：不发真实请求，页面直接拿到缓存 JSON（200 + application/json）', async () => {
    const runtime = runtimeWith({
      id: 'replay',
      match: (url) => url.includes('rcmd'),
      shortCircuit: () => ({ status: 200, responseJson: { cached: true, item: [] } }),
    })
    const realFetch = vi.fn(async () => new Response('{}', { status: 200 }))
    const restore = installFetchPatch(runtime, window, realFetch as unknown as typeof fetch)
    try {
      const response = await window.fetch('https://api.bilibili.com/x/rcmd?fresh_type=3', {
        method: 'POST',
        body: 'ps=20',
      })
      expect(realFetch).not.toHaveBeenCalled()
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(await response.json()).toEqual({ cached: true, item: [] })
    } finally {
      restore()
    }
  })

  it('还原函数恢复原始 fetch', async () => {
    const runtime = new InterceptRuntime()
    const original = window.fetch
    const restore = installFetchPatch(runtime, window, vi.fn(async () => new Response('{}')) as never)
    expect(window.fetch).not.toBe(original)
    restore()
    expect(window.fetch).toBe(original)
  })
})

// ---------- XHR ----------

/** 测试用 XHR 替身：继承 EventTarget（事件派发真实），send 即同步模拟一次 JSON 响应。 */
class FakeXHR extends EventTarget {
  readyState = 0
  status = 0
  responseText = ''
  responseType = ''
  sendBody: unknown = null

  open(method: string, url: string): void {
    this.meta = { method, url }
  }

  send(body?: unknown): void {
    this.sendBody = body ?? null
    this.readyState = 4
    this.status = 200
    this.responseText = JSON.stringify({ code: 0, data: { hello: 'xhr' } })
    this.dispatchEvent(new Event('load'))
  }

  meta: { method: string; url: string } | null = null
}

describe('XHR 补丁', () => {
  it('observe-only：send 后 load 事件里解析 JSON 交给拦截器', async () => {
    const afterResponse = vi.fn()
    const runtime = runtimeWith({
      id: 'obs',
      match: (url) => url.includes('/api/feed'),
      afterResponse,
    })
    const restore = installXhrPatch(runtime, FakeXHR as unknown as typeof XMLHttpRequest, window)
    try {
      const xhr = new FakeXHR()
      xhr.open('GET', 'https://api.bilibili.com/x/api/feed')
      xhr.send(null)
      await vi.waitFor(() => expect(afterResponse).toHaveBeenCalled())
      expect(afterResponse.mock.calls[0]?.[0]).toMatchObject({
        url: 'https://api.bilibili.com/x/api/feed',
        method: 'GET',
        status: 200,
        responseJson: { code: 0, data: { hello: 'xhr' } },
      })
    } finally {
      restore()
    }
  })

  it('短路：send 不触达真实实现，readystate/status/responseText 就绪且事件序完整', () => {
    const runtime = runtimeWith({
      id: 'replay',
      match: (url) => url.includes('rcmd'),
      shortCircuit: () => ({ responseJson: { replayed: true } }),
    })
    const events: string[] = []
    const restore = installXhrPatch(runtime, FakeXHR as unknown as typeof XMLHttpRequest, window)
    try {
      const xhr = new FakeXHR()
      xhr.addEventListener('readystatechange', () => events.push('readystatechange'))
      xhr.addEventListener('load', () => events.push('load'))
      xhr.addEventListener('loadend', () => events.push('loadend'))
      xhr.open('POST', 'https://api.bilibili.com/x/rcmd')
      xhr.send('ps=20')
      // 真实 send 未发生（sendBody 未被赋值、模拟响应未触发），事件序完整。
      expect(xhr.sendBody).toBeNull()
      expect(xhr.responseText).not.toContain('hello')
      expect(events).toEqual(['readystatechange', 'load', 'loadend'])
      expect(xhr.readyState).toBe(4)
      expect(xhr.status).toBe(200)
      expect(xhr.responseText).toBe(JSON.stringify({ replayed: true }))
    } finally {
      restore()
    }
  })

  it('deliverShortCircuitXhr 对原生 XHR 实例同样可用（readonly 属性被实例级覆盖）', () => {
    const xhr = new XMLHttpRequest()
    const seen: string[] = []
    xhr.addEventListener('load', () => seen.push('load'))
    xhr.addEventListener('loadend', () => seen.push('loadend'))
    deliverShortCircuitXhr(xhr, { status: 200, responseJson: { ok: 1 } })
    expect(xhr.readyState).toBe(4)
    expect(xhr.status).toBe(200)
    expect(xhr.responseText).toBe('{"ok":1}')
    expect(seen).toEqual(['load', 'loadend'])
  })
})
