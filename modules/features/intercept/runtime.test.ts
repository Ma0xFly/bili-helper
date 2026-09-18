// 拦截运行时测试（Epic1-S1.3）：注册校验/全注销、优先级排序、未命中零开销语义、
// 回调抛错隔离、短路判定（首个非空者胜、抛错按未命中）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NetworkInterceptor } from './protocol'
import { InterceptRuntime, buildInterceptors } from './runtime'

function interceptorOf(partial: Partial<NetworkInterceptor> & { id: string }): NetworkInterceptor {
  return { priority: 20, match: () => false, ...partial } as NetworkInterceptor
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('InterceptRuntime', () => {
  it('重复 id：构建失败全注销并抛可读错误', () => {
    const runtime = new InterceptRuntime()
    runtime.setInterceptors([interceptorOf({ id: 'a' })])
    expect(() =>
      runtime.setInterceptors([interceptorOf({ id: 'a' }), interceptorOf({ id: 'a' })]),
    ).toThrow(/重复/)
    expect(runtime.size).toBe(0) // 不留半启用状态
  })

  it('缺 match 或缺 id 同样全注销', () => {
    const runtime = new InterceptRuntime()
    expect(() =>
      runtime.setInterceptors([{ id: 'x', priority: 1 } as unknown as NetworkInterceptor]),
    ).toThrow(/match/)
    expect(() => runtime.setInterceptors([interceptorOf({ id: '' })])).toThrow(/id/)
    expect(runtime.size).toBe(0)
  })

  it('priority 升序排序（小者先判）；同 priority 按 id 稳定', () => {
    const runtime = new InterceptRuntime()
    const order: string[] = []
    runtime.setInterceptors([
      interceptorOf({ id: 'b', priority: 20, match: () => true, afterResponse: () => order.push('b') }),
      interceptorOf({ id: 'a', priority: 10, match: () => true, afterResponse: () => order.push('a') }),
    ])
    runtime.dispatchAfterResponse('https://x', 'GET', 200, {})
    expect(order).toEqual(['a', 'b'])
  })

  it('未命中零开销：observesUrl 为 false，分发不进回调', () => {
    const runtime = new InterceptRuntime()
    const afterResponse = vi.fn()
    runtime.setInterceptors([
      interceptorOf({ id: 'a', match: (url) => url.includes('/api/feed'), afterResponse }),
    ])
    expect(runtime.observesUrl('https://api.bilibili.com/x/other')).toBe(false)
    runtime.dispatchAfterResponse('https://api.bilibili.com/x/other', 'GET', 200, {})
    expect(afterResponse).not.toHaveBeenCalled()
    expect(runtime.observesUrl('https://api.bilibili.com/x/api/feed')).toBe(true)
    runtime.dispatchAfterResponse('https://api.bilibili.com/x/api/feed', 'GET', 200, { ok: 1 })
    expect(afterResponse).toHaveBeenCalledWith(
      expect.objectContaining({ status: 200, responseJson: { ok: 1 } }),
    )
  })

  it('观察回调抛错：记录（含 id 与 URL）且其余拦截器照常', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtime = new InterceptRuntime()
    const good = vi.fn()
    runtime.setInterceptors([
      interceptorOf({
        id: 'bad',
        priority: 10,
        match: () => true,
        afterResponse: () => {
          throw new Error('boom')
        },
      }),
      interceptorOf({ id: 'good', priority: 20, match: () => true, afterResponse: good }),
    ])
    runtime.dispatchAfterResponse('https://api.example/feed', 'GET', 200, {})
    expect(good).toHaveBeenCalled()
    expect(errSpy.mock.calls.some((call) => String(call[0]).includes('bad'))).toBe(true)
    expect(errSpy.mock.calls.some((call) => call.some((a) => String(a).includes('/feed')))).toBe(true)
  })

  it('短路：首个非 null 者胜；短路器抛错按未命中（页面照常请求）并记录', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtime = new InterceptRuntime()
    runtime.setInterceptors([
      interceptorOf({
        id: 'broken',
        priority: 10,
        match: () => true,
        shortCircuit: () => {
          throw new Error('nope')
        },
      }),
      interceptorOf({
        id: 'replay',
        priority: 20,
        match: (url) => url.includes('rcmd'),
        shortCircuit: () => ({ status: 200, responseJson: { cached: true } }),
      }),
    ])
    const shorted = runtime.findShortCircuit('https://api.bilibili.com/x/rcmd', 'GET', null)
    expect(shorted).toEqual({ status: 200, responseJson: { cached: true } })
    expect(runtime.findShortCircuit('https://api.bilibili.com/x/other', 'GET', null)).toBeNull()
    expect(errSpy.mock.calls.some((call) => String(call[0]).includes('broken'))).toBe(true)
  })

  it('match 抛错：该拦截器视为未命中并记录', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtime = new InterceptRuntime()
    runtime.setInterceptors([
      interceptorOf({
        id: 'bad-match',
        match: () => {
          throw new Error('bad')
        },
        afterResponse: () => {},
      }),
    ])
    expect(runtime.observesUrl('https://x')).toBe(false)
    expect(errSpy).toHaveBeenCalled()
  })
})

describe('buildInterceptors', () => {
  it('只构建已启用且已登记的功能；工厂返回 null 跳过；工厂抛错向上传播', () => {
    const built = buildInterceptors(
      [
        {
          featureId: 'videoFilter',
          build: (entry) =>
            entry.enabled
              ? interceptorOf({ id: 'feed-filter', match: () => true })
              : null,
        },
        { featureId: 'homepageRefreshHistory', build: () => null },
      ],
      {
        videoFilter: { enabled: true, config: {} },
        homepageRefreshHistory: { enabled: true, config: {} },
        commentIpLocation: { enabled: true, config: {} }, // 未登记工厂：忽略
      },
    )
    expect(built.map((item) => item.id)).toEqual(['feed-filter'])
    expect(() =>
      buildInterceptors(
        [{ featureId: 'x', build: () => { throw new Error('factory boom') } }],
        { x: { enabled: true, config: {} } },
      ),
    ).toThrow(/factory boom/)
  })

  it('功能关闭（enabled=false）不构建拦截器——默认全关 = 全站零拦截', () => {
    const built = buildInterceptors(
      [{ featureId: 'videoFilter', build: () => interceptorOf({ id: 'f' }) }],
      { videoFilter: { enabled: false, config: {} } },
    )
    expect(built).toEqual([])
  })
})
