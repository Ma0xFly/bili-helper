// AI 面板落位/浮动 dock 状态机（可注入依赖、可单测，仿 ad-skip-controller）：
// 三模式——video（/video/* 右栏 up 卡锚点，就绪三重门：整页 load → 评论探针 → 右栏静止，
// 行为逐字迁移自接线层原版实现）、list（/list/* 或存在左栏列表容器：锚 .playlist-container--right
// 内部最前即播放列表上方，跳过评论探针门、静止门保留）、dock（已知稍后看面且内联容器
// 持续缺失 12s 的 fixed 右上兜底，覆盖首页 WatchLater tab 等未知布局）。
// 非视频/列表页（普通首页、搜索、空间等）整体休眠：无落位、无 dock、无 UI 现身。
// DOM 查询/计时器/时钟/播放器命中/面板显隐/表面判定全部经 deps 注入；本模块不触 WXT/Vue，
// 宿主接线（WXT shadow host、面板应用挂载）见 entrypoints/content/index.ts。

import type { TimerApi } from './marks-box'

export const PANEL_COMMENTS_TIMEOUT_MS = 8_000
export const PANEL_QUIET_TIMEOUT_MS = 12_000
export const PANEL_QUIET_WINDOW_MS = 600
export const PANEL_FADE_IN_MS = 800
/** dock 兜底门槛：已知稍后看面上内联容器持续缺失该时长才浮出（与右栏静止超时同口径）。 */
export const PANEL_DOCK_FALLBACK_MS = 12_000
/** dock 固定几何：右上区域 360px（已批设计；遮挡时用 popup 页内开关隐藏，无折叠按钮）。 */
export const PANEL_DOCK_WIDTH_PX = 360

/** 内联落位宿主 wrapper：原版同款普通 div，WXT shadow 宿主作为其子节点。 */
export const PANEL_HOST_ID = 'bili-helper-ai-panel-host'
export const PANEL_HOST_CLASS = 'bili-helper-ai-panel-host'
/** 浮动 dock wrapper：fixed 挂 body 承载 WXT shadow 宿主。 */
export const PANEL_DOCK_ID = 'bili-helper-ai-panel-dock'

const PANEL_COLUMN_SELECTORS = [
  '.right-container-inner.scroll-sticky',
  '.right-container-inner',
  '.right-container',
  '.playlist-container--right',
]
const PANEL_UP_SELECTOR = '.up-panel-container'
const PANEL_COMMENTS_PROBE = '#commentapp bili-comments'
const PANEL_WIDE_SELECTOR = '.bpx-player-ctrl-wide.bpx-state-entered'
const PANEL_DANMAKU_SELECTOR = '#danmukuBox'
const PANEL_LIST_LEFT_SELECTOR = '.playlist-container--left'
const PANEL_LIST_ANCHOR_SELECTOR = '.playlist-container--right'

export type PanelPlacementMode = 'video' | 'list' | 'none'

/**
 * 已知稍后看面判定（纯函数，接线层与 dock 触发面共用）：列表播放页 /list/* 或
 * 首页 WatchLater tab——query page 值前缀容错（startsWith），与 matches 的
 * ?*page=WatchLater* 通配同等宽松（通配按子串命中，这里对 page 值做真正的前缀判定）。
 */
export function isWatchlaterSurfaceHref(href: string): boolean {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return false
  }
  if (url.pathname.startsWith('/list/')) return true
  const page = url.searchParams.get('page')
  return page !== null && page.startsWith('WatchLater')
}

/** 落位所需的 DOM 查询面（接线层用 createDefaultPanelPlacementDom；测试可整体替换）。 */
export interface PanelPlacementDom {
  /** 右栏容器（视频页四级回退，末级 .playlist-container--right）。 */
  findPanelColumn(): HTMLElement | null
  /** 视频页锚点：右栏 up 卡容器。 */
  findUpPanel(column: Element): HTMLElement | null
  /** 评论区挂载探针（视频页就绪门 2；列表页无此元素）。 */
  findCommentsProbe(): Element | null
  /** 宽屏播放模式判定（宽屏时插到弹幕框之后）。 */
  isWide(): boolean
  findDanmakuBox(): HTMLElement | null
  /** 列表页锚点：播放列表右栏。 */
  findListAnchor(): HTMLElement | null
  /** 列表页形态辅助判定（.playlist-container--left 存在性）。 */
  hasListLeft(): boolean
}

