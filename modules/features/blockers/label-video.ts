// 标签视频隐藏（Epic2-S2.3）：纯 CSS 隐藏首页的非普通视频卡片——
//   ① PGC「floor」卡片（番剧/综艺/课堂/影视等楼层卡）；
//   ② 直播卡片：内嵌直播卡（.bili-live-card）的推荐卡用 :has() 连带整卡隐藏，不留半截。
// 不移动不删除节点（与两个 DOM 拦截器的区别）：body class + 样式两件套，stop 全移除即原样。

const STYLE_ID = 'bili-helper-label-video-blocker-style'
const BODY_CLASS = 'bili-helper-label-video-blocker'

/** 隐藏规则（body class 前缀，避免误伤其它页面结构）。 */
export const LABEL_HIDE_RULES: readonly string[] = [
  `body.${BODY_CLASS} .floor-single-card { display: none !important; }`,
  `body.${BODY_CLASS} .bili-feed-card:has(.bili-live-card) { display: none !important; }`,
]

export function createLabelVideoBlocker(options: { doc?: Document } = {}): {
  start(): void
  stop(): void
} {
  const doc = options.doc ?? (typeof document !== 'undefined' ? document : null)
  if (doc === null || doc.body === null) {
    return { start(): void {}, stop(): void {} }
  }
  let style: HTMLStyleElement | null = null
  return {
    start(): void {
      if (style !== null) return
      style = doc.createElement('style')
      style.id = STYLE_ID
      style.textContent = LABEL_HIDE_RULES.join('\n')
      doc.head.append(style)
      doc.body.classList.add(BODY_CLASS)
      console.info('[bili-helper:label-video-blocker] started')
    },
    stop(): void {
      // 样式与 class 全移除（不留死样式）；节点本就没动过，页面即回原样。
      style?.remove()
      style = null
      doc.body?.classList.remove(BODY_CLASS)
      console.info('[bili-helper:label-video-blocker] stopped')
    },
  }
}
