// AI 去广告内容脚本核心状态机（可注入依赖、可单测）：
// 采集 → detectAds（strategy 固定 smart）→ 播放器监听（倒计时/自动跳过/手动拖入立即跳过）→
// 进度条标记/成就统计；页内开关与总开关 gate 一切跳转逻辑；
// SPA 换视频（bvid 变化）时整体复位重跑，失败的链路允许冷却后重试。
// DOM 定位、计时器、存储读写全部经 deps 注入；本模块除了响应式 ui 状态外不触宿主页面。

import type { AiSettings } from '../settings'
import type { AiCapabilities, AdSegment, DetectAdsInput, DetectAdsResult } from '../ai/port'
import type { Comment, Danmaku, Subtitle, VideoMeta } from '../video/types'
import type { DetectHooks } from '../ai/rag/detect'
import { detectCacheFingerprint, readDetectCache, writeDetectCache } from '../ai/rag/result-cache'
import { recordDetectCost } from '../ai/diagnostics-log'
import { extractBvidFromUrl } from '../video/collectors'
import {
  applyAdFeedback,
  mergeAdIntervals,
  type AdFeedback,
  type AdFeedbackInterval,
} from './ad-feedback'
import type { AdSkipPageState, AdSkipToggleResponse } from './protocol'
import {
  BANNER_LEAD_SECONDS,
  SEEK_VERIFY_TOLERANCE_SECONDS,
  bannerCopy,
  bannerSubCopy,
  countdownAdAt,
  countdownSeconds,
  formatCompactTime,
  formatHms,
  insideAdAt,
  savedChipText,
  segmentKey,
  shouldSkipManually,
  sortedAds,
} from './logic'
import { MarksBoxTracker } from './marks-box'
import type { MarksPlayerAdapter, TimerApi } from './marks-box'
import { ui } from './ui-state'

// 计时器/播放器定位面类型与标记几何跟踪器同源（见 marks-box.ts）；此处 re-export 供既有引用。
// PlayerAdapter 在定位面之上补齐视频查找（控制器管线自己用；标记跟踪器只消费定位面）。
export type { TimerApi }
export interface PlayerAdapter extends MarksPlayerAdapter {
  findVideo(): HTMLVideoElement | null
  waitForVideo(timeoutMs: number): Promise<HTMLVideoElement | null>
}
export {
  MARKS_SYNC_INTERVAL_MS,
  MARKS_HIDE_CONFIRM_TICKS,
} from './marks-box'

export const VIDEO_WAIT_TIMEOUT_MS = 15_000
export const CHIP_DISPLAY_MS = 4_000
export const VECTOR_HINT_DISPLAY_MS = 12_000
export const COUNTDOWN_TICK_MS = 100
export const MANUAL_BANNER_MS = 350
export const SEEK_VERIFY_DELAY_MS = 250
export const MEASURE_INTERVAL_MS = 2_000
/**
 * 自动跳过置信度门槛：只有高置信段（LLM 定界确认）才弹横幅并接管进度条；
 * 极速匹配（纯检索兜底）置信度封顶 0.6——只上进度条标记，不自动跳，
 * 防止端点故障时低质量召回把正片当广告跳掉。
 */
export const AUTO_SKIP_MIN_CONFIDENCE = 0.7
/**
 * 失败链路的重试冷却：周期检查按此节流，避免端点故障时疯狂重打。这也承担观看门槛的
 * 重试节拍——门槛未过时 pipelineStarted 保持 false，靠这里的周期重试在用户继续看时接上。
 */
export const RETRY_COOLDOWN_MS = 10_000
/**
 * token 闸门：真实观看进度达到该秒数才发起检测。秒退/划走的视频零 token；
 * 拖动进度条也会立刻满足（用户明显在看）。典型恰饭段在 1–3 分钟处，重试节拍下不赶不上。
 */
