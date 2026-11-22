import 'uno.css'
import './ui/overlay.css'
import { defineContentScript } from 'wxt/utils/define-content-script'
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root'
import { createApp, watch } from 'vue'
import { browser } from 'wxt/browser'
import App from './ui/App.vue'
import PanelApp from './ui/panel/PanelApp.vue'
import { ui } from '../../modules/content/ui-state'
import { AdSkipController } from '../../modules/content/ad-skip-controller'
import type { PlayerAdapter, TimerApi } from '../../modules/content/ad-skip-controller'
import { MarksBoxTracker } from '../../modules/content/marks-box'
import { NativeMarksInjector } from '../../modules/content/native-marks'
import { formatCompactTime } from '../../modules/content/logic'
import { readAdFeedback, writeAdFeedback } from '../../modules/content/ad-feedback'
import {
  mergeChapterSources,
  parseViewPoints,
  readChapterCache,
  writeChapterCache,
  type ChapterMark,
} from '../../modules/content/chapters'
import type { SummarySegment } from '../../modules/ai/port'
import { readAiSettings } from '../../modules/settings'
import type { AiSettings } from '../../modules/settings'
import { resolveBackend } from '../../modules/ai/backend/resolve'
import {
  collectComments,
  collectDanmaku,
  collectSubtitles,
  collectVideoMeta,
  collectViewPoints,
} from '../../modules/video'
import { recordSkipped } from '../../modules/content/stats'
import {
  createDefaultPanelPlacementDom,
  isWatchlaterSurfaceHref,
  PanelPlacementController,
} from '../../modules/content/panel-placement'
import { panel, panelActions, panelBackoffMs, panelVisibleNow } from '../../modules/content/panel-state'
import {
  MSG_AD_SKIP_PAGE_STATE,
  MSG_AD_SKIP_PAGE_TOGGLE,
  MSG_OPEN_OPTIONS,
  MSG_PANEL_PAGE_STATE,
  MSG_PANEL_PAGE_TOGGLE,
  isKnownMessage,
  isPanelMessage,
} from '../../modules/content/protocol'
import type {
  AdSkipToggleRequest,
  PanelPageState,
  PanelToggleRequest,
  PanelToggleResponse,
} from '../../modules/content/protocol'
import { extractBvidFromUrl } from '../../modules/video/collectors'
import { NET_RELAY_PORT_NAME, setNetRelayConnect } from '../../modules/ai/llm/net-relay'

/**
 * 打开扩展设置页：内容脚本上下文没有 runtime.openOptionsPage（仅扩展页/后台可用），
 * 经后台代开；后台不可达或代开失败（极少见）时回退直接开设置页 URL。
 * runtime.getURL 运行时在内容脚本可用，只是 wxt 的类型把它从该上下文抠掉了，断言补回。
 */
function openOptionsViaBackground(): void {
  const optionsUrl = (browser.runtime as unknown as { getURL: (path: string) => string }).getURL(
    '/options.html',
  )
  void browser.runtime
    .sendMessage({ type: MSG_OPEN_OPTIONS })
    .then((response: unknown) => {
      if ((response as { ok?: unknown } | undefined)?.ok === true) return
      window.open(optionsUrl, '_blank')
    })
    .catch(() => {
      window.open(optionsUrl, '_blank')
    })
}

