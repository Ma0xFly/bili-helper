// 左右分屏（Epic3-S3.1–3.3）：播放器控制栏注入按钮，激活后左侧沉浸播放、右侧标签壳
// （详情/AI助手/评论/弹幕/推荐/合集）承载被迁移的原生节点。
// 迁移用「锚点 + 原 display」记录，退出时逆序还原（页面回到 B 站原样）；
// 播放器模式互斥（pip/宽屏/网页全屏/全屏不激活，激活前先退冲突模式）；
// ≤980px 纵向回退；ResizeObserver 同步播放器尺寸。停止 = 全还原。

export const SPLIT_BODY_CLASS = 'bili-helper-left-right-split-screen-active'
export const SPLIT_STYLE_ID = 'bili-helper-left-right-split-screen-style'
const SHELL_CLASS = 'bili-helper-split-shell'
const BUTTON_CLASS = 'bili-helper-split-button'
const BUTTON_RETRY_MS = 250
const BUTTON_RETRY_MAX = 40
export const NARROW_WIDTH_PX = 980

/** 右栏标签 → 迁移选择器表（找不到内容的标签显示空态）。 */
export const SPLIT_TABS = [
  { key: 'detail', label: '详情', selectors: ['.up-panel-container', '#viewbox_report', '.video-info-container', '.video-desc-container', '.video-tag-container'] },
  { key: 'ai', label: 'AI助手', selectors: ['#bili-helper-ai-panel-host'] },
  { key: 'comment', label: '评论', selectors: ['#commentapp'] },
  { key: 'danmaku', label: '弹幕', selectors: ['#danmukuBox'] },
  { key: 'recommend', label: '推荐', selectors: ['.recommend-list-container', '.recommend-list-v1'] },
  { key: 'playlist', label: '合集', selectors: ['.action-list-container', '.video-pod'] },
] as const

export type SplitTabKey = (typeof SPLIT_TABS)[number]['key']

const SPLIT_CSS = `
body.${SPLIT_BODY_CLASS} #mirror-vdcon.video-container-v1, body.${SPLIT_BODY_CLASS} #mirror-vdcon.playlist-container { display: flex !important; }
body.${SPLIT_BODY_CLASS} .left-container, body.${SPLIT_BODY_CLASS} .playlist-container--left { flex: 1 1 auto; min-width: 0; }
body.${SPLIT_BODY_CLASS} .right-container, body.${SPLIT_BODY_CLASS} .playlist-container--right { flex: 0 0 clamp(360px, 28vw, 520px) !important; min-width: 0; }
body.${SPLIT_BODY_CLASS} #playerWrap { flex: 1; }
body.${SPLIT_BODY_CLASS} .right-container-inner { position: static !important; }
body.${SPLIT_BODY_CLASS} .right-container-inner > :not(.${SHELL_CLASS}) { display: none !important; }
body.${SPLIT_BODY_CLASS} .activity-m-v1, body.${SPLIT_BODY_CLASS} .left-banner { display: none !important; }
.${SHELL_CLASS} { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.${SHELL_CLASS}-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
.${SHELL_CLASS}-tab { font-size: 12.5px; padding: 4px 12px; border-radius: 999px; border: 1px solid #e3def0; background: #fff; color: #4c4661; cursor: pointer; }
.${SHELL_CLASS}-tab.on { background: linear-gradient(135deg, #7c5cfc, #ff8fb1); color: #fff; border-color: transparent; }
.${SHELL_CLASS}-panel { overflow: auto; min-height: 0; max-height: var(--bili-helper-split-height, 80vh); }
.${SHELL_CLASS}-panel[hidden] { display: none; }
.${SHELL_CLASS}-empty { color: #9b95ad; font-size: 12px; padding: 18px 8px; }
.${SHELL_CLASS}-toolbar-rail { display: flex; }
@media (max-width: ${NARROW_WIDTH_PX}px) {
  body.${SPLIT_BODY_CLASS} #mirror-vdcon.video-container-v1, body.${SPLIT_BODY_CLASS} #mirror-vdcon.playlist-container { flex-direction: column; }
  body.${SPLIT_BODY_CLASS} .right-container, body.${SPLIT_BODY_CLASS} .playlist-container--right { flex: none !important; width: 100% !important; }
}
button.${BUTTON_CLASS} { color: #fff; }
button.${BUTTON_CLASS}.is-active { color: #fb7299; }
`

/** 迁移记录：锚点（原位置占位）+ 原 display。 */
interface Migration {
  node: HTMLElement
  anchor: Comment
  previousDisplay: string
  panel: SplitTabKey
}