/** 默认 DOM 查询实现：真实选择器直查注入的文档（测试用 happy-dom 同样命中）。 */
export function createDefaultPanelPlacementDom(doc: () => Document): PanelPlacementDom {
  return {
    findPanelColumn: () => {
      for (const selector of PANEL_COLUMN_SELECTORS) {
        const el = doc().querySelector<HTMLElement>(selector)
        if (el) return el
      }
      return null
    },
    findUpPanel: (column) => column.querySelector<HTMLElement>(PANEL_UP_SELECTOR),
    findCommentsProbe: () => doc().querySelector(PANEL_COMMENTS_PROBE),
    isWide: () => doc().querySelector(PANEL_WIDE_SELECTOR) !== null,
    findDanmakuBox: () => doc().querySelector<HTMLElement>(PANEL_DANMAKU_SELECTOR),
    findListAnchor: () => doc().querySelector<HTMLElement>(PANEL_LIST_ANCHOR_SELECTOR),
    hasListLeft: () => doc().querySelector(PANEL_LIST_LEFT_SELECTOR) !== null,
  }
}

export interface PanelPlacementDeps {
  timers: TimerApi
  now: () => number
  /** 宿主文档（接线层 window.document；测试注入 happy-dom）。 */
  doc: () => Document
  pageHref: () => string
  dom: PanelPlacementDom
  /** 播放器命中判定（dock 触发条件之一）。 */
  findVideo: () => HTMLVideoElement | null
  /** 面板当前应显（panelVisibleNow 单点；dock 触发前提）。 */
  panelShown: () => boolean
  /** 已知稍后看面判定（pathname /list/* 或 ?page=WatchLater*；接线层注入，page 值前缀容错）。 */
  isWatchlaterSurface: () => boolean
  /** WXT shadow 宿主（落位前隐藏，落位后移入 wrapper）；null = 面板 UI 未装配。 */
  getHost: () => HTMLElement | null
  /** 面板应用挂载（先落位后挂应用的「挂」半步；控制器保证首次落位成功才调用一次）。 */
  mountPanelApp: () => void
}

/**
 * 落位/浮动 dock 状态机。接线层以 1.5s 周期调 tick()（原版为 500ms 重试链 + 观察器，
 * 周期检查承担同职责）；insertion/可见性全部经注入的宿主完成。
 */
export class PanelPlacementController {
  // ---------- 内联落位状态（原版 vg/hg/bg/yg/kn/fg/mg 一族） ----------
  private wrapper: HTMLDivElement | null = null
  private placedParent: HTMLElement | null = null
  private anchor: Element | null = null
  private anchorAt: number | null = null
  private commentsSeen = false
  private quietAt: number | null = null
  private quietObserver: MutationObserver | null = null
  private quietObserved: Element | null = null
  private appMounted = false

  // ---------- 浮动 dock 状态 ----------
  private dockWrapper: HTMLDivElement | null = null
  private lastSurface: boolean | null = null
  private dockClockAt: number | null = null

  /** 失效清理置位：置位后周期拍全部早退（getHost 仍返回脱离 DOM 的宿主，不能让它重新落位）。 */
  private disposed = false

  private mode: PanelPlacementMode = 'none'

  constructor(private readonly deps: PanelPlacementDeps) {}

  /** 内部状态观察（仅供测试/排障；接线层勿依赖其形状）。 */
  debugState(): {
    mode: PanelPlacementMode
    anchor: Element | null
    anchorAt: number | null
    commentsSeen: boolean
    quietAt: number | null
    inlineConnected: boolean
    dockConnected: boolean
    dockClockAt: number | null
  } {
    return {
      mode: this.mode,
      anchor: this.anchor,
      anchorAt: this.anchorAt,
      commentsSeen: this.commentsSeen,
      quietAt: this.quietAt,
      inlineConnected: this.wrapper?.isConnected ?? false,
      dockConnected: this.dockWrapper?.isConnected ?? false,
      dockClockAt: this.dockClockAt,
    }
  }

