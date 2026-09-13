// AI 去广告内容脚本核心状态机（可注入依赖、可单测）：
// 采集 → detectAds（strategy 固定 smart）→ 播放器监听（倒计时/自动跳过/手动拖入立即跳过）→
// 进度条标记/成就统计；页内开关与总开关 gate 一切跳转逻辑；
// SPA 换视频（bvid 变化）时整体复位重跑，失败的链路允许冷却后重试。
// DOM 定位、计时器、存储读写全部经 deps 注入；本模块除了响应式 ui 状态外不触宿主页面。

import type { AiSettings } from '../settings'
import type { AiCapabilities, AdSegment, DetectAdsInput, DetectAdsResult } from '../ai/port'
import type { Comment, Danmaku, Subtitle, VideoMeta } from '../video/types'
import type { DetectHooks } from '../ai/rag/detect'
import { extractBvidFromUrl } from '../video/collectors'
import type { AdSkipPageState, AdSkipToggleResponse } from './protocol'
import {
  BANNER_LEAD_SECONDS,
  SEEK_VERIFY_TOLERANCE_SECONDS,
  bannerCopy,
  bannerSubCopy,
  countdownAdAt,
  countdownSeconds,
  formatHms,
  insideAdAt,
  savedChipText,
  segmentKey,
  shouldSkipManually,
  sortedAds,
} from './logic'
import { ui } from './ui-state'

export const VIDEO_WAIT_TIMEOUT_MS = 15_000
export const CHIP_DISPLAY_MS = 4_000
export const VECTOR_HINT_DISPLAY_MS = 12_000
export const COUNTDOWN_TICK_MS = 100
export const MANUAL_BANNER_MS = 350
export const SEEK_VERIFY_DELAY_MS = 250
export const MEASURE_INTERVAL_MS = 2_000
/** 失败链路的重试冷却：周期检查按此节流，避免端点故障时疯狂重打。 */
export const RETRY_COOLDOWN_MS = 10_000

export interface TimerApi {
  setTimeout(handler: () => void, ms: number): number
  clearTimeout(id: number): void
  setInterval(handler: () => void, ms: number): number
  clearInterval(id: number): void
}

export interface PlayerAdapter {
  findVideo(): HTMLVideoElement | null
  waitForVideo(timeoutMs: number): Promise<HTMLVideoElement | null>
  findPlayerContainer(video: HTMLVideoElement): HTMLElement | null
  findProgressElement(container: HTMLElement | null): HTMLElement | null
}

export interface AdSkipControllerDeps {
  timers: TimerApi
  now: () => number
  player: PlayerAdapter
  pageHref: () => string
  isDark: () => boolean
  collectVideoMeta: () => Promise<VideoMeta | null>
  collectSubtitles: (video: VideoMeta) => Promise<Subtitle[]>
  collectDanmaku: (video: VideoMeta) => Promise<Danmaku[]>
  collectComments: (video: VideoMeta) => Promise<Comment[]>
  readSettings: () => Promise<AiSettings>
  createBackend: (settings: AiSettings, hooks: DetectHooks) => Pick<AiCapabilities, 'detectAds'>
  recordSkipped: (segmentKey: string, savedSeconds: number) => Promise<number | null>
  openOptions: () => void
}

export class AdSkipController {
  private masterEnabled = false
  private pageEnabled = true
  private running = false
  private pipelineStarted = false
  private lastAttemptAt = 0
  private activeBvid: string | null = null
  private player: HTMLVideoElement | null = null
  private videoMeta: VideoMeta | null = null
  private ads: AdSegment[] = []
  private bannerAd: AdSegment | null = null
  private optedOut = new Set<string>()
  private skippedOnce = new Set<string>()
  private skipScheduled = new Set<string>()
  private hintShown = false

  /**
   * 降级一次性提示（报错式不静默）：向量故障 / 对话故障退极速匹配共用同一出口，
   * 同视频只出现一次，展示 VECTOR_HINT_DISPLAY_MS 后自动消失。
   */
  private showHint(text: string): void {
    if (this.hintShown || !this.pageEnabled || !this.masterEnabled) return
    this.hintShown = true
    ui.vectorHint.text = text
    ui.vectorHint.visible = true
    this.deps.timers.setTimeout(() => {
      ui.vectorHint.visible = false
    }, VECTOR_HINT_DISPLAY_MS)
  }
  private countdownTimer: number | null = null
  private measureTimer: number | null = null
  private chipTimer: number | null = null
  private lastRectKey = ''