/** 播放器冲突模式判定（pip/小窗、宽屏/剧场、网页全屏、全屏）。 */
export function inConflictingPlayerMode(doc: Document): boolean {
  const container = doc.querySelector('.bpx-player-container')
  if (container === null) return false
  if (container.getAttribute('data-screen') === 'mini') return true
  if (container.getAttribute('data-screen') === 'full') return true
  return (
    doc.querySelector('.bpx-player-ctrl-pip.bpx-state-entered') !== null ||
    doc.querySelector('.bpx-player-ctrl-web.bpx-state-entered') !== null ||
    doc.querySelector('.bpx-player-ctrl-wide.bpx-state-entered') !== null
  )
}

/** 依次点掉冲突模式（点按钮即切换）；点不动就放弃（由调用方决定不激活）。 */
function exitConflictingModes(doc: Document): void {
  for (const selector of [
    '.bpx-player-ctrl-pip.bpx-state-entered',
    '.bpx-player-ctrl-wide.bpx-state-entered',
    '.bpx-player-ctrl-web.bpx-state-entered',
  ]) {
    doc.querySelector<HTMLButtonElement>(selector)?.click()
  }
  if (doc.querySelector('.bpx-player-container')?.getAttribute('data-screen') === 'full') {
    doc.querySelector<HTMLButtonElement>('.bpx-player-ctrl-full')?.click()
  }
}