  /** 周期拍：模式判定 → 内联落位（video/list）或休眠 → 浮动 dock 兜底。 */
  tick(): void {
    if (this.disposed) return
    const host = this.deps.getHost()
    if (!host) return
    // 门 1（全模式共用）：整页 load 完成（原版 ug 语义）。
    if (this.deps.doc().readyState !== 'complete') {
      this.detachPanel()
      return
    }
    this.syncDockSurface()
    const mode = this.detectMode()
    this.mode = mode
    if (mode === 'video') {
      this.placeVideo(host)
    } else if (mode === 'list') {
      this.placeList(host)
    } else {
      // 非视频/列表页（普通首页、搜索、空间等）：休眠——宿主整体移除（原版 xg 语义），锚点状态复位。
      this.resetPanelAnchorState()
      this.detachPanel()
    }
    // 浮动 dock 兜底：仅已知稍后看面且内联落位未连接时触发（视频页被 surface 判定挡住）。
    this.updateDock(host)
  }

  /**
   * 共享锚点状态复位（换面 / SPA 过渡）：连带复位右栏静止时间戳——复位不全是共享状态
   * 契约缺口（未来消费者拿到陈旧 quiet 会误判静止）。
   */
  resetPanelAnchorState(): void {
    this.anchor = null
    this.anchorAt = null
    this.commentsSeen = false
    this.quietAt = null
  }

  /** 扩展失效/重载清理：内联 wrapper 与 dock wrapper 从宿主 DOM 摘除（不留空壳），
   *  并置位 disposed 让后续周期拍早退——否则 1.5s 后空壳会被重新插回。 */
  dispose(): void {
    this.disposed = true
    this.resetPanelAnchorState()
    this.wrapper?.remove()
    this.wrapper = null
    this.placedParent = null
    this.dockWrapper?.remove()
    this.dockWrapper = null
    this.quietObserver?.disconnect()
    this.quietObserver = null
    this.quietObserved = null
    this.lastSurface = null
    this.dockClockAt = null
  }

  // ---------- 模式判定 ----------

  /**
   * 落位模式判定：/video/* 固定走视频页模式（现有落位行为零改动）；
   * /list/* 或存在左栏列表容器走列表页模式；其余不内联落位（dock 兜底/休眠）。
   */
  private detectMode(): PanelPlacementMode {
    let pathname = ''
    try {
      pathname = new URL(this.deps.pageHref()).pathname
    } catch {
      pathname = ''
    }
    if (pathname.startsWith('/video/')) return 'video'
    if (pathname.startsWith('/list/') || this.deps.dom.hasListLeft()) return 'list'
    return 'none'
  }

  // ---------- 视频页模式 ----------

  /**
   * 视频页落位：原版就绪三重门（load→评论探针→右栏静止）+ up 卡/弹幕框锚点。
   * 从接线层原版实现逐字迁移：选择器/门序/淡入零改动。
   */
  private placeVideo(host: HTMLElement): void {
    const column = this.deps.dom.findPanelColumn()
    const up = column ? this.deps.dom.findUpPanel(column) : null
    if (!column || !up || !column.contains(up)) {
      // 非视频页 / SPA 过渡：宿主整体移除（原版 xg 语义），锚点状态复位。
      this.resetPanelAnchorState()
      this.detachPanel()
      return
    }
    this.observeQuietColumn(column)
    if (up !== this.anchor) {
      // 新锚点（首次出现 / SPA 换视频）：先摘除，重走就绪三重门。
      this.beginAnchor(up, true)
      return
    }
    // 门 2：评论区挂载（8s 超时兜底；原版 fg + Mh 探针）。
    if (!this.commentsSeen) {
      this.commentsSeen = this.deps.dom.findCommentsProbe() !== null
      if (
        !this.commentsSeen &&
        (this.anchorAt === null || this.deps.now() - this.anchorAt < PANEL_COMMENTS_TIMEOUT_MS)
      ) {
        return
      }
    }
    // 门 3：右栏 600ms 静止（12s 超时兜底；原版 mg）。
    if (!this.quietGateOpen()) return
    if (this.wrapper?.isConnected && this.placedParent !== null) {
      host.style.display = ''
      return
    }
    // 宽屏模式（.bpx-player-ctrl-wide.bpx-state-entered）插在 #danmukuBox 之后，否则插在 up 卡之后。
    const wide = this.deps.dom.isWide()
    const ref = wide ? this.deps.dom.findDanmakuBox() : up
    if (!ref || ref.parentElement !== column) return
    this.insertInlineWrapper(host, (wrapper) => ref.after(wrapper))
  }