  private readonly onTick = (): void => {
    this.onTimeUpdate()
  }
  private readonly onResize = (): void => {
    this.measureIfMoved()
  }
  private readonly onScroll = (): void => {
    this.measureIfMoved()
  }
  private readonly onFullscreen = (): void => {
    this.lastRectKey = ''
    this.measureIfMoved()
  }
  private readonly onMeasureTick = (): void => {
    this.measureIfMoved()
  }

  constructor(private readonly deps: AdSkipControllerDeps) {
    ui.actions.onSkipNow = () => {
      if (this.bannerAd && this.pageEnabled && this.masterEnabled) {
        void this.performSkip(this.bannerAd)
      }
    }
    ui.actions.onStay = () => {
      // 「这段想看」：唯一反悔出口，本次播放不再打扰该段（页内状态，不持久化）。
      if (this.bannerAd) {
        this.optedOut.add(segmentKey(this.bannerAd))
        this.hideBanner()
      }
    }
    ui.actions.onOpenSettings = () => this.deps.openOptions()
  }

  // ---------- 启动 / 生命周期 ----------

  /** 启动：读设置（总开关）并按需跑管线。测试与接线方都应 await 这一次初始管线。 */
  async start(): Promise<void> {
    this.applyDark()
    let settings: AiSettings | null = null
    try {
      settings = await this.deps.readSettings()
    } catch {
      settings = null
    }
    this.masterEnabled = settings?.adSkipEnabled === true
    if (this.masterEnabled && this.pageEnabled) {
      await this.runPipeline()
    }
  }

  dispose(): void {
    this.detachPlayer()
    this.stopCountdown()
    if (this.chipTimer !== null) {
      this.deps.timers.clearTimeout(this.chipTimer)
      this.chipTimer = null
    }
    ui.banner.visible = false
    ui.chip.visible = false
    ui.ads = []
  }

  // ---------- 设置 / 消息入口 ----------

  /** options 页改了总开关（storage.onChanged 同步过来）。 */
  syncMasterEnabled(master: boolean): void {
    if (master === this.masterEnabled) return
    this.masterEnabled = master
    this.applyPageVisibility()
    if (!master) this.hideBanner()
    if (this.masterEnabled && this.pageEnabled && !this.pipelineStarted) {
      this.lastAttemptAt = 0
      void this.runPipeline()
    }
  }

  /** popup 快开关（页内临时开关，不跨页持久化）；enabled 非布尔回 ok:false。 */
  handleToggleMessage(enabled: unknown): AdSkipToggleResponse {
    if (typeof enabled !== 'boolean') {
      return { ok: false, state: this.getState() }
    }
    this.pageEnabled = enabled
    this.applyPageVisibility()
    if (this.pageEnabled && this.masterEnabled && !this.pipelineStarted) {
      this.lastAttemptAt = 0
      void this.runPipeline()
    }
    return { ok: true, state: this.getState() }
  }

  getState(): AdSkipPageState {
    return { available: true, pageEnabled: this.pageEnabled, masterEnabled: this.masterEnabled }
  }

  /** SPA 导航检查：bvid 变了就整机复位重跑（index 以周期性检查 + URL 变化的 DOM 观测调用）。 */
  checkNavigation(): void {
    const bvid = extractBvidFromUrl(this.deps.pageHref())
    if (!bvid) return
    if (this.activeBvid === null) {
      this.retryIfNeeded()
      return
    }
    if (bvid !== this.activeBvid) {
      this.resetForNavigation()
      if (this.masterEnabled && this.pageEnabled) void this.runPipeline()
    }
  }

  /** 失败链路的重试入口（冷却节流）：视频晚就绪/端点瞬时故障都能恢复。 */
  retryIfNeeded(): void {
    if (!this.masterEnabled || !this.pageEnabled) return
    if (this.running || this.pipelineStarted) return
    const now = this.deps.now()
    if (this.lastAttemptAt !== 0 && now - this.lastAttemptAt < RETRY_COOLDOWN_MS) return
    this.lastAttemptAt = now
    void this.runPipeline()
  }