// 一切注入 UI 寄居 Shadow DOM。cssInjectionMode:"ui" 让引入的 overlay.css/uno.css
// 经 createShadowRootUi 注入 shadow root，与 B 站页面样式完全隔离。
// 本文件只做接线：状态机在 modules/content/ad-skip-controller 与 modules/content/panel-placement
// （可注入依赖、可单测）。
export default defineContentScript({
  // 稍后再看两入口与视频页同栈：列表播放页 /list/*、首页 WatchLater tab 深链与 SPA 入口。
  // Chrome match pattern 用 path+query 参与匹配（fragment 忽略）：裸 / 只匹配无 query 的
  // 首页（SPA pushState 入口——脚本必须先在页面里，稍后再看 tab 是首页上的站内切换），
  // 带 query 的深链必须显式列出；page 参数未必紧跟 ?（/?spm_id_from=x&page=WatchLater、
  // /index.html?page=WatchLater）——用 ?*page=WatchLater* 通配兜住任意参数序。
  // 注意通配按子串匹配，非参数精确命中；非稍后看面由运行时休眠门兜住。
  matches: [
    'https://www.bilibili.com/video/*',
    'https://www.bilibili.com/list/*',
    'https://www.bilibili.com/',
    'https://www.bilibili.com/index.html',
    'https://www.bilibili.com/?*page=WatchLater*',
    'https://www.bilibili.com/index.html?*page=WatchLater*',
  ],
  cssInjectionMode: 'ui',
  async main(ctx) {
    // AI 直连流量改走后台代取：内容脚本运行在页面源上，跨域 fetch 受页面 CORS 约束
    // （端点不放行 B 站源就永远连不上）；后台 SW 带 host_permissions 豁免 CORS。
    // 必须在任何 AI 调用发生前装配（import 期即可，main 开头做同样保险）。
    setNetRelayConnect(() => browser.runtime.connect({ name: NET_RELAY_PORT_NAME }))
    let uiMount: Awaited<ReturnType<typeof createShadowRootUi<HTMLElement>>> | null = null
    // 面板独立宿主：文档流内联（插进 B 站右栏），与覆盖层 host（fixed 铺满视口）分开。
    let panelMount: Awaited<ReturnType<typeof createShadowRootUi<HTMLElement>>> | null = null
    try {
      uiMount = await createShadowRootUi<HTMLElement>(ctx, {
        name: 'bili-helper-anchor',
        position: 'inline',
        anchor: 'body',
        append: 'last',
        onMount(container, _shadow, shadowHost) {
          // 宿主铺满视口但指针事件穿透；浮层内容（提示条/标记/chip）各自开启事件。
          Object.assign(shadowHost.style, {
            position: 'fixed',
            inset: '0',
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            zIndex: '2147483000',
          })
          Object.assign(container.style, { width: '100%', height: '100%' })
          createApp(App).mount(container)
          return shadowHost
        },
      })
      uiMount.mount()
    } catch {
      // 页面早导航等场景下宿主已不可用：静默放弃，不影响宿主页。
      return
    }

    // 面板宿主：WXT mount 只占位（body 末尾、隐藏），落位成功才挂载面板应用——
    // 原版同款生命周期：先落位、后挂应用；落位插入的是原版同款普通 div 宿主
    // （.bili-helper-ai-panel-host），WXT 的 shadow 宿主作为其子节点。
    // 「先落位后挂应用」的一次性挂载守卫在 panel-placement 状态机里（首次落位成功才调 mountPanelApp）。
    let panelContainer: HTMLElement | null = null
    try {
      panelMount = await createShadowRootUi<HTMLElement>(ctx, {
        name: 'bili-helper-panel-anchor',
        position: 'inline',
        anchor: 'body',
        append: 'last',
        onMount(container, _shadow, shadowHost) {
          // 落位前隐藏（WXT 把宿主暂挂在 body 末尾）；移进右栏 wrapper 时恢复。
          panelContainer = container
          Object.assign(shadowHost.style, { display: 'none' })
          return shadowHost
        },
      })
      panelMount.mount()
    } catch {
      // 面板挂不上不影响广告浮层族（提示条/标记/chip 照常工作）。
    }

    // ---------- 播放器定位器（真实 DOM） ----------
    const PLAYER_SELECTORS = ['.bpx-player-container', '#bilibili-player', '.bilibili-player']
    const VIDEO_SELECTORS = [
      '.bpx-player-container video',
      '#bilibili-player video',
      '.bilibili-player video',
    ]
    const PROGRESS_SELECTORS = [
      '.bpx-player-progress-schedule-inner',
      '.bpx-player-progress-schedule',
      '.bpx-player-progress',
    ]

    function findVideo(): HTMLVideoElement | null {
      for (const selector of VIDEO_SELECTORS) {
        const el = window.document.querySelector<HTMLVideoElement>(selector)
        if (el) return el
      }
      return null
    }

    async function waitForVideo(timeoutMs: number): Promise<HTMLVideoElement | null> {
      const found = findVideo()
      if (found) return found
      const started = Date.now()
      return new Promise((resolve) => {
        const timer = window.setInterval(() => {
          const current = findVideo()
          if (current) {
            window.clearInterval(timer)
            resolve(current)
          } else if (Date.now() - started > timeoutMs) {
            window.clearInterval(timer)
            resolve(null)
          }
        }, 300)
      })
    }

    function findPlayerContainer(video: HTMLVideoElement): HTMLElement | null {
      return (video.closest(PLAYER_SELECTORS.join(',')) as HTMLElement | null) ?? null
    }

    function findProgressElement(container: HTMLElement | null): HTMLElement | null {
      return (
        container?.querySelector<HTMLElement>(PROGRESS_SELECTORS.join(',')) ??
        window.document.querySelector<HTMLElement>(PROGRESS_SELECTORS.join(',')) ??
        null
      )
    }

    /** 去广告控制器与章节标记共用的定位面。 */
    const playerAdapter: PlayerAdapter = {
      findVideo,
      waitForVideo,
      findPlayerContainer,
      findProgressElement,
    }

    const timers: TimerApi = {
      setTimeout: (handler, ms) => window.setTimeout(handler, ms),
      clearTimeout: (id) => window.clearTimeout(id),
      setInterval: (handler, ms) => window.setInterval(handler, ms),
      clearInterval: (id) => window.clearInterval(id),
    }

    // B 站夜间模式：class 标记优先，无标记时以 body 背景亮度判定；
    // 透明（alpha=0）背景视为不可判定，沿用当前状态，不做暗色误判。
    function isDarkMode(): boolean {
      const root = window.document.documentElement
      const className = typeof root?.className === 'string' ? root.className : ''
      if (/(dark|night|__night|theme-dark)/i.test(className)) return true
      try {
        const background = window.getComputedStyle(window.document.body).backgroundColor
        const match = background.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/)
        if (match) {
          if (match[4] !== undefined && Number(match[4]) === 0) return ui.dark
          const luminance =
            0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3])
          return luminance < 90
        }
      } catch {
        // 样式读取失败：沿用当前状态。
      }
      return ui.dark
    }

    // ---------- 控制器 ----------
    const controller = new AdSkipController({
      timers,
      now: () => Date.now(),
      player: playerAdapter,
      pageHref: () => window.location.href,
      isDark: isDarkMode,
      collectVideoMeta,
      collectSubtitles,
      collectDanmaku,
      readSettings: readAiSettings,
      createBackend: (settings, hooks) => resolveBackend(settings, hooks),
      recordSkipped,
      openOptions: openOptionsViaBackground,
      readFeedback: (bvid, cid) => readAdFeedback(bvid, cid),
      writeFeedback: (bvid, feedback) => writeAdFeedback(bvid, feedback),
    })

    // ---------- 章节标记（官方看点 + AI 总结时间线 → 进度条刻度，点击跳转） ----------
    // 官方看点零 token（player 接口）；AI 时间线只在用户手动点总结后出现，并按 bvid:cid
    // 缓存——总结花过 token，时间线不能随刷新蒸发。几何与广告标记共用 MarksBoxTracker 口径。
    const chapterMarksBox = new MarksBoxTracker({
      timers,
      player: playerAdapter,
      getVideo: findVideo,
      isRelevant: () => ui.chapterMarks.length > 0,
    })

    // ---------- 标记原生一体化：注入 B 站进度条本体 ----------
    // 广告底段与章节刻度长在原生条里（pointer-events:none，点击/拖拽/悬停预览全归原生），
    // 悬停提示仍由 Shadow 浮层渲染、注入层驱动。注入失败（B 站改版）自动回退旧几何镜像形态。
    const nativeMarks = new NativeMarksInjector({
      timers,
      player: playerAdapter,
      getVideo: findVideo,
      getMarks: () => ui.marks,
      getChapters: () => ui.chapterMarks,
      getDark: () => ui.dark,
    })
    // 数据/亮暗变化即时重渲染（deep：mark.done 原位翻转也要跟上）；心跳兜底重注入。
    watch(
      () => [ui.marks, ui.chapterMarks, ui.dark],
      () => nativeMarks.sync(),
      { deep: true },
    )
    // 提示卡跨过原生预览区时的保活（指针离开进度条、进入提示卡的间隙防闪没）。
    ui.actions.keepBarHover = () => nativeMarks.keepHover()
    ui.actions.endBarHover = () => nativeMarks.endHover()
    let chaptersEnabled = true
    let chapterBvid: string | null = null
    let chapterCid: number | undefined
    let chapterDone = false
    let chapterAttempts = 0
    let chapterOfficial: ChapterMark[] = []
    let chapterAi: SummarySegment[] = []

    function chapterTotalSeconds(): number {
      const video = findVideo()
      const duration = video?.duration
      return typeof duration === 'number' && Number.isFinite(duration) && duration > 0
        ? duration
        : 0
    }

    function applyChapterMarks(): void {
      const merged = mergeChapterSources(chapterOfficial, chapterAi)
      const total = chapterTotalSeconds()
      ui.chapterMarks = merged.map((chapter) => ({
        key: `${chapter.source}:${Math.round(chapter.start * 10) / 10}`,
        leftPct: total > 0 ? Math.min((chapter.start / total) * 100, 100) : 0,
        start: chapter.start,
        label: chapter.label,
        timeText: formatCompactTime(chapter.start),
        source: chapter.source,
      }))
      if (ui.chapterMarks.length > 0) chapterMarksBox.start()
      console.info(
        `[bili-helper] 章节标记：官方=${chapterOfficial.length} AI=${chapterAi.length} 上条=${ui.chapterMarks.length}`,
      )
    }

    async function syncChapters(): Promise<void> {
      const bvid = extractBvidFromUrl(window.location.href)
      if (!chaptersEnabled || !bvid) {
        chapterBvid = null
        chapterDone = false
        chapterAttempts = 0
        chapterOfficial = []
        chapterAi = []
        ui.chapterMarks = []
        chapterMarksBox.stop()
        return
      }
      if (bvid !== chapterBvid) {
        chapterBvid = bvid
        chapterDone = false
        chapterAttempts = 0
        chapterOfficial = []
        chapterAi = []
        ui.chapterMarks = []
        ui.summarySegments = []
      }
      if (chapterDone) return
      chapterAttempts += 1
      const meta = await collectVideoMeta()
      if (!meta || meta.bvid !== bvid || meta.cid === undefined) {
        // 页面状态未就绪（罕见）：留待下一拍，超过十拍放弃（本视频无章节标记）。
        if (chapterAttempts < 10) return
        chapterDone = true
        return
      }
      const [rawPoints, cached] = await Promise.all([
        collectViewPoints(meta),
        readChapterCache(meta.bvid, meta.cid),
      ])
      if (rawPoints === null && chapterAttempts < 5) return // 网络瞬时失败：稍后重试
      chapterCid = meta.cid
      chapterOfficial = parseViewPoints(rawPoints ?? [])
      chapterAi = cached?.segments ?? []
      chapterDone = true
      applyChapterMarks()
    }

    // 总结生成成功（SummaryTab 镜像 ui.summarySegments）→ 缓存时间线 + 重上章节条。
    watch(
      () => ui.summarySegments,
      (segments) => {
        const bvid = chapterBvid ?? extractBvidFromUrl(window.location.href)
        if (bvid === null || segments.length === 0 || chapterCid === undefined) return
        if (extractBvidFromUrl(window.location.href) !== bvid) return
        chapterAi = segments
        void writeChapterCache(bvid, chapterCid, segments)
        applyChapterMarks()
      },
    )

    // ---------- 消息接线 ----------
    // 面板动作注入：跳播/打开设置/端口调用（always 经 resolveBackend 唯一分派）。
    panelActions.seek = (seconds) => {
      const video = findVideo()
      if (!video) return // 无播放器 → 忽略
      try {
        video.currentTime = seconds
      } catch {
        // 播放器拒绝 seek：静默忽略。
      }
    }
    // 章节标记点击跳转复用面板跳播（同一个 video 元素、同一套失败静默）。
    ui.actions.onSeek = (seconds) => panelActions.seek(seconds)
    panelActions.openSettings = openOptionsViaBackground
    panelActions.summarize = async (input) => {
      const settings = await readAiSettings()
      return resolveBackend(settings).summarize(input)
    }
    panelActions.chat = async (input, handlers) => {
      const settings = await readAiSettings()
      return resolveBackend(settings).chat(input, handlers)
    }

    // ---------- 面板会话：懒采集上下文（视频/字幕/弹幕/评论）供总结/提问使用 ----------
    // 只在面板实际可见（设置读回 + 总开关/页内开关 + 非全屏）且页面可见（非后台标签）时采集；
    // 退避按 bvid 记忆（导航即重置，SPA 快切不困在旧冷却里），失败指数退避带封顶。
    const PANEL_TIME_POLL_MS = 500
    let panelCollectFailures = 0
    let panelNextCollectAt = 0
    let panelCollectBvid: string | null = null
    let panelCollecting = false

    function panelShownNow(): boolean {
      return panelVisibleNow(panel, window.document.visibilityState === 'visible')
    }

    /** 换视频/离开视频页：复位会话与 ui 镜像（旧视频广告不得并入新视频时间线）。 */
    function resetPanelSession(): void {
      panel.session = null
      panel.collectError = false
      ui.currentTime = 0
      ui.ads = []
    }

    async function syncPanelSession(): Promise<void> {
      if (!panelShownNow()) return
      const bvid = extractBvidFromUrl(window.location.href)
      if (!bvid) {
        if (panel.session !== null) resetPanelSession()
        return
      }
      const sessionBvid = panel.session?.bvid
      if (sessionBvid === bvid) return
      // SPA 换视频：旧会话立即失效（tab 按 bvid 键控重建）；退避换 bvid 立即重置。
      if (sessionBvid !== undefined && sessionBvid !== null) resetPanelSession()
      if (panelCollectBvid !== bvid) {
        panelCollectBvid = bvid
        panelCollectFailures = 0
        panelNextCollectAt = 0
        panel.collectError = false
      }
      if (panelCollecting) return
      const nowMs = Date.now()
      if (nowMs < panelNextCollectAt) return
      panelNextCollectAt = nowMs + panelBackoffMs(panelCollectFailures)
      panelCollecting = true
      try {
        const meta = await collectVideoMeta()
        const currentBvid = extractBvidFromUrl(window.location.href)
        if (currentBvid !== bvid) return // 过时回调：导航已变，丢弃（新导航会重新采集）。
        if (!meta || meta.bvid !== bvid) {
          // 视频元数据失败 = 硬失败：面板错误态 + 重试按钮，退避后自动重试。
          panelCollectFailures += 1
          panel.collectError = true
          return
        }
        // 单源失败不硬失败：allSettled 拼部分上下文（字幕/弹幕/评论各自独立降级为空）。
        const [subtitles, danmaku, comments] = await Promise.allSettled([
          collectSubtitles(meta),
          collectDanmaku(meta),
          collectComments(meta),
        ])
        const finalBvid = extractBvidFromUrl(window.location.href)
        if (finalBvid !== bvid) return // 过时采集回调：不覆盖新会话。
        panel.collectError = false
        panelCollectFailures = 0
        panel.session = {
          bvid: meta.bvid,
          title: meta.title,
          context: {
            video: meta,
            subtitles: subtitles.status === 'fulfilled' ? subtitles.value : [],
            danmaku: danmaku.status === 'fulfilled' ? danmaku.value : [],
            comments: comments.status === 'fulfilled' ? comments.value : [],
          },
        }
      } catch {
        // 元数据读取抛错等意外：按硬失败对待（退避重试）。
        panelCollectFailures += 1
        panel.collectError = true
      } finally {
        panelCollecting = false
      }
    }

    // 重试按钮：清退避后立即再采（per-bvid 冷却一并清零）。
    panelActions.retryCollection = () => {
      panel.collectError = false
      panelCollectFailures = 0
      panelNextCollectAt = 0
      void syncPanelSession()
    }

    // ---------- 面板落位/浮动 dock（状态机在 modules/content/panel-placement，可注入依赖、可单测） ----------
    // 原版（bili-helper 旧产物）同款方法：就绪三重门（整页 load→评论探针→右栏静止）+
    // up 卡/弹幕框锚点 + 800ms 淡入；稍后再看扩展：/list/* 走列表模式（锚
    // .playlist-container--right 内部最前即播放列表上方，跳评论探针门），首页 WatchLater tab
    // 等未知布局由浮动 dock 兜底（已知稍后看面且内联容器持续缺失 12s；视频页永不触发）。

    const placement = new PanelPlacementController({
      timers,
      now: () => Date.now(),
      doc: () => window.document,
      pageHref: () => window.location.href,
      dom: createDefaultPanelPlacementDom(() => window.document),
      findVideo,
      panelShown: panelShownNow,
      // 已知稍后看面判定（dock 触发面）：panel-placement 导出的纯函数（可单测）。
      isWatchlaterSurface: () => isWatchlaterSurfaceHref(window.location.href),
      getHost: () => (panelMount && panelContainer ? panelMount.shadowHost : null),
      mountPanelApp: () => {
        if (panelContainer) createApp(PanelApp).mount(panelContainer)
      },
    })

    // 周期检查驱动就绪三重门与失位重插（原版为 500ms 重试链 + 观察器，这里以 1.5s 周期承担）。
    placement.tick()

    // 标签页从后台回到前台：立即补采（后台期间被 document.hidden 门拦住）。
    window.document.addEventListener('visibilitychange', () => {
      if (window.document.visibilityState === 'visible') void syncPanelSession()
    })

    function getPanelPageState(): PanelPageState {
      return { available: true, pageEnabled: panel.pageEnabled, masterEnabled: panel.masterEnabled }
    }

    function handlePanelToggleMessage(enabled: unknown): PanelToggleResponse {
      if (typeof enabled === 'boolean') {
        panel.pageEnabled = enabled
        if (panel.pageEnabled) void syncPanelSession()
      }
      return { ok: typeof enabled === 'boolean', state: getPanelPageState() }
    }

    browser.runtime.onMessage.addListener((message: unknown) => {
      if (isPanelMessage(message)) {
        if (message.type === MSG_PANEL_PAGE_STATE) return Promise.resolve(getPanelPageState())
        return Promise.resolve(handlePanelToggleMessage((message as PanelToggleRequest).enabled))
      }
      if (!isKnownMessage(message)) return undefined
      if (message.type === MSG_AD_SKIP_PAGE_STATE) {
        return Promise.resolve(controller.getState())
      }
      return Promise.resolve(
        controller.handleToggleMessage((message as AdSkipToggleRequest).enabled),
      )
    })

    // ---------- 设置同步 ----------
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return
      const next = changes.aiAssistantSettings?.newValue as Partial<AiSettings> | undefined
      if (next && typeof next.adSkipEnabled === 'boolean') {
        controller.syncMasterEnabled(next.adSkipEnabled)
      }
      if (next && typeof next.panelEnabled === 'boolean') {
        panel.masterEnabled = next.panelEnabled
        if (panel.masterEnabled) void syncPanelSession()
      }
      if (next && typeof next.chapterMarksEnabled === 'boolean') {
        chaptersEnabled = next.chapterMarksEnabled
        if (!chaptersEnabled) {
          ui.chapterMarks = []
          ui.summarySegments = []
          chapterMarksBox.stop()
        } else {
          chapterDone = false // 重新开启：下一拍重跑采集（缓存请求免网络重复）。
          void syncChapters()
        }
      }
    })

    // ---------- 导航 / 亮暗观测 ----------
    // SPA 换视频（pushState）不整页刷新：周期检查兜底 + 根节点 DOM 变化即时触发。
    const NAV_CHECK_INTERVAL_MS = 1_500
    window.setInterval(() => {
      controller.retryIfNeeded()
      controller.checkNavigation()
      void syncPanelSession()
      void syncChapters()
      placement.tick()
    }, NAV_CHECK_INTERVAL_MS)
    try {
      new MutationObserver(() => {
        controller.applyDark()
        controller.checkNavigation()
      }).observe(window.document.documentElement, {
        attributes: true,
        attributeFilter: ['class'],
        childList: true,
      })
    } catch {
      // MutationObserver 错过时由周期检查兜底。
    }

    // 全屏：把 shadow host 移进全屏元素（保证浮层在顶层），并重做标；
    // 面板随全屏隐藏（提示条/标记不受影响）。
    const onFullscreenChange = (): void => {
      panel.fullscreen = window.document.fullscreenElement !== null
      const host = uiMount?.shadowHost
      if (host) {
        const fullscreen = window.document.fullscreenElement
        try {
          if (fullscreen && host.parentElement !== fullscreen) {
            fullscreen.appendChild(host)
          } else if (!fullscreen && host.parentElement !== window.document.body) {
            window.document.body.appendChild(host)
          }
        } catch {
          // 全屏元素不可用/已被移除：留在原宿主，不做任何 UI 打扰。
        }
      }
      controller.requestRemesh()
      chapterMarksBox.requestRemesh()
      nativeMarks.recheck()
    }
    window.document.addEventListener('fullscreenchange', onFullscreenChange)

    // 扩展重载/失效：摘掉注入进原生条的节点与样式，内联面板 wrapper 与浮动 dock wrapper
    // 一并从宿主 DOM 移除（不留空壳；Shadow 浮层随宿主自生自灭）。
    ctx.onInvalidated(() => {
      nativeMarks.dispose()
      placement.dispose()
    })

    // 播放进度轮询：AI 面板「当前播放段高亮」数据源（面板隐藏时停表省电）。
    window.setInterval(() => {
      if (!panel.masterEnabled || !panel.pageEnabled) return
      const video = findVideo()
      if (video) ui.currentTime = video.currentTime
    }, PANEL_TIME_POLL_MS)

    // ---------- 面板启动：设置读回前保持隐藏（panelEnabled=false 不闪现），再读开关并首采 ----------
    try {
      const initialSettings = await readAiSettings()
      panel.masterEnabled = initialSettings.panelEnabled
      chaptersEnabled = initialSettings.chapterMarksEnabled
    } catch {
      // 读取失败保留默认 true（被动 UI 无惊扰），用户可在设置页切换。
    }
    panel.ready = true
    void syncPanelSession()
    void syncChapters()

    void controller.start()
    nativeMarks.start()
  },
})