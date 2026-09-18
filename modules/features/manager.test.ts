// 功能管理器测试（Epic1-S1.2）：注入面切换启停、开关变化启停、配置内容变化重建、
// 启动失败不带崩页面、stop 全还原。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeatureConfigMap, FeatureEntry, FeatureId } from './config'
import { DEFAULT_DUMMY_CONFIGS, entryOf } from './test-utils'
import { FEATURE_NAV_CHECK_INTERVAL_MS, FeatureManager } from './manager'

const HOME = 'https://www.bilibili.com/'
const VIDEO = 'https://www.bilibili.com/video/BV18vY969EHJ/'

interface RuntimeLog {
  started: number
  stopped: number
  lastEntry: FeatureEntry | null
}

function makeRuntimeFactory(log: RuntimeLog, failOnStart = false) {
  return (entry: FeatureEntry) => ({
    start() {
      log.lastEntry = entry
      log.started += 1
      if (failOnStart) throw new Error('boom')
    },
    stop() {
      log.stopped += 1
    },
  })
}

interface Harness {
  manager: FeatureManager
  configs: FeatureConfigMap
  href: string
  fireConfigChange: () => void
  logs: Record<string, RuntimeLog>
  register: (id: FeatureId, failOnStart?: boolean) => RuntimeLog
}

async function makeHarness(initialHref: string): Promise<Harness> {
  let href = initialHref
  const configs: FeatureConfigMap = JSON.parse(JSON.stringify(DEFAULT_DUMMY_CONFIGS))
  const configListeners: Array<() => void> = []
  const logs: Record<string, RuntimeLog> = {}
  const timers: Array<() => void> = []
  const manager = new FeatureManager({
    readConfigs: async () => JSON.parse(JSON.stringify(configs)),
    getHref: () => href,
    setInterval: (handler) => {
      timers.push(handler)
      return timers.length
    },
    clearInterval: () => {},
    subscribeConfigChanges: (listener) => {
      configListeners.push(listener)
      return () => {
        const index = configListeners.indexOf(listener)
        if (index >= 0) configListeners.splice(index, 1)
      }
    },
  })
  return {
    manager,
    configs,
    get href() {
      return href
    },
    set href(next: string) {
      href = next
    },
    fireConfigChange: () => configListeners.forEach((listener) => listener()),
    logs,
    register(id: FeatureId, failOnStart = false): RuntimeLog {
      const log: RuntimeLog = { started: 0, stopped: 0, lastEntry: null }
      logs[id] = log
      manager.register(id, makeRuntimeFactory(log, failOnStart))
      return log
    },
  }
}

// 导航节拍：直接调 manager.sync() 模拟（真实实现里由 interval 驱动同一函数）。
beforeEach(() => {
  vi.clearAllMocks()
})

describe('FeatureManager', () => {
  it('开关开且在自己的注入面 → start；关着/不在面上 → 不 start', async () => {
    const h = await makeHarness(HOME)
    const videoFilter = h.register('videoFilter')
    const stepless = h.register('steplessVideoRate')
    await h.manager.start()

    expect(videoFilter.started).toBe(1) // 首页功能在首页
    expect(stepless.started).toBe(0) // 视频页功能在首页不跑
  })

  it('SPA 首页 → 视频页：首页功能 stop，视频页功能 start；回到首页再互换', async () => {
    const h = await makeHarness(HOME)
    const filter = h.register('videoFilter')
    const split = h.register('leftRightSplitScreen')
    await h.manager.start()
    expect(filter.started).toBe(1)
    expect(split.started).toBe(0)

    h.href = VIDEO
    h.manager.sync()
    expect(filter.stopped).toBe(1)
    expect(split.started).toBe(1)

    h.href = HOME
    h.manager.sync()
    expect(split.stopped).toBe(1)
    expect(filter.started).toBe(2) // 跨面回来：用新配置重建
  })

  it('同面内配置内容变化 → stop + start 重建（重新配置）', async () => {
    const h = await makeHarness(HOME)
    const filter = h.register('videoFilter')
    await h.manager.start()

    h.configs.videoFilter = entryOf('videoFilter', {
      titleKeywords: ['广告'],
    } as never)
    h.fireConfigChange()
    await vi.waitFor(() => expect(filter.started).toBe(2))
    expect(filter.stopped).toBe(1)
    expect((filter.lastEntry?.config as { titleKeywords?: string[] }).titleKeywords).toEqual(['广告'])
  })

  it('开关关掉 → stop；再开 → start', async () => {
    const h = await makeHarness(HOME)
    const filter = h.register('videoFilter')
    await h.manager.start()

    h.configs.videoFilter.enabled = false
    h.fireConfigChange()
    await vi.waitFor(() => expect(filter.stopped).toBe(1))
    expect(filter.started).toBe(1)

    h.configs.videoFilter.enabled = true
    h.fireConfigChange()
    await vi.waitFor(() => expect(filter.started).toBe(2))
  })

  it('非注入面（搜索/分区页）谁都别跑；运行中的也停掉', async () => {
    const h = await makeHarness(HOME)
    const filter = h.register('videoFilter')
    await h.manager.start()
    expect(filter.started).toBe(1)

    h.href = 'https://search.bilibili.com/all?keyword=x'
    h.manager.sync()
    expect(filter.stopped).toBe(1)
  })

  it('运行时 start 抛错：不入运行态、不带崩管理器，下一拍仍可重试', async () => {
    const h = await makeHarness(HOME)
    const filter = h.register('videoFilter', true)
    await h.manager.start()
    expect(filter.started).toBe(1) // 尝试过
    // 未进入运行态（没有 stop 调用），导航节拍重试会再次尝试。
    h.manager.sync()
    expect(filter.started).toBe(2)
  })

  it('manager.stop()：全部停止并还原，监听摘除', async () => {
    const h = await makeHarness(HOME)
    const filter = h.register('videoFilter')
    await h.manager.start()
    h.manager.stop()
    expect(filter.stopped).toBe(1)
    // stop 后配置变化不再触发启停。
    h.configs.videoFilter.enabled = false
    h.fireConfigChange()
    expect(filter.started).toBe(1)
  })

  it('导航节拍常量仍为 1.5s（SPA 判定的响应上限）', () => {
    expect(FEATURE_NAV_CHECK_INTERVAL_MS).toBe(1500)
  })
})
