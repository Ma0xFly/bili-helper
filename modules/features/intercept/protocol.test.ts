// @vitest-environment happy-dom
// 配置同步协议测试（Epic1-S1.3）：postMessage 往返、形状校验拒收、退订。
import { describe, expect, it } from 'vitest'
import {
  INTERCEPT_SYNC_MESSAGE,
  isInterceptSyncMessage,
  onInterceptConfigs,
  pushInterceptConfigs,
} from './protocol'

function flushTasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('拦截配置同步（隔离世界 ⇄ 主世界）', () => {
  it('push → on 往返：payload 原样到达', async () => {
    const received: unknown[] = []
    const off = onInterceptConfigs(window, (configs) => received.push(configs))
    pushInterceptConfigs(window, {
      videoFilter: { enabled: true, config: { titleKeywords: ['广告'] } },
      commentIpLocation: { enabled: false, config: {} },
    })
    await flushTasks()
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({
      videoFilter: { enabled: true, config: { titleKeywords: ['广告'] } },
      commentIpLocation: { enabled: false, config: {} },
    })
    off()
  })

  it('退订后不再接收', async () => {
    const received: unknown[] = []
    const off = onInterceptConfigs(window, (configs) => received.push(configs))
    off()
    pushInterceptConfigs(window, {})
    await flushTasks()
    expect(received).toHaveLength(0)
  })

  it('形状校验：类型不对 / enabled 非布尔 / config 非对象一律拒收', () => {
    expect(isInterceptSyncMessage({ type: INTERCEPT_SYNC_MESSAGE, payload: {} })).toBe(true)
    expect(isInterceptSyncMessage({ type: 'other', payload: {} })).toBe(false)
    expect(isInterceptSyncMessage({ type: INTERCEPT_SYNC_MESSAGE, payload: { a: { enabled: 1, config: {} } } })).toBe(false)
    expect(isInterceptSyncMessage({ type: INTERCEPT_SYNC_MESSAGE, payload: { a: { enabled: true, config: null } } })).toBe(false)
    expect(isInterceptSyncMessage(null)).toBe(false)
    expect(isInterceptSyncMessage('x')).toBe(false)
    // 非法消息不会进监听器。
    const received: unknown[] = []
    const off = onInterceptConfigs(window, (configs) => received.push(configs))
    window.postMessage({ type: INTERCEPT_SYNC_MESSAGE, payload: { bad: { enabled: 'yes' } } }, '*')
    window.postMessage({ type: 'unrelated' }, '*')
    void flushTasks().then(() => {
      expect(received).toHaveLength(0)
      off()
    })
  })
})
