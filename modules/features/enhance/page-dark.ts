// 页面深色跟随浏览器：浏览器 prefers-color-scheme 变化时切换 **B 站官方深色主题**。
// 官方开关位就是 cookie `theme_style`（dark = 深；Bilibili-Evolved integrated dark mode
// 同口径）。扩展只做这个官方接口的写入器——不自绘任何配色；能否原生渲染深色由 B 站
// 侧决定（灰测/登录账号），匿名账号写了也不出效果，属官方能力边界。
//
// 行为细则：
//   - 浏览器深色 → 写 theme_style=dark（一年期）；浏览器浅色 → 只在我们写过的情况下清除
//     （用户自己在 B 站开的官方深色是ta的明确选择，不代擦）。「是不是我们写的」用
//     chrome.storage.session 的标记位记忆（会话级、跨标签页、不落用户站内存储）。
//   - 浏览器主题在页面开着的时候翻转：写完 cookie 后整页刷新一次让官方主题生效
//     （SSR/首屏按 cookie 出样式，外部写 cookie 不会触发现有页面的活重绘）。
//     刷新只在页面可见、且距上次刷新 ≥60s 时执行，后台标签交给下次导航。
//   - stop()：停听停写；cookie 保持现状（用户可见的站级状态，插件关掉不该偷偷改回）。

export const OFFICIAL_THEME_COOKIE = 'theme_style'
/** 「深色 cookie 是我们写的」标记（chrome.storage.session，会话级）。 */
export const OWN_COOKIE_MARKER_KEY = 'biliHelperPageDarkOwnCookie'
/** 运行中主题翻转触发的整页刷新，两次之间最小间隔。 */
export const RELOAD_MIN_INTERVAL_MS = 60_000

export interface PageDarkMedia {
  /** 浏览器亮暗探针；生产传 window.matchMedia('(prefers-color-scheme: dark)') 的返回。 */
  matches: () => boolean
  /** 亮暗变化监听；返回退订函数。监听器可返回 Promise（调用方自行决定是否等待）。 */
  subscribe: (listener: () => void | Promise<void>) => () => void
}

export interface PageDarkRuntimeOptions {
  doc?: Document
  media?: PageDarkMedia
  /** 官方开关位读取；默认读 document.cookie 的 theme_style。 */
  readOfficial?: () => 'dark' | 'light'
  /** 官方开关位写入；默认写/删 document.cookie 的 theme_style（.bilibili.com 一年期）。 */
  writeOfficial?: (dark: boolean) => void
  /** 「cookie 是我们写的」标记读取/写入/清除；默认走 chrome.storage.session。 */
  readOwnMarker?: () => Promise<boolean>
  writeOwnMarker?: (value: boolean) => Promise<void>
  /** 整页刷新（默认 location.reload）；测试注入观察。 */
  reload?: () => void
  /** 刷新节流参考时钟（默认 Date.now）。 */
  now?: () => number
}

export function createPageDarkRuntime(options: PageDarkRuntimeOptions = {}): {
  start(): Promise<void>
  stop(): void
} {
  const doc = options.doc ?? (typeof document !== 'undefined' ? document : null)
  const media = options.media ?? defaultMedia()
  if (doc === null || media === null) return { start: async () => {}, stop: () => {} }
  const readOfficial = options.readOfficial ?? defaultReadCookie(doc)
  const writeOfficial = options.writeOfficial ?? defaultWriteCookie(doc)
  const readOwnMarker = options.readOwnMarker ?? defaultReadMarker
  const writeOwnMarker = options.writeOwnMarker ?? defaultWriteMarker
  const reload = options.reload ?? (() => window.location.reload())
  const now = options.now ?? (() => Date.now())

  let unsubscribe: (() => void) | null = null
  let lastReloadAt = 0

  /** 与官方开关位对齐；只有 cookie 实际翻转时才值得刷新（start 传 false 永不刷）。 */
  const syncOfficial = async (allowReload: boolean): Promise<void> => {
    const wantDark = media.matches()
    const current = readOfficial()
    if (wantDark) {
      if (current !== 'dark') {
        writeOfficial(true)
        await writeOwnMarker(true)
        if (allowReload) maybeReload()
      }
      return
    }
    // 浅色：只擦我们自己写的深色；用户手动开的官方深色不动。
    if (current === 'dark' && (await readOwnMarker())) {
      writeOfficial(false)
      await writeOwnMarker(false)
      if (allowReload) maybeReload()
    }
  }

  const maybeReload = (): void => {
    if (doc.visibilityState !== 'visible') return
    const timestamp = now()
    if (timestamp - lastReloadAt < RELOAD_MIN_INTERVAL_MS) return
    lastReloadAt = timestamp
    reload()
  }

  return {
    async start() {
      await syncOfficial(false)
      if (unsubscribe === null) unsubscribe = media.subscribe(() => void syncOfficial(true))
    },
    stop() {
      if (unsubscribe !== null) {
        unsubscribe()
        unsubscribe = null
      }
    },
  }
}

function defaultReadCookie(doc: Document): () => 'dark' | 'light' {
  return () => {
    const match = new RegExp(
      `(?:^|;\\s*)${OFFICIAL_THEME_COOKIE}=([^;]*)`,
    ).exec(doc.cookie ?? '')
    return match?.[1]?.trim() === 'dark' ? 'dark' : 'light'
  }
}

function defaultWriteCookie(doc: Document): (dark: boolean) => void {
  return (dark) => {
    if (dark) {
      doc.cookie = `${OFFICIAL_THEME_COOKIE}=dark; domain=.bilibili.com; path=/; max-age=31536000; SameSite=Lax`
    } else {
      doc.cookie = `${OFFICIAL_THEME_COOKIE}=; domain=.bilibili.com; path=/; max-age=0; SameSite=Lax`
    }
  }
}

function defaultReadMarker(): Promise<boolean> {
  return chrome.storage.session
    .get(OWN_COOKIE_MARKER_KEY)
    .then((result) => (result as Record<string, unknown>)[OWN_COOKIE_MARKER_KEY] === true)
    .catch(() => false)
}

function defaultWriteMarker(value: boolean): Promise<void> {
  return chrome.storage.session
    .set(value ? { [OWN_COOKIE_MARKER_KEY]: true } : { [OWN_COOKIE_MARKER_KEY]: false })
    .catch(() => undefined)
}

function defaultMedia(): PageDarkMedia | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  try {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    return {
      matches: () => query.matches,
      subscribe: (listener) => {
        query.addEventListener('change', listener)
        return () => query.removeEventListener('change', listener)
      },
    }
  } catch {
    return null
  }
}
