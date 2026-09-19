// @vitest-environment happy-dom
// 配置同步协议测试（Epic1-S1.3）：postMessage 往返、形状校验拒收、退订。
import { describe, expect, it } from 'vitest'
import {
  FILTER_LOG_MESSAGE,
  INTERCEPT_SYNC_MESSAGE,
  isFilterLogMessage,
  isInterceptSyncMessage,
  onFilterLogEvent,
  onInterceptConfigs,
  pushFilterLogEvent,
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

describe('拦截明细回传（主世界 → 隔离侧）', () => {
  it('push → on 往返：明细原样到达；非法形状拒收', async () => {
    const received: unknown[] = []
    const off = onFilterLogEvent(window, (entry) => received.push(entry))
    pushFilterLogEvent(window, { bvid: 'BV18vY969EHJ', title: '带货', reason: '标题关键词:带货', surface: '首页' })
    // reason 缺字段 = 非法形状（空串是合法值——内容层的 normalize 再把关）。
    window.postMessage({ type: FILTER_LOG_MESSAGE, payload: { bvid: 'x', title: '', surface: '' } }, '*')
    window.postMessage({ type: 'unrelated' }, '*')
    await flushTasks()
    expect(received).toEqual([{ bvid: 'BV18vY969EHJ', title: '带货', reason: '标题关键词:带货', surface: '首页' }])
    expect(isFilterLogMessage({ type: FILTER_LOG_MESSAGE, payload: { bvid: 'x', title: '', reason: '', surface: '' } })).toBe(true)
    expect(isFilterLogMessage({ type: FILTER_LOG_MESSAGE, payload: { bvid: 'x', title: '', surface: '' } })).toBe(false)
    expect(isFilterLogMessage({ type: 'other', payload: { bvid: 'x', title: '', reason: 'r', surface: 's' } })).toBe(false)
    off()
  })

  it('win 缺省时静默跳过（非浏览器环境不炸）', () => {
    expect(() => pushFilterLogEvent(undefined, { bvid: 'x', title: '', reason: 'r', surface: 's' })).not.toThrow()
  })
})