export function createSplitScreenRuntime(options: { doc?: Document } = {}): {
  start(): void
  stop(): void
  /** 诊断/测试：当前是否激活。 */
  isActive(): boolean
} {
  const doc = options.doc ?? (typeof document !== 'undefined' ? document : null)
  if (doc === null) return { start(): void {}, stop(): void {}, isActive: () => false }

  let active = false
  let style: HTMLStyleElement | null = null
  let shell: HTMLElement | null = null
  let button: HTMLButtonElement | null = null
  let resizeObserver: ResizeObserver | null = null
  let resizeListener: (() => void) | null = null
  let retryTimer: number | undefined
  let retryCount = 0
  const migrations: Migration[] = []

  const heightVar = (): void => {
    const container = doc.querySelector('#mirror-vdcon')
    if (container === null) return
    const top = container.getBoundingClientRect().top
    const height = Math.max(420, Math.round(window.innerHeight - top - 12))
    doc.documentElement.style.setProperty('--bili-helper-split-height', `${height}px`)
  }

  const syncPlayerSize = (): void => {
    const wrap = doc.querySelector('#playerWrap')
    const player = doc.querySelector('#bilibili-player')
    if (wrap === null || player === null) return
    const rect = wrap.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    ;(player as HTMLElement).style.width = `${Math.round(rect.width)}px`
    ;(player as HTMLElement).style.height = `${Math.round(rect.height)}px`
  }

  const migrateTo = (panel: HTMLElement, tab: SplitTabKey, selectors: readonly string[]): void => {
    for (const selector of selectors) {
      for (const node of [...doc.querySelectorAll<HTMLElement>(selector)]) {
        if (migrations.some((m) => m.node === node)) continue
        const anchor = doc.createComment('bili-helper-split-anchor')
        node.before(anchor)
        migrations.push({ node, anchor, previousDisplay: node.style.display, panel: tab })
        panel.append(node)
      }
    }
  }

  const buildShell = (): void => {
    const inner = doc.querySelector('.right-container-inner, .playlist-container--right > *')
    const mountPoint = doc.querySelector('.right-container-inner') ?? inner?.parentElement ?? null
    if (mountPoint === null) {
      console.warn('[bili-helper:split-screen] split screen mount target missing')
      return
    }
    shell = doc.createElement('section')
    shell.className = SHELL_CLASS
    const tabs = doc.createElement('div')
    tabs.className = `${SHELL_CLASS}-tabs`
    const panels: Record<string, HTMLElement> = {}
    for (const tab of SPLIT_TABS) {
      const tabButton = doc.createElement('button')
      tabButton.type = 'button'
      tabButton.className = `${SHELL_CLASS}-tab`
      tabButton.textContent = tab.label
      tabButton.dataset.tab = tab.key
      tabButton.addEventListener('click', () => selectTab(tab.key))
      tabs.append(tabButton)
      const panel = doc.createElement('div')
      panel.className = `${SHELL_CLASS}-panel`
      panel.dataset.panel = tab.key
      panel.hidden = true
      panels[tab.key] = panel
      shell?.append(panel)
    }
    shell.prepend(tabs)
    // 迁移（合集面板条件可用：选择器找不到就留空态）。
    for (const tab of SPLIT_TABS) {
      migrateTo(panels[tab.key] as HTMLElement, tab.key, tab.selectors)
    }
    // 空态标注 + 默认选第一个有内容的标签。
    mountPoint.prepend(shell)
    let firstAvailable: SplitTabKey | null = null
    for (const tab of SPLIT_TABS) {
      const panel = panels[tab.key] as HTMLElement
      const hasContent = migrations.some((m) => m.panel === tab.key)
      if (!hasContent) {
        const empty = doc.createElement('p')
        empty.className = `${SHELL_CLASS}-empty`
        empty.textContent = `${tab.label}暂不可用`
        panel.append(empty)
      } else if (firstAvailable === null) {
        firstAvailable = tab.key
      }
    }
    selectTab(firstAvailable ?? 'detail')
    heightVar()
  }

  const selectTab = (key: SplitTabKey): void => {
    shell?.querySelectorAll(`.${SHELL_CLASS}-tab`).forEach((el) => {
      el.classList.toggle('on', (el as HTMLElement).dataset.tab === key)
    })
    shell?.querySelectorAll(`.${SHELL_CLASS}-panel`).forEach((el) => {
      ;(el as HTMLElement).hidden = (el as HTMLElement).dataset.panel !== key
    })
  }

  const restoreAll = (): void => {
    for (const record of migrations.reverse()) {
      record.anchor.parentNode?.insertBefore(record.node, record.anchor)
      record.node.style.display = record.previousDisplay
      record.anchor.remove()
    }
    migrations.length = 0
    shell?.remove()
    shell = null
    doc.documentElement.style.removeProperty('--bili-helper-split-height')
    const player = doc.querySelector('#bilibili-player') as HTMLElement | null
    if (player !== null) {
      player.style.width = ''
      player.style.height = ''
    }
  }

  const deactivate = (): void => {
    if (!active) return
    active = false
    restoreAll()
    resizeObserver?.disconnect()
    resizeObserver = null
    resizeListener && window.removeEventListener('resize', resizeListener)
    resizeListener = null
    doc.body.classList.remove(SPLIT_BODY_CLASS)
    button?.classList.remove('is-active')
    if (button !== null) button.title = '左右分屏'
    console.info('[bili-helper:split-screen] deactivated')
  }

  const activate = (): void => {
    if (active) return
    if (inConflictingPlayerMode(doc)) {
      exitConflictingModes(doc)
      if (inConflictingPlayerMode(doc)) {
        console.warn('[bili-helper:split-screen] failed to exit conflicting player mode')
        return
      }
    }
    if (doc.querySelector('.right-container-inner, .playlist-container--right') === null) {
      console.warn('[bili-helper:split-screen] split screen mount target missing')
      return
    }
    active = true
    doc.body.classList.add(SPLIT_BODY_CLASS)
    if (style === null) {
      style = doc.createElement('style')
      style.id = SPLIT_STYLE_ID
      style.textContent = SPLIT_CSS
      doc.head.append(style)
    }
    buildShell()
    const wrap = doc.querySelector('#playerWrap')
    if (typeof ResizeObserver !== 'undefined' && wrap !== null) {
      resizeObserver = new ResizeObserver(() => {
        heightVar()
        syncPlayerSize()
      })
      resizeObserver.observe(wrap)
    }
    resizeListener = () => {
      heightVar()
      syncPlayerSize()
    }
    window.addEventListener('resize', resizeListener)
    syncPlayerSize()
    button?.classList.add('is-active')
    if (button !== null) button.title = '关闭左右分屏'
    console.info('[bili-helper:split-screen] activated')
  }

  const ensureButton = (): void => {
    if (button?.isConnected === true) return
    const host = doc.querySelector('.bpx-player-control-bottom-right')
    const pip = doc.querySelector('.bpx-player-ctrl-pip')
    if (host === null || pip === null) {
      if (retryCount < BUTTON_RETRY_MAX) {
        retryCount += 1
        retryTimer = window.setTimeout(ensureButton, BUTTON_RETRY_MS)
      }
      return
    }
    button = doc.createElement('button')
    button.type = 'button'
    button.className = `bpx-player-ctrl-btn ${BUTTON_CLASS}`
    button.title = '左右分屏'
    button.setAttribute('aria-label', '左右分屏')
    button.textContent = '分屏'
    button.addEventListener('click', () => (active ? deactivate() : activate()))
    pip.after(button)
  }

  return {
    start(): void {
      console.info('[bili-helper:split-screen] started')
      retryCount = 0
      ensureButton()
    },
    stop(): void {
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      retryTimer = undefined
      deactivate()
      button?.remove()
      button = null
      style?.remove()
      style = null
      console.info('[bili-helper:split-screen] stopped')
    },
    isActive: () => active,
  }
}
