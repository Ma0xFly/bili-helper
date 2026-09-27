// 进度条标记原生一体化：把广告底段与章节刻度注入 B 站原生进度条内部（轻 DOM），
// 让标记长在进度条里而不是浮在它上面。注入层 pointer-events:none——点击、拖拽、
// 悬停预览全部归原生进度条；「点在章节刻度上」经原生 seek 自然跳到章节起点，
// 不再存在第二套点击逻辑。悬停提示（章节标题/商品名/「不是广告」）仍由 Shadow
// 浮层渲染（保留设计 token 与按钮可达性），由注入层在原生条上的 mousemove 驱动。
//
// 回退：原生条找不到（B 站改版）或注入异常时置 ui.nativeMarksActive=false，
// Shadow 层旧「几何镜像」渲染接管（MarksBoxTracker 口径），语义同现状。
//
// 轻 DOM 拿不到 Shadow root 的 --bh-* token：注入样式用 NATIVE_MARK_COLORS 常量
// 生成（亮暗两套经容器 data-bhx-dark 切换），tests/theme-tokens.test.ts 把该常量
// 与 overlay.css 的 token 对账，防止两处漂移。

import { ui } from './ui-state'
import type { AdMarkState, ChapterMarkState } from './ui-state'
import type { TimerApi, MarksPlayerAdapter } from './marks-box'

/** 与 overlay.css token 同值（亮/暗成对）；theme-tokens 测试对账。 */
export const NATIVE_MARK_COLORS = {
  adFillLight: '#ff8fb1',
  adFillDark: '#ffa0bd',
  tickOfficialLight: '#7c5cfc',
  tickOfficialDark: '#9c85ff',
  tickAiLight: '#b47cf5',
  tickAiDark: '#c29bf8',
} as const

/** B 站原生进度条（点击/悬停宿主）。 */
const NATIVE_BAR_SELECTOR = '.bpx-player-progress'
/** 注入样式与容器的命名空间（stop() 后零残留）。 */
const STYLE_ID = 'bili-helper-native-marks-style'
const CONTAINER_CLASS = 'bhx-marks'
/** 悬停命中章节刻度的横向容差（px）。 */
const CHAPTER_HIT_PX = 8
/** 指针从进度条移向提示卡（跨过原生预览区）的保活时长。 */
const HOVER_GRACE_MS = 500
/** 心跳：检查注入是否还活着（B 站重建播放器后重注入）。 */
const HEARTBEAT_MS = 1_000

const NATIVE_MARKS_CSS = `
.${CONTAINER_CLASS} {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: visible;
}
.${CONTAINER_CLASS} .bhx-ad {
  position: absolute;
  top: 0;
  height: 100%;
  border-radius: 2px;
  background: ${NATIVE_MARK_COLORS.adFillLight};
  opacity: 0.85;
}
.${CONTAINER_CLASS} .bhx-ad.done { opacity: 0.55; }
.${CONTAINER_CLASS} .bhx-tick {
  position: absolute;
  top: 50%;
  width: 2px;
  height: 9px;
  border-radius: 1px;
  transform: translate(-50%, -50%);
  background: ${NATIVE_MARK_COLORS.tickOfficialLight};
  opacity: 0.55;
}
.${CONTAINER_CLASS} .bhx-tick.ai {
  background: ${NATIVE_MARK_COLORS.tickAiLight};
  opacity: 0.4;
}
.${CONTAINER_CLASS}[data-bhx-dark] .bhx-ad { background: ${NATIVE_MARK_COLORS.adFillDark}; }
.${CONTAINER_CLASS}[data-bhx-dark] .bhx-tick { background: ${NATIVE_MARK_COLORS.tickOfficialDark}; }
.${CONTAINER_CLASS}[data-bhx-dark] .bhx-tick.ai { background: ${NATIVE_MARK_COLORS.tickAiDark}; }
`

/** 从进度条候选元素解析注入宿主：优先整条；命中「已播/缓冲填充」时上溯，避免注进会生长的填充层。 */
export function resolveNativeBar(
  candidate: HTMLElement | null,
  container: HTMLElement | null,
): HTMLElement | null {
  const direct = container?.querySelector<HTMLElement>(NATIVE_BAR_SELECTOR)
  if (direct) return direct
  if (!candidate) return null
  if (candidate.matches(NATIVE_BAR_SELECTOR)) return candidate
  const ancestor = candidate.closest<HTMLElement>(NATIVE_BAR_SELECTOR)
  if (ancestor) return ancestor
  // 旧选择器族命中填充/轨道层：上溯到 wrap 或父级（保证是全宽、稳定的几何面）。
  if (/schedule-(inner|current|buffer)/.test(candidate.className)) {
    return candidate.parentElement
  }
  return null
}