  // ---------- 列表页模式 ----------

  /**
   * 列表页落位（/list/*）：锚点 .playlist-container--right，插入其内部最前（播放列表上方）；
   * 列表页无 #commentapp——跳过评论探针门，静止门保留（600ms 静止 / 12s 超时兜底）。
   */
  private placeList(host: HTMLElement): void {
    const anchor = this.deps.dom.findListAnchor()
    if (!anchor) {
      // 列表右栏缺失（首页 tab 布局 / 改版）：锚点状态复位，交给 dock 兜底。
      this.resetPanelAnchorState()
      this.detachPanel()
      return
    }
    this.observeQuietColumn(anchor)
    if (anchor !== this.anchor) {
      // 新锚点（首次出现 / SPA 换列表）：先摘除，重走静止门。
      this.beginAnchor(anchor, false)
      return
    }
    // 静止门（评论探针门跳过：列表页无 #commentapp）。
    if (!this.quietGateOpen()) return
    if (this.wrapper?.isConnected && this.placedParent !== null) {
      host.style.display = ''
      return
    }
    this.insertInlineWrapper(host, (wrapper) => {
      anchor.prepend(wrapper) // 列表容器内部最前 = 播放列表上方
    })
  }

  // ---------- 落位原语 ----------

  /** 新锚点（首次出现 / SPA 换视频/列表）：记录锚点与门时间戳，摘除旧宿主重走就绪门。 */
  private beginAnchor(anchor: Element, probeComments: boolean): void {
    this.anchor = anchor
    this.anchorAt = this.deps.now()
    this.commentsSeen = probeComments ? this.deps.dom.findCommentsProbe() !== null : false
    this.quietAt = this.deps.now()
    this.detachPanel()
  }

  /** 门 3：右栏 600ms 静止（12s 超时兜底；原版 mg）。 */
  private quietGateOpen(): boolean {
    const now = this.deps.now()
    return (
      (this.quietAt !== null && now - this.quietAt >= PANEL_QUIET_WINDOW_MS) ||
      (this.anchorAt !== null && now - this.anchorAt > PANEL_QUIET_TIMEOUT_MS)
    )
  }

  /** 右栏静止探针：childList 变化即重置计时，周期检查拍点距上次变化 ≥600ms 视为静止。 */
  private observeQuietColumn(column: Element): void {
    if (this.quietObserved === column && this.quietObserver) return
    this.quietObserver?.disconnect()
    this.quietObserver = new MutationObserver(() => {
      this.quietAt = this.deps.now()
    })
    this.quietObserver.observe(column, { childList: true, subtree: true })
    this.quietObserved = column
    this.quietAt = this.deps.now()
  }