export const WATCH_GATE_SECONDS = 15

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
  /** 误判反馈存储（默认接 modules/content/ad-feedback 的实现；测试注入）。 */
  readFeedback: (bvid: string, cid: number | null) => Promise<AdFeedback | null>
  writeFeedback: (bvid: string, feedback: AdFeedback) => Promise<void>
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
  /** ads 中达到自动跳过门槛的子集：横幅/倒计时/跳过只看这里，标记看全量 ads。 */
  private skipAds: AdSegment[] = []
  private bannerAd: AdSegment | null = null
  private optedOut = new Set<string>()
  private skippedOnce = new Set<string>()
  private skipScheduled = new Set<string>()
  private hintShown = false
  /** 漏报标记两拍流的起点（秒）；null = 未在标记。 */
  private markingStart: number | null = null

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
  /**
   * 标记盒几何跟踪器（isRelevant = 有广告标记）：广告标记为空时整拍跳过，
   * 盒子归属章节标记等其他消费方管理——两类标记共用同一套防闪烁口径。
   */
  private readonly marksBox: MarksBoxTracker

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
    this.marksBox = new MarksBoxTracker({
      timers: deps.timers,
      player: deps.player,
      getVideo: () => this.player,
      isRelevant: () => ui.marks.length > 0,
    })
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
    ui.actions.onMarkNotAd = (key) => {
      const ad =
        this.ads.find((item) => segmentKey(item) === key) ??
        (this.bannerAd !== null && segmentKey(this.bannerAd) === key ? this.bannerAd : null)
      if (ad) void this.markNotAd(ad)
    }
    ui.actions.onStartMarkAd = () => this.startMarking()
    ui.actions.onFinishMarkAd = () => this.finishMarking()
    ui.actions.onCancelMarkAd = () => this.cancelMarking()
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
    ui.marking = { active: false, start: 0, startText: '' }
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

      // token 闸门①（观看门槛）：看不够 15 秒不花检测 token——秒退/划走的视频零成本。
      // pipelineStarted 保持 false，周期重试（10s 冷却）在用户继续看时自动接上。
      const watched = this.deps.player.findVideo()?.currentTime ?? 0
      if (watched < WATCH_GATE_SECONDS) {
        console.info(
          `[bili-helper] 去广告等待观看进度（${Math.floor(watched)}s/${WATCH_GATE_SECONDS}s，看够才花 token）`,
        )
        return
      }

      let settings: AiSettings
      try {
        settings = await this.deps.readSettings()
      } catch {
        return
      }
      this.masterEnabled = settings.adSkipEnabled
      if (!this.masterEnabled || !this.pageEnabled) {
        console.info('[bili-helper] 去广告未启用（总开关或页内开关关闭），跳过检测')
        return
      }

      // token 闸门②（结果缓存）：重复观看/回看直接用上次的结论（含「没广告」的负缓存）。
      // 指纹含算法版本/端点/模型/生效语料，配置一变自动重算。命中时连采集都省掉。
      // cid 取不到（罕见：页面状态没就绪）时跳过缓存——不同分 P 的检测结果不能混。
      const cacheCid = typeof meta.cid === 'number' ? meta.cid : null
      let fingerprint = ''
      try {
        fingerprint = await detectCacheFingerprint(settings)
      } catch {
        fingerprint = '' // 指纹算不出（语料读失败等）：视为不可缓存，照常检测。
      }
      let cached =
        fingerprint === '' || cacheCid === null
          ? null
          : await readDetectCache(meta.bvid, cacheCid, fingerprint)

      const detectStartedAt = Date.now()
      let result: DetectAdsResult
      if (cached) {
        result = {
          ads: cached.ads,
          source: cached.source,
          meta: {
            ...(cached.meta ?? {}),
            path: 'cache',
            llmCalls: 0,
            note: `缓存命中（原路径 ${cached.meta?.path ?? cached.source}，${Math.round((Date.now() - cached.savedAt) / 60000)} 分钟前）`,
          },
        }
        console.info(`[bili-helper] 去广告检测缓存命中 bvid=${meta.bvid} 广告段=${cached.ads.length}（0 token）`)
      } else {
        const [subtitles, danmaku, comments] = await Promise.all([
          this.deps.collectSubtitles(meta),
          this.deps.collectDanmaku(meta),
          this.deps.collectComments(meta),
        ])
        console.info(
          `[bili-helper] 去广告检测开始 bvid=${meta.bvid} 时长=${meta.duration}s 字幕=${subtitles.length}行 弹幕=${danmaku.length}条 评论=${comments.length}条`,
        )
        const backend = this.deps.createBackend(settings, {
          onVectorFallback: () => {
            this.showHint('向量端点（Embedding）的 API 有问题，暂时只用词表匹配')
          },
          onRetrievalOnly: () => {
            this.showHint('对话端点这次没响应，先用极速匹配（仅检索）跳广告')
          },
        })
        try {
          result = await backend.detectAds({
            video: meta,
            subtitles,
            danmaku,
            comments,
            strategy: 'smart',
          })
        } catch (error) {
          // 端点未配置（config）/后端失败：不弹 UI；pipelineStarted 保持 false，冷却后重试。
          // 但必须留下日志——静默失败是排障黑洞（用户只会看到「没有标记」）。
          console.error(
            '[bili-helper] 去广告检测失败（冷却后自动重试）:',
            error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          )
          return
        }
        // 负缓存同样入档：没有广告的结论也是花了 token 得到的。
        if (fingerprint !== '' && cacheCid !== null) {
          void writeDetectCache(meta.bvid, cacheCid, {
            ads: result.ads,
            source: result.source,
            ...(result.meta === undefined ? {} : { meta: result.meta }),
            fingerprint,
          })
        }
      }

      // 门槛统计就地算：此处 this.skipAds 还是上一轮的（赋值在 gate 之后才发生）。
      const skippable = result.ads.filter(
        (ad) => ad.confidence >= AUTO_SKIP_MIN_CONFIDENCE,
      ).length
      const metaInfo = result.meta
      const usage = metaInfo?.usage
      const costText =
        metaInfo === undefined
          ? ''
          : ` 路径=${metaInfo.path} 对话=${metaInfo.llmCalls}次` +
            (usage === undefined ? '' : ` token=入${usage.input}/出${usage.output}`)
      console.info(
        `[bili-helper] 去广告检测完成 source=${result.source} 广告段=${result.ads.length} 可自动跳过=${skippable} 耗时=${cached ? 0 : Math.round((Date.now() - detectStartedAt) / 1000)}s${costText}` +
          (result.ads.length > 0
            ? ' → ' + result.ads.map((ad) => `${Math.round(ad.start)}-${Math.round(ad.end)}s(${ad.product_name || '未命名'},${ad.confidence.toFixed(2)})`).join(' ')
            : ''),
      )
      void recordDetectCost({
        time: Date.now(),
        bvid: meta.bvid,
        path: metaInfo?.path ?? (cached ? 'cache' : 'unknown'),
        llmCalls: metaInfo?.llmCalls ?? 0,
        ...(usage === undefined ? {} : { inputTokens: usage.input, outputTokens: usage.output }),
        elapsedMs: cached ? 0 : Date.now() - detectStartedAt,
        ads: result.ads.length,
        skippable,
      })
      if (!this.pageEnabled || !this.masterEnabled) return
      // 用户纠错叠加（token 闸门外的第零道门——零成本）：检测结果 × 误判反馈。
      // 反馈存独立仓（result-cache 之外），语料/端点变化重检测时依然生效。
      let feedback: AdFeedback | null = null
      try {
        feedback = await this.deps.readFeedback(meta.bvid, cacheCid)
      } catch {
        feedback = null // 反馈读失败不拦检测主链路
      }
      const effectiveAds = applyAdFeedback(result.ads, feedback)
      if (feedback !== null) {
        console.info(
          `[bili-helper] 误判反馈叠加：误报剔除=${feedback.notAds.length}段 漏报补入=${feedback.missedAds.length}段 → 生效广告段=${effectiveAds.length}（检测原始 ${result.ads.length}）`,
        )
      }
      this.applyAds(effectiveAds)
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

  /** 检测结果（含反馈叠加）落进运行态：排序、置信度分流、面板镜像。 */
  private applyAds(ads: AdSegment[]): void {
    this.ads = sortedAds(ads)
    this.skipAds = this.ads.filter((ad) => ad.confidence >= AUTO_SKIP_MIN_CONFIDENCE)
    ui.ads = [...this.ads]
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
    this.marksBox.start()
    this.measureGeometry()
  }

  private detachPlayer(): void {
    this.player?.removeEventListener('timeupdate', this.onTick)
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
    this.marksBox.stop()
    this.stopCountdown()
  }

  /** 换视频/开关切换后要求重做标；fullscreenchange 也经此刷新。 */
  requestRemesh(): void {
    this.lastRectKey = ''
    this.marksBox.requestRemesh()
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
    this.buildMarks(container)
  }

  private buildMarks(container: HTMLElement | null): void {
    if (!this.pageEnabled || !this.masterEnabled || this.ads.length === 0) {
      ui.marks = []
      ui.marksBox.visible = false
      return
    }
    const total = this.videoMeta?.duration || this.player?.duration || 0
    ui.marks = this.ads.map((ad) => {
      const key = segmentKey(ad)
      const leftPct = total > 0 ? (ad.start / total) * 100 : 0
      const widthPct = total > 0 ? Math.max(((ad.end - ad.start) / total) * 100, 0.6) : 0.6
      const clampedLeft = Math.min(leftPct, 99)
      return {
        key,
        leftPct: clampedLeft,
        widthPct: Math.min(widthPct, 100 - clampedLeft),
        productName: ad.product_name,
        range: `${formatHms(ad.start)} – ${formatHms(ad.end)}`,
        done: this.skippedOnce.has(key),
      }
    })
    this.syncMarksBox()
  }

  /**
   * 标记层盒子同步：委托共享的 MarksBoxTracker（广告标记相关性 = ui.marks 非空；
   * 几何取整/两拍隐藏确认/立即恢复的防闪烁口径见 marks-box.ts）。
   * 章节标记是另一条独立跟踪器，互不干扰。
   */
  private syncMarksBox(): void {
    this.marksBox.syncNow()
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
    ui.banner.key = segmentKey(ad)
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
    if (!this.masterEnabled || !this.pageEnabled || !this.player || this.skipAds.length === 0) return
    const t = this.player.currentTime

    const manual = insideAdAt(this.skipAds, t)
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

    const upcoming = countdownAdAt(this.skipAds, t)
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

  // ---------- 误判纠错（用户裁决闭环） ----------

  /**
   * 「这段不是广告」：本页立即剔除该段（标记/横幅/跳过全撤），并持久化到该视频的
   * 误报反馈——下次进入（缓存命中或重新检测）都会被同一份反馈修正。
   */
  private async markNotAd(ad: AdSegment): Promise<void> {
    const key = segmentKey(ad)
    this.optedOut.delete(key)
    this.skippedOnce.delete(key)
    if (this.bannerAd !== null && segmentKey(this.bannerAd) === key) this.hideBanner()
    this.applyAds(applyAdFeedback(this.ads, { notAds: [{ start: ad.start, end: ad.end }], missedAds: [] }))
    this.requestRemesh()
    const bvid = this.activeBvid
    const cid = this.videoMeta?.cid ?? null
    console.info(
      `[bili-helper] 误判反馈：${bvid ?? '未知视频'} ${Math.round(ad.start)}–${Math.round(ad.end)}s 不是广告（已记住，此视频不再跳）`,
    )
    if (bvid === null || cid === null) return
    try {
      const current = await this.deps.readFeedback(bvid, cid)
      const notAds = mergeAdIntervals([...(current?.notAds ?? []), { start: ad.start, end: ad.end }])
      await this.deps.writeFeedback(bvid, {
        cid,
        notAds,
        missedAds: current?.missedAds ?? [],
        updatedAt: Date.now(),
      })
    } catch (error) {
      // 持久化失败：本页已生效，只是下次进来会再犯——留日志可排障。
      console.error('[bili-helper] 误判反馈持久化失败:', String(error))
    }
  }

  /** 「标记漏掉的广告段」：并入生效列表（置信度 1 直接可跳）并持久化。 */
  markMissedAd(start: number, end: number): void {
    if (!(end > start + 0.5)) return
    const interval: AdFeedbackInterval = { start, end }
    this.applyAds(applyAdFeedback(this.ads, { notAds: [], missedAds: [interval] }))
    this.requestRemesh()
    const bvid = this.activeBvid
    const cid = this.videoMeta?.cid ?? null
    console.info(
      `[bili-helper] 漏报标记：${bvid ?? '未知视频'} ${Math.round(start)}–${Math.round(end)}s 并入广告段（置信度 1）`,
    )
    if (bvid === null || cid === null) return
    void (async () => {
      try {
        const current = await this.deps.readFeedback(bvid, cid)
        const missedAds = mergeAdIntervals([...(current?.missedAds ?? []), interval])
        await this.deps.writeFeedback(bvid, {
          cid,
          notAds: current?.notAds ?? [],
          missedAds,
          updatedAt: Date.now(),
        })
      } catch (error) {
        console.error('[bili-helper] 漏报标记持久化失败:', String(error))
      }
    })()
  }

  /** 漏报标记两拍流：第一拍记起点（浮出 MarkingChip），第二拍收终点并入。 */
  startMarking(): void {
    const video = this.player ?? this.deps.player.findVideo()
    const at = video?.currentTime
    if (typeof at !== 'number' || !Number.isFinite(at)) return
    this.markingStart = at
    ui.marking = { active: true, start: at, startText: formatCompactTime(at) }
  }

  finishMarking(): void {
    const start = this.markingStart
    this.cancelMarking()
    if (start === null) return
    const video = this.player ?? this.deps.player.findVideo()
    const end = video?.currentTime
    if (typeof end !== 'number' || !Number.isFinite(end)) return
    this.markMissedAd(start, Math.max(end, start + 1))
  }

  cancelMarking(): void {
    this.markingStart = null
    if (ui.marking.active) ui.marking = { active: false, start: 0, startText: '' }
  }

  // ---------- 页内开关 / 导航复位 ----------

  private applyPageVisibility(): void {
    if (!this.pageEnabled || !this.masterEnabled) {
      this.hideBanner()
      this.cancelMarking()
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
    this.skipAds = []
    ui.marks = []
    ui.ads = []
    this.hideBanner()
    ui.chip.visible = false
    this.hintShown = false
    ui.vectorHint.visible = false
    this.optedOut.clear()
    this.skippedOnce.clear()
    this.skipScheduled.clear()
    this.cancelMarking()
    this.pageEnabled = true // 页内开关状态复位：新视频页默认开。
    this.pipelineStarted = false
    this.lastAttemptAt = 0
  }
}