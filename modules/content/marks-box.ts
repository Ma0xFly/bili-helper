// 进度条标记层几何跟踪器：标记盒（ui.marksBox）唯一几何写入者之一。
// 从 ad-skip-controller 抽出的同一套防闪烁同步逻辑，供「广告标记」与「章节标记」
// 两类消费方各自实例化：盒子锚在 B 站进度条本体的实时几何上（相对播放器容器），
// 镜像控制层显隐；不相关的消费方（isRelevant=false）完全不写盒子——盒子归属相关方管理。
//
// 防闪烁三件套（与控制器时代同一口径）：
//   几何**取整**写入（亚像素抖动不产生新样式值，同值赋值不触发渲染）；
//   隐藏需**连续两拍**确认（控制层淡出动画的中间态与边界抖动不允许把标记闪没）；
//   显隐恢复立即（控制层出现时标记第一时间跟上）。

import { ui } from './ui-state'

/** 标记层跟随进度条的快速同步节拍（B 站控制层闲置淡出是亚秒级动画，2s 的玩家几何节拍跟不上）。 */
export const MARKS_SYNC_INTERVAL_MS = 250
/** 隐藏的确认拍数：250ms 一拍，连续两拍（约 500ms）确认不可见才隐藏。 */
export const MARKS_HIDE_CONFIRM_TICKS = 2

export interface TimerApi {
  setTimeout(handler: () => void, ms: number): number
  clearTimeout(id: number): void
  setInterval(handler: () => void, ms: number): number
  clearInterval(id: number): void
}

/** 播放器定位面（与 AdSkipController 的 PlayerAdapter 同构；控制器复用这里的定义）。 */
export interface MarksPlayerAdapter {
  findPlayerContainer(video: HTMLVideoElement): HTMLElement | null
  findProgressElement(container: HTMLElement | null): HTMLElement | null
}

export interface MarksBoxTrackerDeps {
  timers: TimerApi
  player: MarksPlayerAdapter
  /** 当前视频元素（可能尚未挂上）：null 走隐藏确认。 */
  getVideo: () => HTMLVideoElement | null
  /** 本消费方当下是否有可渲染标记：false 时整拍跳过（不写盒子，避免踩别的消费方）。 */
  isRelevant: () => boolean
  /** 同步节拍（默认 MARKS_SYNC_INTERVAL_MS）；测试可注入更快的节拍。 */
  intervalMs?: number
}

export class MarksBoxTracker {
  private timer: number | null = null
  /** 进度条本体缓存：SPA 内一般不变，脱离文档时重找。 */
  private barElement: HTMLElement | null = null
  /** 连续「不可见」观察拍数。 */
  private invisibleStreak = 0

  constructor(private readonly deps: MarksBoxTrackerDeps) {}

  get running(): boolean {
    return this.timer !== null
  }

  start(): void {
    if (this.timer !== null) return
    this.timer = this.deps.timers.setInterval(
      () => this.syncNow(),
      this.deps.intervalMs ?? MARKS_SYNC_INTERVAL_MS,
    )
    this.syncNow()
  }

  stop(): void {
    if (this.timer !== null) {
      this.deps.timers.clearInterval(this.timer)
      this.timer = null
    }
    this.barElement = null
    this.invisibleStreak = 0
    // 不动 ui.marksBox：各渲染组件自带 v-if 门控，盒子显隐由仍在运行的消费方接管。
  }

  /** 单拍同步（控制器 buildMarks 与章节接线层也会即时调用）。 */
  syncNow(): void {
    if (!this.deps.isRelevant()) return
    const markHidden = (): void => {
      this.invisibleStreak += 1
      if (ui.marksBox.visible && this.invisibleStreak >= MARKS_HIDE_CONFIRM_TICKS) {
        ui.marksBox.visible = false
      }
    }
    const video = this.deps.getVideo()
    if (!video) {
      markHidden()
      return
    }
    const container = this.deps.player.findPlayerContainer(video)
    const playerRect = container?.getBoundingClientRect() ?? video.getBoundingClientRect()
    const bar = this.resolveBarElement(container)
    if (!bar || playerRect.width <= 0 || playerRect.height <= 0) {
      markHidden()
      return
    }
    const barRect = bar.getBoundingClientRect()
    const centerY = barRect.top + barRect.height / 2
    // 收起动画可能把控制层整个下移出播放器：中心线出界即视为不可见。
    const insidePlayer =
      barRect.width > 0 && centerY >= playerRect.top - 2 && centerY <= playerRect.bottom + 2
    if (!(insidePlayer && barEffectivelyVisible(bar, container))) {
      markHidden()
      return
    }
    this.invisibleStreak = 0
    ui.marksBox.visible = true
    ui.marksBox.left = Math.round(barRect.left - playerRect.left)
    ui.marksBox.top = Math.round(centerY - playerRect.top)
    ui.marksBox.width = Math.round(barRect.width)
  }

  /** 播放器几何变化/全屏切换后要求重找进度条本体（盒内相对几何由各拍重算）。 */
  requestRemesh(): void {
    this.barElement = null
  }

  private resolveBarElement(container: HTMLElement | null): HTMLElement | null {
    if (this.barElement?.isConnected) return this.barElement
    this.barElement = this.deps.player.findProgressElement(container)
    return this.barElement
  }
}

/** B 站控制层隐藏有 opacity 淡出 / visibility / display 三种形态，从进度条逐层向上查到播放器容器。 */
export function barEffectivelyVisible(bar: HTMLElement, container: HTMLElement | null): boolean {
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return true
  let node: HTMLElement | null = bar
  while (node) {
    try {
      const style = window.getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden') return false
      const opacity = Number.parseFloat(style.opacity)
      if (Number.isFinite(opacity) && opacity < 0.08) return false
    } catch {
      return true // 样式读不到时保守视为可见，不误杀标记。
    }
    if (container && node === container) break
    node = node.parentElement
  }
  return true
}
