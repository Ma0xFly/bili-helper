// 页面深色跟随浏览器：浏览器 prefers-color-scheme 变深时给整页套深色配色，变浅立即还原。
// B 站 web 没有可编程的官方深色开关（cookie theme_style=dark / localStorage pbp_theme_v4
// 实测匿名态均不生效），因此深色由本扩展自绘：html 级反色滤镜 + 媒体/播放器精确还原。
// 配方关键点（真机实测与像素级推演）：
//   ① filter 落在 html 根元素上——Chrome 对根元素滤镜特判，position:fixed 仍锚定视口
//      （落在 body 子层则 fixed 头部会随页面滚走，实测否决）；
//   ② 反转的精确逆是 hue-rotate(-180deg) invert(1)（先逆色相再反转灰度，与正变换严格互逆，
//      逐像素还原），不是把同款滤镜再叠一遍——后者对饱和色有色相漂移；
//   ③ 播放器容器本来就是深色设计，整容器还原、容器内媒体不再叠加还原。
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
  /** 亮暗变化监听；返回退订函数（旧引擎无 addEventListener 时调用方给 null 兜）。 */
  subscribe: (listener: () => void) => () => void
}

export interface PageDarkRuntimeOptions {
  doc?: Document
  media?: PageDarkMedia
}

export function createPageDarkRuntime(options: PageDarkRuntimeOptions = {}): {
  start(): void
  stop(): void
} {
  const doc = options.doc ?? (typeof document !== 'undefined' ? document : null)
  const media = options.media ?? defaultMedia()
  if (doc === null || media === null) return { start(): void {}, stop(): void {} }

  let style: HTMLStyleElement | null = null
  let unsubscribe: (() => void) | null = null

  const apply = (): void => {
    if (media.matches()) {
      if (style === null || !style.isConnected) {
        style = doc.createElement('style')
        style.id = PAGE_DARK_STYLE_ID
        style.textContent = PAGE_DARK_CSS
        ;(doc.head ?? doc.documentElement).appendChild(style)
      }
      doc.documentElement.setAttribute('data-bh-page-dark', 'true')
    } else {
      revert()
    }
  }

  const revert = (): void => {
    style?.remove()
    style = null
    doc.documentElement.removeAttribute('data-bh-page-dark')
  }

  return {
    start() {
      apply()
      if (unsubscribe === null) unsubscribe = media.subscribe(apply)
    },
    stop() {
      if (unsubscribe !== null) {
        unsubscribe()
        unsubscribe = null
      }
      revert()
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