export interface NativeMarksInjectorDeps {
  timers: TimerApi
  player: MarksPlayerAdapter
  getVideo: () => HTMLVideoElement | null
  /** 数据源（ui.marks / ui.chapterMarks 的镜像；注入层不直接 import ui，便于单测）。 */
  getMarks: () => AdMarkState[]
  getChapters: () => ChapterMarkState[]
  getDark: () => boolean
}

export class NativeMarksInjector {
  private container: HTMLElement | null = null
  private styleElement: HTMLStyleElement | null = null
  private heartbeat: number | null = null
  private signature = ''
  private barElement: HTMLElement | null = null
  private lastHoverEmit = ''
  private hideTimer: number | null = null
  /** 回退一次性日志哨兵：B 站改版注入失败只提醒一次，不刷屏。 */
  private fallbackLogged = false

  private readonly onBarMouseMove: (event: MouseEvent) => void
  private readonly onBarMouseLeave: () => void

  constructor(private readonly deps: NativeMarksInjectorDeps) {
    this.onBarMouseMove = (event) => this.handleMouseMove(event)
    this.onBarMouseLeave = () => this.scheduleHide()
  }

  start(): void {
    if (this.heartbeat !== null) return
    this.heartbeat = this.deps.timers.setInterval(() => this.sync(), HEARTBEAT_MS)
    this.sync()
  }

