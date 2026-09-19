// 右侧评论（Epic3-S3.4）：把 #commentapp 搬到播放器右栏 UP 主面板之后，评论区头部注入
// 折叠按钮；展开高度 = 视频区+发送栏+工具栏−40（下限 600）；评论是 Web Component，
// 样式注入需穿透各层级 shadowRoot；与左右分屏互斥（分屏激活时本功能自动停用）。
import { SPLIT_BODY_CLASS } from './split-screen'

const COMMENT_CLASS = 'bili-helper-side-comment'
const BODY_CLASS = 'bili-helper-side-comment-active'
const STYLE_ID = 'bili-helper-side-comment-style'
const TOGGLE_CLASS = 'bili-helper-side-comment-toggle'
const COLLAPSED_ATTR = 'data-bili-helper-comments-collapsed'

/** 需要穿透注入样式的影子宿主（B 站评论组件树）。 */
const SHADOW_HOSTS = [
  'bili-comments',
  'bili-comments-header-renderer',
  'bili-comment-thread-renderer',
  'bili-comment-renderer',
  'bili-comment-replies-renderer',
  'bili-comment-reply-renderer',
]

const COMMENT_CSS = `
body.${BODY_CLASS} #commentapp { height: var(--bili-helper-comment-height, 600px); max-height: var(--bili-helper-comment-height, 600px); overflow-y: auto; }
body.${BODY_CLASS} #commentapp[${COLLAPSED_ATTR}='true'] { height: auto !important; max-height: none !important; overflow: visible !important; }
.${TOGGLE_CLASS} { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid #e3def0; border-radius: 8px; background: #fff; cursor: pointer; color: #4c4661; }
.${TOGGLE_CLASS} svg { transition: transform 180ms ease; }
.${TOGGLE_CLASS}[aria-expanded='false'] svg { transform: rotate(90deg); }
`

export function computeCommentHeight(doc: Document): number {
  const videoArea =
    doc.querySelector('.bpx-player-video-area') ??
    doc.querySelector('.video-container-v1') ??
    doc.querySelector('#bilibili-player')
  const sendingBar = doc.querySelector('.bpx-player-sending-bar, .player-sending-bar')
  const toolbar = doc.querySelector('.video-toolbar-container, #arc_toolbar_report')
  const sum =
    (videoArea?.getBoundingClientRect().height ?? 0) +
    (sendingBar?.getBoundingClientRect().height ?? 0) +
    (toolbar?.getBoundingClientRect().height ?? 0)
  const height = Math.round(sum - 40)
  return height < 300 ? 600 : height
}

