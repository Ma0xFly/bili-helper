import 'uno.css'
import './ui/overlay.css'
import { defineContentScript } from 'wxt/utils/define-content-script'
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root'
import { createApp } from 'vue'
import { browser } from 'wxt/browser'
import App from './ui/App.vue'
import PanelApp from './ui/panel/PanelApp.vue'
import { ui } from '../../modules/content/ui-state'
import { AdSkipController } from '../../modules/content/ad-skip-controller'
import type { TimerApi } from '../../modules/content/ad-skip-controller'
import { readAiSettings } from '../../modules/settings'
import type { AiSettings } from '../../modules/settings'
import { resolveBackend } from '../../modules/ai/backend/resolve'
import {
  collectComments,
  collectDanmaku,
  collectSubtitles,
  collectVideoMeta,
} from '../../modules/video'
import { recordSkipped } from '../../modules/content/stats'
import { panel, panelActions, panelBackoffMs, panelVisibleNow } from '../../modules/content/panel-state'
import {
  MSG_AD_SKIP_PAGE_STATE,
  MSG_AD_SKIP_PAGE_TOGGLE,
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

// 一切注入 UI 寄居 Shadow DOM。cssInjectionMode:"ui" 让引入的 overlay.css/uno.css
// 经 createShadowRootUi 注入 shadow root，与 B 站页面样式完全隔离。
// 本文件只做接线：状态机在 modules/content/ad-skip-controller（可注入依赖、可单测）。
export default defineContentScript({
  matches: ['https://www.bilibili.com/video/*'],
  cssInjectionMode: 'ui',
  async main(ctx) {
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

    // 面板宿主：文档流内联，挂进 B 站右栏（插入点由 ensurePanelPlacement 维护）。
    try {
      panelMount = await createShadowRootUi<HTMLElement>(ctx, {
        name: 'bili-helper-panel-anchor',
        position: 'inline',
        anchor: 'body',
        append: 'last',
        onMount(container, _shadow, shadowHost) {
          // 原版同款宿主形态（.bili-helper-ai-panel-host）：块级、占满右栏宽、下方 12px 间距。
          Object.assign(shadowHost.style, { display: 'block', width: '100%', margin: '0 0 12px' })
          createApp(PanelApp).mount(container)
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
      player: {
        findVideo,
        waitForVideo,
        findPlayerContainer: (video) =>
          (video.closest(PLAYER_SELECTORS.join(',')) as HTMLElement | null) ?? null,
        findProgressElement: (container) =>
          container?.querySelector<HTMLElement>(PROGRESS_SELECTORS.join(',')) ??
          window.document.querySelector<HTMLElement>(PROGRESS_SELECTORS.join(',')) ??
          null,
      },
      pageHref: () => window.location.href,
      isDark: isDarkMode,
      collectVideoMeta,
      collectSubtitles,
      collectDanmaku,
      collectComments,
      readSettings: readAiSettings,
      createBackend: (settings, hooks) => resolveBackend(settings, hooks),
      recordSkipped,
      openOptions: () => {
        void browser.runtime.openOptionsPage().catch(() => {
          // 设置页不可打开时静默（提示条不受影响）。
        })
      },
    })

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
    panelActions.openSettings = () => {
      void browser.runtime.openOptionsPage().catch(() => {
        // 设置页不可打开时静默。
      })
    }
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

    // ---------- 面板停靠（原版同款）：插进 B 站右栏文档流 ----------
    // 宿主挂在右栏容器、up 主信息卡之后（弹幕列表上方），随文档流与列内 sticky 滚动——
    // 永远「固定在右侧上方」，不靠视口坐标模拟（宽屏/剧场模式下列落到底部也自动跟随）。
    // B 站重渲染右栏会把宿主一起冲掉：每次插入后校验位置，失位即重插，1.5s 周期检查兜底。
    const PANEL_RIGHT_CONTAINER_SELECTORS = [
      '.right-container-inner.scroll-sticky',
      '.right-container-inner',
      '.right-container',
    ]
    const PANEL_TOP_REFERENCE_SELECTOR = '.up-panel-container'

    interface PanelAnchor {
      target: HTMLElement
      topReference: HTMLElement | null
    }

    function findPanelAnchor(): PanelAnchor | null {
      const container =
        PANEL_RIGHT_CONTAINER_SELECTORS.map((selector) =>
          window.document.querySelector<HTMLElement>(selector),
        ).find((el) => el !== null) ?? null
      if (!container) return null
      const topReference = container.querySelector<HTMLElement>(PANEL_TOP_REFERENCE_SELECTOR)
      if (topReference) return { target: container, topReference }
      // 无 up 主卡（少见布局）：退而求其次插在评论区前（同为容器直接子节点时语义一致）。
      const commentApp = window.document.querySelector<HTMLElement>('#commentapp')
      if (commentApp && commentApp.parentElement === container) {
        return { target: container, topReference: commentApp }
      }
      return { target: container, topReference: null }
    }

    function panelPlaced(anchor: PanelAnchor, host: HTMLElement): boolean {
      if (host.parentElement !== anchor.target) return false
      if (anchor.topReference) return host.previousElementSibling === anchor.topReference
      return anchor.target.firstElementChild === host
    }

    function ensurePanelPlacement(): void {
      const host = panelMount?.shadowHost
      if (!host) return
      const anchor = findPanelAnchor()
      if (!anchor || panelPlaced(anchor, host)) return
      try {
        if (anchor.topReference) anchor.topReference.after(host)
        else anchor.target.prepend(host)
      } catch {
        // 右栏 DOM 暂不接受插入（页面状态异常）：留在原地，下轮再试。
      }
    }

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
    })

    // ---------- 导航 / 亮暗观测 ----------
    // SPA 换视频（pushState）不整页刷新：周期检查兜底 + 根节点 DOM 变化即时触发。
    const NAV_CHECK_INTERVAL_MS = 1_500
    window.setInterval(() => {
      controller.retryIfNeeded()
      controller.checkNavigation()
      void syncPanelSession()
      ensurePanelPlacement()
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
    }
    window.document.addEventListener('fullscreenchange', onFullscreenChange)

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
    } catch {
      // 读取失败保留默认 true（被动 UI 无惊扰），用户可在设置页切换。
    }
    panel.ready = true
    ensurePanelPlacement()
    void syncPanelSession()

    void controller.start()
  },
})