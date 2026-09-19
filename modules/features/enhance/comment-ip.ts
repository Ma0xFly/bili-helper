// 评论 IP 属地（Epic4-S4.5，主世界）：观察评论接口（/x/v2/reply/wbi/main 与 /x/v2/reply/reply）
// 收集 mid→属地（去「IP属地：」前缀），在评论组件（多层 Shadow DOM）的用户名元素内追加小标签；
// 数据缺失不显示占位（已插入的移除）；换视频（oid 变化）清空重注。

import type { InterceptorFactoryRegistration } from '../intercept/runtime'

const NAME_SELECTOR = '#user-name[data-user-profile-id]'
const LABEL_ATTR = 'data-bili-helper-comment-ip-location'
const MAIN_URL = 'https://api.bilibili.com/x/v2/reply/wbi/main'
const REPLY_URL = 'https://api.bilibili.com/x/v2/reply/reply'
const SCAN_DEBOUNCE_MS = 200

/** 从 reply.control.location 提取属地（B 站原值形如「IP属地：上海」）。 */
export function cleanLocation(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/^IP\s*属地\s*[:：]\s*/u, '').trim()
}

/** 递归收集 replies/top_replies/top.{admin,upper,vote} 的 mid→属地。 */
export function collectLocations(data: unknown): Map<string, string> {
  const map = new Map<string, string>()
  const visit = (reply: unknown): void => {
    if (typeof reply !== 'object' || reply === null) return
    const record = reply as {
      mid?: unknown
      mid_str?: unknown
      member?: { mid?: unknown }
      reply_control?: { location?: unknown }
    }
    const mid = typeof record.mid_str === 'string' ? record.mid_str : String(record.mid ?? record.member?.mid ?? '')
    const location = cleanLocation(record.reply_control?.location)
    if (mid !== '' && location !== '') map.set(mid, location)
  }
  const root = typeof data === 'object' && data !== null ? (data as { data?: Record<string, unknown> }).data : null
  if (root == null) return map
  for (const reply of Array.isArray(root.replies) ? root.replies : []) visit(reply)
  for (const reply of Array.isArray(root.top_replies) ? root.top_replies : []) visit(reply)
  const top = root.top
  if (typeof top === 'object' && top !== null) {
    for (const key of ['admin', 'upper', 'vote']) {
      const entry = (top as Record<string, unknown>)[key]
      if (entry !== null && typeof entry === 'object') visit((entry as { topic?: unknown; mid?: unknown }) ?? entry)
    }
  }
  return map
}

export function createCommentIpRuntime(getDocument: () => Document): {
  start(): void
  interceptor: {
    id: string
    priority: number
    match(url: string): boolean
    afterResponse(event: { url: string; responseJson: unknown }): void
    dispose(): void
  }
  sync(): void
  stop(): void
} {
  const doc = getDocument()
  const locations = new Map<string, string>()
  let currentOid: string | null = null
  let observer: MutationObserver | null = null
  let hrefWatcher: number | undefined
  let lastHref = ''
  let syncTimer: number | undefined

  /** 深度找用户名元素（穿透 shadowRoot）。 */
  const findNameElements = (): HTMLElement[] => {
    const out: HTMLElement[] = []
    const walk = (parent: ParentNode): void => {
      for (const el of parent.querySelectorAll(NAME_SELECTOR)) out.push(el as HTMLElement)
      for (const el of parent.querySelectorAll('*')) {
        if ((el as HTMLElement).shadowRoot !== null) walk((el as HTMLElement).shadowRoot as ShadowRoot)
      }
    }
    walk(doc)
    return out
  }

  const sync = (): void => {
    for (const name of findNameElements()) {
      const mid = name.getAttribute('data-user-profile-id') ?? ''
      const location = locations.get(mid)
      const existing = name.querySelector(`[${LABEL_ATTR}]`)
      if (location === undefined) {
        existing?.remove() // 无数据不留占位
        continue
      }
      if (existing !== null) {
        if (existing.textContent !== location) existing.textContent = location
        continue
      }
      const label = doc.createElement('span')
      label.setAttribute(LABEL_ATTR, 'true')
      label.textContent = location
      label.style.cssText =
        'display:inline;margin-left:6px;color:#9499a0;font-size:12px;border:1px solid #d8d8d8;border-radius:2px;padding:0 2px;white-space:nowrap;'
      name.append(label)
    }
  }

  const scheduleSync = (): void => {
    if (syncTimer !== undefined) return
    syncTimer = window.setTimeout(() => {
      syncTimer = undefined
      sync()
    }, SCAN_DEBOUNCE_MS)
  }

  /** 观察器装配：评论懒加载/翻页触发补标签；SPA 换页清映射。 */
  const start = (): void => {
    observer = new MutationObserver(() => scheduleSync())
    observer.observe(doc, { childList: true, subtree: true })
    lastHref = location.href
    hrefWatcher = window.setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href
        locations.clear()
        currentOid = null
        doc.querySelectorAll(`[${LABEL_ATTR}]`).forEach((el) => el.remove())
      }
    }, 1500)
  }

  return {
    start,
    interceptor: {
      id: 'comment-ip-location-replies',
      priority: 20,
      match: (url) => url.startsWith(MAIN_URL) || url.startsWith(REPLY_URL),
      afterResponse(event) {
        try {
          const data = event.responseJson as { data?: { oid?: unknown } } | null
          const oid = data?.data?.oid
          const oidKey = oid === undefined ? null : String(oid)
          if (currentOid !== null && oidKey !== null && oidKey !== currentOid) {
            locations.clear() // 换视频：旧映射与标签作废
            doc.querySelectorAll(`[${LABEL_ATTR}]`).forEach((el) => el.remove())
          }
          if (oidKey !== null) currentOid = oidKey
          const collected = collectLocations(event.responseJson)
          for (const [mid, location] of collected) locations.set(mid, location)
          scheduleSync()
        } catch (error) {
          console.error('[bili-helper:comment-ip-location] 数据收集失败:', String(error))
        }
      },
      dispose() {
        doc.querySelectorAll(`[${LABEL_ATTR}]`).forEach((el) => el.remove())
      },
    },
    sync,
    stop(): void {
      if (syncTimer !== undefined) window.clearTimeout(syncTimer)
      syncTimer = undefined
      if (hrefWatcher !== undefined) window.clearInterval(hrefWatcher)
      hrefWatcher = undefined
      observer?.disconnect()
      observer = null
      doc.querySelectorAll(`[${LABEL_ATTR}]`).forEach((el) => el.remove())
    },
  }
}

/** 注册：开关开 → 拦截器 + 评论 DOM 观察器（懒加载/翻页补标签）+ SPA 换页清理。 */
export const commentIpRegistration: InterceptorFactoryRegistration = {
  featureId: 'commentIpLocation',
  build: () => {
    if (typeof document === 'undefined') return null
    const runtime = createCommentIpRuntime(() => document)
    runtime.start()
    runtime.interceptor.dispose = () => runtime.stop()
    return runtime.interceptor
  },
}