export function createRightSideCommentRuntime(options: { doc?: Document } = {}): {
  start(): void
  stop(): void
} {
  const doc = options.doc ?? (typeof document !== 'undefined' ? document : null)
  if (doc === null) return { start(): void {}, stop(): void {} }

  let anchor: Comment | null = null
  let commentNode: HTMLElement | null = null
  let toggle: HTMLButtonElement | null = null
  let style: HTMLStyleElement | null = null
  let shadowStyles: HTMLStyleElement[] = []
  let resizeListener: (() => void) | null = null
  let resizeObserver: ResizeObserver | null = null
  let splitWatcher: number | undefined

  const applyHeight = (): void => {
    doc.documentElement.style.setProperty('--bili-helper-comment-height', `${computeCommentHeight(doc)}px`)
  }

  const injectShadowStyles = (): void => {
    for (const hostSelector of SHADOW_HOSTS) {
      for (const host of [...doc.querySelectorAll(hostSelector)]) {
        const root = (host as HTMLElement).shadowRoot
        if (root === null) continue
        if (root.querySelector(`#${STYLE_ID}`) !== null) continue
        const el = doc.createElement('style')
        el.id = STYLE_ID
        // 评论各层影子根里的排版微调：限宽与滚动，避免搬进右栏后溢出。
        el.textContent = `:host { max-width: 100%; } #contents { overflow: visible; }`
        root.append(el)
        shadowStyles.push(el)
      }
    }
  }

  const restore = (): void => {
    if (toggle !== null) {
      toggle.remove()
      toggle = null
    }
    if (commentNode !== null && anchor !== null && anchor.parentNode !== null) {
      anchor.parentNode.insertBefore(commentNode, anchor)
    }
    anchor?.remove()
    anchor = null
    commentNode?.classList.remove(COMMENT_CLASS)
    commentNode?.removeAttribute(COLLAPSED_ATTR)
    commentNode = null
    doc.documentElement.style.removeProperty('--bili-helper-comment-height')
    doc.body.classList.remove(BODY_CLASS)
    style?.remove()
    style = null
    for (const el of shadowStyles) el.remove()
    shadowStyles = []
  }

  return {
    start(): void {
      console.info('[bili-helper:right-side-comment] started')
      const mount = (): void => {
        // 分屏激活时不争抢右栏（自动让位；分屏关闭后下一个节拍再挂）。
        if (doc.body.classList.contains(SPLIT_BODY_CLASS)) return
        const target =
          doc.querySelector('.right-container-inner .up-panel-container') ??
          doc.querySelector('.playlist-container--right .up-panel-container') ??
          doc.querySelector('.up-panel-container')
        const comment = doc.querySelector<HTMLElement>('#commentapp')
        if (target === null || comment === null || commentNode === comment) return
        anchor = doc.createComment('bili-helper-comment-anchor')
        comment.before(anchor)
        commentNode = comment
        comment.classList.add(COMMENT_CLASS)
        target.after(comment)
        doc.body.classList.add(BODY_CLASS)
        if (style === null) {
          style = doc.createElement('style')
          style.id = STYLE_ID
          style.textContent = COMMENT_CSS
          doc.head.append(style)
        }
        // 折叠按钮：评论区头（影子根内 #header）找得到就挂，找不到挂在评论区前。
        const header = (comment.querySelector('bili-comments') as HTMLElement | null)?.shadowRoot?.querySelector('#header')
        const host = (header as HTMLElement) ?? comment
        toggle = doc.createElement('button')
        toggle.type = 'button'
        toggle.className = TOGGLE_CLASS
        toggle.title = '折叠评论'
        toggle.setAttribute('aria-label', '折叠评论')
        toggle.setAttribute('aria-expanded', 'true')
        toggle.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>'
        toggle.addEventListener('click', () => {
          const collapsed = comment.getAttribute(COLLAPSED_ATTR) === 'true'
          if (collapsed) {
            comment.removeAttribute(COLLAPSED_ATTR)
            toggle?.setAttribute('aria-expanded', 'true')
            if (toggle !== null) toggle.title = '折叠评论'
            applyHeight()
          } else {
            comment.setAttribute(COLLAPSED_ATTR, 'true')
            toggle?.setAttribute('aria-expanded', 'false')
            if (toggle !== null) toggle.title = '展开评论'
          }
        })
        host.prepend(toggle)
        injectShadowStyles()
        applyHeight()
      }
      mount()
      resizeListener = () => applyHeight()
      window.addEventListener('resize', resizeListener)
      const player = doc.querySelector('#bilibili-player, .bpx-player-video-area')
      if (typeof ResizeObserver !== 'undefined' && player !== null) {
        resizeObserver = new ResizeObserver(() => applyHeight())
        resizeObserver.observe(player)
      }
      // 分屏互斥轮询：分屏激活时还原，撤销后重挂。
      splitWatcher = window.setInterval(() => {
        if (doc.body.classList.contains(SPLIT_BODY_CLASS)) {
          if (commentNode !== null) restore()
        } else if (commentNode === null) {
          mount()
        }
      }, 1000)
    },
    stop(): void {
      if (splitWatcher !== undefined) window.clearInterval(splitWatcher)
      splitWatcher = undefined
      resizeListener && window.removeEventListener('resize', resizeListener)
      resizeListener = null
      resizeObserver?.disconnect()
      resizeObserver = null
      restore()
      console.info('[bili-helper:right-side-comment] stopped')
    },
  }
}
