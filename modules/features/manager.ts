// 功能运行时管理器（Epic1-S1.2）：按「注入面 + 开关」编排所有功能的启动与停止。
// 功能自己只实现 start/stop（stop 必须把 DOM 还原到 B 站原样），何时启停全部由这里决定：
//   - 注入面变化（SPA 首页 ⇄ 视频页 ⇄ 其它页）：不在自己注入面上的功能立即 stop；
//   - 配置变化（storage 通知）：开关关掉 → stop；开关开且在面上 → start；
//     配置内容变化且仍在运行 → stop + start（用新配置重建，等价于「重新配置」）。
// AI 助手栈（面板/去广告/总结）不归这里管——它保持视频页专属的独立接线。

import type { FeatureConfigMap, FeatureEntry, FeatureId } from './config'
import { FEATURE_REGISTRY } from './config'
import { classifySurface, surfaceMatches, type PageSurface } from './surface'

/** 功能运行时契约：stop 之后页面必须回到 start 之前的样子（不留 class/样式/节点）。 */
export interface FeatureRuntime {
  start(): void
  stop(): void
}

/** 运行时工厂：拿自己的配置（含 enabled）构造运行时；启停时机由管理器决定。 */
export type FeatureRuntimeFactory = (entry: FeatureEntry) => FeatureRuntime

export const FEATURE_NAV_CHECK_INTERVAL_MS = 1_500

export interface FeatureManagerDeps {
  readConfigs: () => Promise<FeatureConfigMap>
  getHref: () => string
  setInterval: (handler: () => void, ms: number) => number
  clearInterval: (id: number) => void
  /** 订阅功能配置存储变化；返回退订函数。 */
  subscribeConfigChanges: (listener: () => void) => () => void
}

interface RegisteredFeature {
  factory: FeatureRuntimeFactory
  runtime: FeatureRuntime | null
  /** 最近一次 start 用的配置指纹（内容变化即重启）。 */
  configFingerprint: string
}

export class FeatureManager {
  private readonly registered = new Map<FeatureId, RegisteredFeature>()
  private configs: FeatureConfigMap | null = null
  private navTimer: number | null = null
  private unsubscribe: (() => void) | null = null
  private lastSurface: PageSurface | null = null

  constructor(private readonly deps: FeatureManagerDeps) {}

  /** 注册功能运行时（必须在 start 之前完成；重复注册以最后一次为准）。 */
  register(id: FeatureId, factory: FeatureRuntimeFactory): void {
    this.registered.set(id, { factory, runtime: null, configFingerprint: '' })
  }

  /** 启动管理器：读配置 → 订阅变化与导航 → 首次同步。失败不抛（管理器绝不能带崩宿主页）。 */
  async start(): Promise<void> {
    try {
      this.configs = await this.deps.readConfigs()
    } catch {
      this.configs = null
    }
    this.unsubscribe = this.deps.subscribeConfigChanges(() => void this.onConfigChanged())
    this.navTimer = this.deps.setInterval(() => this.sync(), FEATURE_NAV_CHECK_INTERVAL_MS)
    this.sync()
  }

  /** 停止一切（页面卸载/测试用）：逐个 stop 还原页面，摘掉监听。 */
  stop(): void {
    for (const id of [...this.registered.keys()]) this.stopRuntime(id)
    if (this.navTimer !== null) {
      this.deps.clearInterval(this.navTimer)
      this.navTimer = null
    }
    this.unsubscribe?.()
    this.unsubscribe = null
    this.lastSurface = null
  }

  /** 当前注入面（诊断用）。 */
  get surface(): PageSurface {
    return classifySurface(this.deps.getHref())
  }

  /** 同步一次：注入面 + 配置 → 该跑的 start、不该跑的 stop。可安全重入。 */
  sync(): void {
    const surface = classifySurface(this.deps.getHref())
    const surfaceChanged = surface !== this.lastSurface
    this.lastSurface = surface
    for (const [id, feature] of this.registered) {
      const entry = this.configs?.[id]
      const shouldRun =
        entry !== undefined &&
        entry.enabled &&
        surfaceMatches(FEATURE_REGISTRY[id].appliesTo, surface)
      if (!shouldRun) {
        this.stopRuntime(id)
        continue
      }
      const fingerprint = JSON.stringify(entry.config)
      if (feature.runtime === null || surfaceChanged || fingerprint !== feature.configFingerprint) {
        // 重建 = 重新配置：跨面回来的功能与配置内容变化的功能都用新配置从头开始。
        this.stopRuntime(id)
        this.startRuntime(id, entry, fingerprint)
      }
    }
  }

  private async onConfigChanged(): Promise<void> {
    try {
      this.configs = await this.deps.readConfigs()
    } catch {
      return // 配置读失败保持现状，等下一次变化或导航节拍重试。
    }
    this.sync()
  }

  private startRuntime(id: FeatureId, entry: FeatureEntry, fingerprint: string): void {
    const feature = this.registered.get(id)
    if (!feature || feature.runtime !== null) return
    try {
      const runtime = feature.factory(entry)
      runtime.start()
      feature.runtime = runtime
      feature.configFingerprint = fingerprint
    } catch (error) {
      // 运行时启动失败：保持「未运行」，绝不带崩页面；排障信息留在控制台。
      console.error(`[bili-helper:features] 功能启动失败 ${id}:`, String(error))
      feature.runtime = null
    }
  }

  private stopRuntime(id: FeatureId): void {
    const feature = this.registered.get(id)
    if (!feature || feature.runtime === null) return
    const runtime = feature.runtime
    feature.runtime = null
    feature.configFingerprint = ''
    try {
      runtime.stop()
    } catch (error) {
      console.error(`[bili-helper:features] 功能停止失败 ${id}:`, String(error))
    }
  }
}