  // ---------- 采集 + 检测管线 ----------

  private async runPipeline(): Promise<void> {
    if (this.running) return
    if (!this.masterEnabled || !this.pageEnabled) return
    this.running = true
    this.lastAttemptAt = this.deps.now()
    try {
      const meta = await this.deps.collectVideoMeta()
      if (!meta) return // 元数据取不到：静默（等价 source:none），pipelineStarted 保持 false 可重试。
      this.activeBvid = meta.bvid
      this.videoMeta = meta
      const [subtitles, danmaku, comments] = await Promise.all([
        this.deps.collectSubtitles(meta),
        this.deps.collectDanmaku(meta),
        this.deps.collectComments(meta),
      ])

      let settings: AiSettings
      try {
        settings = await this.deps.readSettings()
      } catch {
        return
      }
      this.masterEnabled = settings.adSkipEnabled
      if (!this.masterEnabled || !this.pageEnabled) return

      const backend = this.deps.createBackend(settings, {
        onVectorFallback: () => {
          this.showHint('向量端点（Embedding）的 API 有问题，暂时只用词表匹配')
        },
        onRetrievalOnly: () => {
          this.showHint('对话端点这次没响应，先用极速匹配（仅检索）跳广告')
        },
      })

      let result: DetectAdsResult
      try {
        result = await backend.detectAds({
          video: meta,
          subtitles,
          danmaku,
          comments,
          strategy: 'smart',
        })
      } catch {
        // 端点未配置（config）/后端失败：静默不弹 UI；pipelineStarted 保持 false，冷却后重试。
        return
      }
      if (!this.pageEnabled || !this.masterEnabled) return
      this.ads = sortedAds(result.ads)
      ui.ads = [...this.ads]
      if (this.ads.length === 0) {
        this.pipelineStarted = true // 无广告 = 链路成功走完，静默既是终点。
        return
      }
      const video = await this.deps.player.waitForVideo(VIDEO_WAIT_TIMEOUT_MS)
      if (!video) return // 播放器未就绪：保持可重试（冷却节流）。
      this.attachPlayer(video)
      this.pipelineStarted = true
    } finally {
      this.running = false
    }
  }

  // ---------- 播放器接线 / 几何做标 ----------

