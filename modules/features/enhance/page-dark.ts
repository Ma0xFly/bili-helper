// 页面深色跟随浏览器：浏览器 prefers-color-scheme 变深时给整页套深色配色，变浅立即还原。
//
// 主题信号有两级（与 Bilibili-Evolved integrated dark mode 同一口径）：
//   ① 官方优先：cookie `theme_style=dark` 是 B 站官方深色模式的开关位（灰测用户顶栏切换时写入）。
//      官方开着 → 整页由 B 站自己上色（灰测账号），我们只设桥接属性让浮层/标记跟随，绝不叠加反色
//      （否则双重变暗）。cookie 只读不写——写用户站级状态越权，功能关闭也无法恢复。
//   ② 浏览器兜底：官方没开时跟随 prefers-color-scheme，由扩展自绘深色：html 级反色滤镜 +
//      媒体/播放器精确还原。配方关键点（真机实测与像素级推演）：
//      - filter 落在 html 根元素上——Chrome 对根元素滤镜特判，position:fixed 仍锚定视口
//        （落在 body 子层则 fixed 头部会随页面滚走，实测否决）；
//      - 反转的精确逆是 hue-rotate(-180deg) invert(1)（先逆色相再反转灰度，与正变换严格互逆，
//        逐像素还原），不是把同款滤镜再叠一遍——后者对饱和色有色相漂移；
//      - 播放器容器本来就是深色设计，整容器还原、容器内媒体不再叠加还原。
// html[data-bh-page-dark] 同时是 AI 浮层的亮暗桥（entrypoints/content 的 isDarkMode 读它）：
// 页面深色 → 浮层用暗色 token，但浮层宿主自身做逆还原，呈现的是原本的暗色设计而非反色。

/** 深色配方的完整样式（id 固定，stop 时整块摘除，零残留）。 */
export const PAGE_DARK_STYLE_ID = 'bili-helper-page-dark-style'

export const PAGE_DARK_CSS = `
html[data-bh-page-dark] {
  filter: invert(1) hue-rotate(180deg);
}
html[data-bh-page-dark] img,
html[data-bh-page-dark] picture,
html[data-bh-page-dark] svg,
html[data-bh-page-dark] canvas,
html[data-bh-page-dark] iframe,
html[data-bh-page-dark] video {
  filter: hue-rotate(-180deg) invert(1);
}
html[data-bh-page-dark] .bpx-player-container {
  filter: hue-rotate(-180deg) invert(1);
}
html[data-bh-page-dark] .bpx-player-container img,
html[data-bh-page-dark] .bpx-player-container video,
html[data-bh-page-dark] .bpx-player-container canvas,
html[data-bh-page-dark] .bpx-player-container svg,
html[data-bh-page-dark] .bpx-player-container iframe {
  filter: none;
}
`

export interface PageDarkMedia {
  /** 浏览器亮暗探针；生产传 window.matchMedia('(prefers-color-scheme: dark)') 的返回。 */
  matches: () => boolean
  /** 亮暗变化监听；返回退订函数。 */
  subscribe: (listener: () => void) => () => void
}

export interface PageDarkRuntimeOptions {
  doc?: Document
  media?: PageDarkMedia
  /** 官方深色开关探针（cookie `theme_style=dark`）；默认读 document.cookie。 */
  officialDark?: () => boolean
  /** 重估节拍（cookie 变化无事件，轮询兜底）；默认 2000ms，测试可注入 0 关闭。 */
  pollMs?: number
  setInterval?: (handler: () => void, ms: number) => number
  clearInterval?: (id: number) => void
}

export function createPageDarkRuntime(options: PageDarkRuntimeOptions = {}): {
  start(): void
  stop(): void
} {
  const doc = options.doc ?? (typeof document !== 'undefined' ? document : null)
  const media = options.media ?? defaultMedia()
  if (doc === null || media === null) return { start(): void {}, stop(): void {} }
  const officialDark =
    options.officialDark ??
    (() => /(?:^|;\s*)theme_style=dark(?:;|$)/.test(doc.cookie ?? ''))
  const pollMs = options.pollMs ?? 2_000
  const setIntervalFn =
    options.setInterval ?? ((handler: () => void, ms: number) => window.setInterval(handler, ms))
  const clearIntervalFn =
    options.clearInterval ?? ((id: number) => window.clearInterval(id))

  let style: HTMLStyleElement | null = null
  let unsubscribe: (() => void) | null = null
  let pollTimer: number | null = null

  const setAttr = (value: boolean): void => {
    if (value) doc.documentElement.setAttribute('data-bh-page-dark', 'true')
    else doc.documentElement.removeAttribute('data-bh-page-dark')
  }

  const apply = (): void => {
    if (officialDark()) {
      // 官方深色开着：B 站自己上色，我们只桥接浮层，绝不叠加反色（双重变暗）。
      setAttr(true)
      style?.remove()
      style = null
      return
    }
    if (media.matches()) {
      setAttr(true)
      if (style === null || !style.isConnected) {
        style = doc.createElement('style')
        style.id = PAGE_DARK_STYLE_ID
        style.textContent = PAGE_DARK_CSS
        ;(doc.head ?? doc.documentElement).appendChild(style)
      }
      return
    }
    setAttr(false)
    style?.remove()
    style = null
  }

  return {
    start() {
      apply()
      if (unsubscribe === null) unsubscribe = media.subscribe(apply)
      if (pollTimer === null && pollMs > 0) {
        pollTimer = setIntervalFn(apply, pollMs)
      }
    },
    stop() {
      if (unsubscribe !== null) {
        unsubscribe()
        unsubscribe = null
      }
      if (pollTimer !== null) {
        clearIntervalFn(pollTimer)
        pollTimer = null
      }
      setAttr(false)
      style?.remove()
      style = null
    },
  }
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