  /** 内联插入原语：创建原版同款 wrapper、挂宿主、首次落位挂应用、800ms 淡入。 */
  private insertInlineWrapper(host: HTMLElement, place: (wrapper: HTMLDivElement) => void): void {
    const wrapper = this.deps.doc().createElement('div')
    wrapper.id = PANEL_HOST_ID
    wrapper.className = PANEL_HOST_CLASS
    wrapper.style.cssText =
      'display:block;width:100%;margin:0 0 12px;opacity:0;transition:opacity 0.2s ease-in-out'
    wrapper.appendChild(host)
    place(wrapper)
    this.wrapper = wrapper
    this.placedParent = wrapper.parentElement
    host.style.display = ''
    // 首次落位成功才挂载面板应用（原版：先落位后挂应用；dock 首浮同口径）。
    if (!this.appMounted) {
      this.appMounted = true
      this.deps.mountPanelApp()
    }
    // 原版淡入：插入后 800ms 内无人再动 opacity 才现身。
    this.deps.timers.setTimeout(() => {
      if (this.wrapper === wrapper && wrapper.style.opacity !== '1') {
        wrapper.style.opacity = '1'
      }
    }, PANEL_FADE_IN_MS)
  }

  private detachPanel(): void {
    this.wrapper?.remove()
    this.wrapper = null
    this.placedParent = null
    const host = this.deps.getHost()
    if (host) host.style.display = 'none'
  }

  // ---------- 浮动 dock 兜底 ----------

  /**
   * dock 时钟同步：仅 surface 变化复位——findVideo/panelShown 的瞬时缺失只影响当拍，
   * 不得把兜底无限推迟（画质切换换元素等抖动场景）；离开稍后看面 dock 即刻退场。
   */
  private syncDockSurface(): void {
    const surface = this.deps.isWatchlaterSurface()
    if (surface === this.lastSurface) return
    this.lastSurface = surface
    this.dockClockAt = surface ? this.deps.now() : null
    if (!surface) this.exitDock()
  }

  private updateDock(host: HTMLElement): void {
    if (this.wrapper?.isConnected) {
      // 内联落位成功：dock 退场（时钟保留——同面内联再次失效时兜底立即接上）。
      this.exitDock()
      return
    }
    if (this.lastSurface !== true || this.dockClockAt === null) return
    if (!this.deps.panelShown()) {
      // 显隐 gate 暂关（全屏/后台标签/快开关）：dock 暂歇（时钟保留，恢复即现身）。
      this.exitDock()
      return
    }
    if (this.deps.findVideo() === null) return // 播放器瞬时缺失：只跳过本拍。
    if (this.deps.now() - this.dockClockAt < PANEL_DOCK_FALLBACK_MS) return
    if (this.dockWrapper?.isConnected) {
      host.style.display = ''
      return
    }
    // 内联锚点待门（就绪门未走完）期间暂不浮出：避免 dock 先浮一拍、下一拍移交内联的闪跳。
    // 首页等 mode none 面 anchor 恒为 null，不受影响。
    if (this.anchor !== null) return
    const dock = this.deps.doc().createElement('div')
    dock.id = PANEL_DOCK_ID
    dock.style.cssText = [
      'position:fixed',
      'top:76px',
      'right:16px',
      `width:${PANEL_DOCK_WIDTH_PX}px`,
      'max-height:calc(100vh - 96px)',
      'overflow-y:auto',
      'opacity:0',
      'transition:opacity 0.2s ease-in-out',
      'z-index:2147483000',
    ].join(';')
    dock.appendChild(host)
    this.deps.doc().body.appendChild(dock)
    this.dockWrapper = dock
    host.style.display = ''
    if (!this.appMounted) {
      this.appMounted = true
      this.deps.mountPanelApp()
    }
    // 原版淡入（与内联落位同语义）：浮出后 800ms 内无人再动 opacity 才现身。
    this.deps.timers.setTimeout(() => {
      if (this.dockWrapper === dock && dock.style.opacity !== '1') {
        dock.style.opacity = '1'
      }
    }, PANEL_FADE_IN_MS)
  }

  private exitDock(): void {
    if (!this.dockWrapper) return
    this.dockWrapper.remove()
    this.dockWrapper = null
    const host = this.deps.getHost()
    // 内联落位未接管宿主时才隐藏；内联已接管（wrapper 连接中）时由落位逻辑管理可见性。
    if (host && !this.wrapper?.isConnected) host.style.display = 'none'
  }
}