  private attachPlayer(video: HTMLVideoElement): void {
    this.detachPlayer()
    this.player = video
    video.addEventListener('timeupdate', this.onTick)
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.onResize)
      window.addEventListener('scroll', this.onScroll, true)
      window.document.addEventListener('fullscreenchange', this.onFullscreen)
    }
    this.measureTimer = this.deps.timers.setInterval(this.onMeasureTick, MEASURE_INTERVAL_MS)
    this.measureGeometry()
  }

  private detachPlayer(): void {
    if (this.player) this.player.removeEventListener('timeupdate', this.onTick)
    this.player = null
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.onResize)
      window.removeEventListener('scroll', this.onScroll, true)
      window.document.removeEventListener('fullscreenchange', this.onFullscreen)
    }
    if (this.measureTimer !== null) {
      this.deps.timers.clearInterval(this.measureTimer)
      this.measureTimer = null
    }
    this.stopCountdown()
  }

  /** 换视频/开关切换后要求重做标；fullscreenchange 也经此刷新。 */
  requestRemesh(): void {
    this.lastRectKey = ''
    this.measureIfMoved()
  }

  private measureGeometry(): void {
    const video = this.player
    const container = video ? this.deps.player.findPlayerContainer(video) : null
    const rect = container?.getBoundingClientRect() ?? video?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      ui.overlay.visible = false
      return
    }
    ui.overlay.visible = true
    ui.overlay.left = rect.left
    ui.overlay.top = rect.top
    ui.overlay.width = rect.width
    ui.overlay.height = rect.height
    this.buildMarks(rect, container)
  }

  private buildMarks(playerRect: DOMRect, container: HTMLElement | null): void {
    if (!this.pageEnabled || !this.masterEnabled || this.ads.length === 0) {
      ui.marks = []
      return
    }
    const total = this.videoMeta?.duration || this.player?.duration || 0
    const barRect = this.deps.player.findProgressElement(container)?.getBoundingClientRect()
    const barCenterPct =
      barRect && playerRect.height > 0
        ? ((barRect.top + barRect.height / 2 - playerRect.top) / playerRect.height) * 100
        : 94
    ui.marks = this.ads.map((ad) => {
      const key = segmentKey(ad)
      const leftPct = total > 0 ? (ad.start / total) * 100 : 0
      const widthPct = total > 0 ? Math.max(((ad.end - ad.start) / total) * 100, 0.6) : 0.6
      const clampedLeft = Math.min(leftPct, 99)
      return {
        key,
        leftPct: clampedLeft,
        widthPct: Math.min(widthPct, 100 - clampedLeft),
        topPct: barCenterPct,
        productName: ad.product_name,
        range: `${formatHms(ad.start)} – ${formatHms(ad.end)}`,
        done: this.skippedOnce.has(key),
      }
    })
  }

  private measureIfMoved(): void {
    const video = this.player
    const container = video ? this.deps.player.findPlayerContainer(video) : null
    const rect = container?.getBoundingClientRect() ?? video?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return
    const key = `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`
    if (key !== this.lastRectKey) {
      this.lastRectKey = key
      this.measureGeometry()
    }
  }

  // ---------- 亮暗主题 ----------

  applyDark(): void {
    const dark = this.deps.isDark()
    if (dark !== ui.dark) ui.dark = dark
  }

  // ---------- 提示条 / 倒计时 / 跳过 ----------

  private showBanner(ad: AdSegment): void {
    this.bannerAd = ad
    ui.banner.copy = bannerCopy(ad)
    ui.banner.sub = bannerSubCopy(ad)
    ui.banner.countdown = this.player ? countdownSeconds(ad, this.player.currentTime) : 3
    ui.banner.progress = 1
    ui.banner.visible = true
    ui.chip.visible = false
  }

  private showManualBanner(ad: AdSegment): void {
    this.showBanner(ad)
    // 手动拖入态：静态环、无数字——提示即跳，不给倒计时。
    ui.banner.countdown = null
    ui.banner.progress = 0
  }

  private hideBanner(): void {
    this.bannerAd = null
    ui.banner.visible = false
    this.stopCountdown()
  }

  private stopCountdown(): void {
    if (this.countdownTimer !== null) {
      this.deps.timers.clearInterval(this.countdownTimer)
      this.countdownTimer = null
    }
  }

  private startCountdown(ad: AdSegment): void {
    this.stopCountdown()
    this.countdownTimer = this.deps.timers.setInterval(() => {
      if (this.bannerAd !== ad) {
        this.stopCountdown()
        return
      }
      this.tickCountdown(ad)
    }, COUNTDOWN_TICK_MS)
  }

  tickCountdown(ad: AdSegment): void {
    if (!this.masterEnabled || !this.pageEnabled || !this.player || this.bannerAd !== ad) {
      this.stopCountdown()
      if (!this.bannerAd) ui.banner.visible = false
      return
    }
    const remaining = ad.start - this.player.currentTime
    ui.banner.progress = Math.min(1, Math.max(0, remaining / BANNER_LEAD_SECONDS))
    ui.banner.countdown = countdownSeconds(ad, this.player.currentTime)
    if (remaining <= 0) {
      // 归零铁律：不点任何按钮也自动跳过。
      this.stopCountdown()
      void this.performSkip(ad)
    }
  }

  /** 播放器 timeupdate 入口：倒计时展示 / 手动拖入立即跳过 / 离开窗口收起。 */
  onTimeUpdate(): void {
    this.applyDark()
    if (!this.masterEnabled || !this.pageEnabled || !this.player || this.ads.length === 0) return
    const t = this.player.currentTime

    const manual = insideAdAt(this.ads, t)
    if (manual) {
      const key = segmentKey(manual)
      if (!this.optedOut.has(key) && !this.skippedOnce.has(key)) {
        if (shouldSkipManually(manual, t) && !this.skipScheduled.has(key)) {
          // 手动拖入广告段（残段 > 2 秒）：提示条出现并立即跳过。
          this.skipScheduled.add(key)
          this.showManualBanner(manual)
          const scheduled = this.bannerAd
          if (!scheduled) {
            this.skipScheduled.delete(key)
            return
          }
          this.deps.timers.setTimeout(() => {
            if (this.bannerAd === scheduled && this.pageEnabled && this.masterEnabled) {
              void this.performSkip(scheduled)
            } else {
              // 用户已在窗口内取消（点了「这段想看」/关闭开关等）：清理竞态残条目。
              this.skipScheduled.delete(key)
            }
          }, MANUAL_BANNER_MS)
        }
      }
      return
    }

    const upcoming = countdownAdAt(this.ads, t)
    if (upcoming) {
      const key = segmentKey(upcoming)
      const fresh = !this.optedOut.has(key) && !this.skippedOnce.has(key)
      if (fresh && (!this.bannerAd || segmentKey(this.bannerAd) !== key)) {
        this.showBanner(upcoming)
        this.startCountdown(upcoming)
      }
      return
    }

    // 播放位置远离一切窗口：收起遗留提示条。
    if (
      this.bannerAd &&
      (t < this.bannerAd.start - BANNER_LEAD_SECONDS - 0.5 || t >= this.bannerAd.end)
    ) {
      this.hideBanner()
    }
  }

  private async performSkip(ad: AdSegment): Promise<void> {
    const key = segmentKey(ad)
    this.skipScheduled.delete(key)
    const video = this.player
    if (!video || this.skippedOnce.has(key) || !this.masterEnabled || !this.pageEnabled) {
      this.hideBanner()
      return
    }
    const skipFrom = video.currentTime
    try {
      video.currentTime = ad.end
    } catch {
      // seek 失败：提示条收起不阻塞，也不计成就。
      this.hideBanner()
      return
    }
    this.hideBanner()
    this.skippedOnce.add(key)
    await this.sleep(SEEK_VERIFY_DELAY_MS)
    const landed = Math.abs(video.currentTime - ad.end) <= SEEK_VERIFY_TOLERANCE_SECONDS
    if (!landed) {
      // 跳转没生效（播放器拒绝 seek 等）：回滚，下一次拖入仍会给提示条。
      this.skippedOnce.delete(key)
      return
    }
    this.requestRemesh() // 该段标记转「已跳过」态。
    // 按实际节省记账：跳过时 currentTime 到段尾的差值（中部拖入不按整段夸大）。
    const saved = Math.max(0, ad.end - skipFrom)
    const total = await this.deps.recordSkipped(key, saved)
    if (total !== null) {
      // 统计写 storage.local 失败则仅不显示 chip，跳过本身已生效。
      ui.chip.text = savedChipText(total)
      ui.chip.visible = true
      if (this.chipTimer !== null) this.deps.timers.clearTimeout(this.chipTimer)
      this.chipTimer = this.deps.timers.setTimeout(() => {
        ui.chip.visible = false
      }, CHIP_DISPLAY_MS)
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.deps.timers.setTimeout(() => resolve(), ms)
    })
  }

  // ---------- 页内开关 / 导航复位 ----------

  private applyPageVisibility(): void {
    if (!this.pageEnabled || !this.masterEnabled) {
      this.hideBanner()
      ui.marks = []
      ui.ads = []
      ui.chip.visible = false
    } else {
      this.requestRemesh()
    }
  }

  private resetForNavigation(): void {
    this.detachPlayer()
    if (this.chipTimer !== null) {
      this.deps.timers.clearTimeout(this.chipTimer)
      this.chipTimer = null
    }
    this.activeBvid = null
    this.ads = []
    ui.marks = []
    ui.ads = []
    this.hideBanner()
    ui.chip.visible = false
    this.hintShown = false
    ui.vectorHint.visible = false
    this.optedOut.clear()
    this.skippedOnce.clear()
    this.skipScheduled.clear()
    this.pageEnabled = true // 页内开关状态复位：新视频页默认开。
    this.pipelineStarted = false
    this.lastAttemptAt = 0
  }
}