  stop(): void {
    if (this.heartbeat !== null) {
      this.deps.timers.clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    this.teardown()
  }

  /** 全屏切换等场景：立即重找进度条并重注入（不等心跳）。 */
  recheck(): void {
    this.barElement = null
    this.sync()
  }

  dispose(): void {
    this.stop()
  }

  /** 悬停提示卡被指针进入：取消挂起的隐藏（广告提示里的「不是广告」按钮需要可达）。 */
  keepHover(): void {
    if (this.hideTimer !== null) {
      this.deps.timers.clearTimeout(this.hideTimer)
      this.hideTimer = null
    }
  }

  /** 悬停提示卡被指针离开：立即收起。 */
  endHover(): void {
    this.clearHideTimer()
    this.emitHover(null)
  }

  /** 单拍同步：确保注入活着、按数据签名重渲染、亮暗属性跟上。 */
  sync(): void {
    const marks = this.deps.getMarks()
    const chapters = this.deps.getChapters()
    const dark = this.deps.getDark()
    const nextSignature = JSON.stringify([marks, chapters, dark])
    if (nextSignature === this.signature && this.container?.isConnected) return
    // 数据/亮暗变化：旧提示立即作废（换视频后不得残留上一支视频的提示）。
    this.signature = nextSignature
    this.emitHover(null)

    if (marks.length === 0 && chapters.length === 0) {
      this.teardown()
      return
    }
    const bar = this.ensureInjected()
    if (!bar) {
      // 原生条不可用：回退形态（Shadow 层几何镜像接管），提示态一并清空。
      if (!this.fallbackLogged) {
        this.fallbackLogged = true
        console.info('[bili-helper] 进度条标记：未找到原生进度条（B 站改版？），回退浮层标记形态')
      }
      this.emitHover(null)
      return
    }
    this.fallbackLogged = false
    this.render(marks, chapters, dark)
  }

  // ---------- 内部 ----------

  private ensureInjected(): HTMLElement | null {
    if (this.container?.isConnected && this.barElement?.isConnected) return this.barElement
    const video = this.deps.getVideo()
    if (!video) return null
    const playerContainer = this.deps.player.findPlayerContainer(video)
    const candidate = this.deps.player.findProgressElement(playerContainer)
    const bar = resolveNativeBar(candidate, playerContainer)
    if (!bar) {
      this.teardown()
      return null
    }
    try {
      this.injectStyleOnce()
      const container = window.document.createElement('div')
      container.className = CONTAINER_CLASS
      // 插在 B 站自己的标记层（point-wrap）之前：官方标记在上，本扩展标记补充在下。
      const pointWrap = bar.querySelector<HTMLElement>('.bpx-player-progress-point-wrap')
      if (pointWrap) {
        bar.insertBefore(container, pointWrap)
      } else {
        bar.appendChild(container)
      }
      this.container = container
      this.barElement = bar
      bar.addEventListener('mousemove', this.onBarMouseMove)
      bar.addEventListener('mouseleave', this.onBarMouseLeave)
      ui.nativeMarksActive = true
      return bar
    } catch {
      // 注入被页面策略拒绝等（罕见）：回退形态。
      this.teardown()
      return null
    }
  }

  private injectStyleOnce(): void {
    if (this.styleElement?.isConnected) return
    const style = window.document.createElement('style')
    style.id = STYLE_ID
    style.textContent = NATIVE_MARKS_CSS
    ;(window.document.head ?? window.document.documentElement).appendChild(style)
    this.styleElement = style
  }

  private render(marks: AdMarkState[], chapters: ChapterMarkState[], dark: boolean): void {
    const container = this.container
    if (!container) return
    if (dark) container.dataset.bhxDark = 'true'
    else delete container.dataset.bhxDark
    container.textContent = ''
    for (const mark of marks) {
      const el = window.document.createElement('div')
      el.className = mark.done ? 'bhx-ad done' : 'bhx-ad'
      el.style.left = `${mark.leftPct}%`
      el.style.width = `${Math.max(mark.widthPct, 0.2)}%`
      el.dataset.key = mark.key
      container.appendChild(el)
    }
    for (const chapter of chapters) {
      const el = window.document.createElement('div')
      el.className = chapter.source === 'ai' ? 'bhx-tick ai' : 'bhx-tick'
      el.style.left = `${chapter.leftPct}%`
      el.dataset.key = chapter.key
      container.appendChild(el)
    }
  }

  private handleMouseMove(event: MouseEvent): void {
    const bar = this.barElement
    if (!bar || !this.container?.isConnected) return
    this.clearHideTimer()
    const rect = bar.getBoundingClientRect()
    if (rect.width <= 0) return
    const fractionPct = ((event.clientX - rect.left) / rect.width) * 100
    const chapterHitPct = (CHAPTER_HIT_PX / rect.width) * 100

    const chapter = this.deps
      .getChapters()
      .find((item) => Math.abs(item.leftPct - fractionPct) <= chapterHitPct)
    const ad =
      chapter === undefined
        ? this.deps
            .getMarks()
            .find((item) => fractionPct >= item.leftPct && fractionPct <= item.leftPct + item.widthPct)
        : undefined

    if (chapter === undefined && ad === undefined) {
      this.emitHover(null)
      return
    }
    // 提示锚点换算到播放器容器坐标（Shadow 浮层 .bh-overlay 与容器同矩形）。
    const video = this.deps.getVideo()
    const playerContainer = video ? this.deps.player.findPlayerContainer(video) : null
    const playerRect =
      playerContainer?.getBoundingClientRect() ?? video?.getBoundingClientRect() ?? null
    if (!playerRect) return
    const left = Math.min(Math.max(event.clientX - playerRect.left, 80), playerRect.width - 80)
    const previewHeight = this.nativePreviewHeight(bar)
    const bottom = playerRect.bottom - rect.top + previewHeight + 10
    this.emitHover({
      chapter: chapter ?? null,
      ad: ad ?? null,
      left: Math.round(left),
      bottom: Math.round(bottom),
    })
  }

  /** 原生悬停预览的可见高度：提示卡要落在预览之上，别盖住缩略图。 */
  private nativePreviewHeight(bar: HTMLElement): number {
    const preview = bar.querySelector<HTMLElement>('.bpx-player-progress-preview')
    if (!preview || /hidden/.test(preview.className)) return 0
    return preview.getBoundingClientRect().height
  }

  private scheduleHide(): void {
    this.clearHideTimer()
    this.hideTimer = this.deps.timers.setTimeout(() => {
      this.hideTimer = null
      this.emitHover(null)
    }, HOVER_GRACE_MS)
  }

  private clearHideTimer(): void {
    if (this.hideTimer !== null) {
      this.deps.timers.clearTimeout(this.hideTimer)
      this.hideTimer = null
    }
  }

  /** 向 ui 写悬停提示；与上次完全一致时跳过（mousemove 高频，别打扰渲染）。 */
  private emitHover(
    info: { chapter: ChapterMarkState | null; ad: AdMarkState | null; left: number; bottom: number } | null,
  ): void {
    const fingerprint = info
      ? `${info.chapter?.key ?? ''}|${info.ad?.key ?? ''}|${info.left}|${info.bottom}`
      : ''
    if (fingerprint === this.lastHoverEmit) return
    this.lastHoverEmit = fingerprint
    if (info === null) {
      ui.barHover.active = false
      ui.barHover.chapter = null
      ui.barHover.ad = null
      return
    }
    ui.barHover.active = true
    ui.barHover.left = info.left
    ui.barHover.bottom = info.bottom
    ui.barHover.chapter = info.chapter
    ui.barHover.ad = info.ad
  }

  /** 摘除注入（回退/数据清空/dispose 共用）：节点、样式、监听、提示态全清。 */
  private teardown(): void {
    this.clearHideTimer()
    this.emitHover(null)
    if (this.barElement) {
      this.barElement.removeEventListener('mousemove', this.onBarMouseMove)
      this.barElement.removeEventListener('mouseleave', this.onBarMouseLeave)
    }
    this.barElement = null
    this.container?.remove()
    this.container = null
    this.styleElement?.remove()
    this.styleElement = null
    this.signature = ''
    ui.nativeMarksActive = false
  }
}
