// 换一换历史（Epic4-S4.3/S4.4，主世界）：记录首页「换一换」批次，面板支持后退/前进与页码。
// 捕获双路：① 点「换一换」前（pointerdown 捕获）快照当前卡片 DOM；② 拦截 fresh_type=3 的
// 推荐接口响应存 JSON。回放：DOM 型直接回填 innerHTML；response 型伪造点击让 B 站发请求、
// 短路器用缓存响应顶替（不发真实网络）。上限 30 批 + 后退后再换新截断后续（修旧版缺陷）。
// 面板挂在「换一换」按钮之后，URL 轮询 1.5s 决定显隐（仅首页），按钮被重渲染自动重建。

import type { NetworkInterceptor } from '../intercept/protocol'
import type { InterceptorFactoryRegistration } from '../intercept/runtime'

const FEED_URL_PREFIX = 'https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd'
const PANEL_ID = 'bili-helper-homepage-refresh-history'
const ROLL_SELECTOR = '.feed-roll-btn, .roll-btn'
const CARD_SELECTOR = '.feed-card, .bili-feed-card'
export const HISTORY_CAP = 30
const REPLAY_TIMEOUT_MS = 5000
const NAV_CHECK_MS = 1500

type HistoryEntry =
  | { type: 'dom'; cards: string[] }
  | { type: 'response'; responseJson: unknown }

export function createRefreshHistoryRuntime(
  getDocument: () => Document,
  getHref: () => string,
): NetworkInterceptor & { startUi(): void; stopUi(): void } {
  const doc = getDocument()
  const history: HistoryEntry[] = []
  let index = -1
  let navigating = false
  let pendingReplay: unknown = null
  let panel: HTMLElement | null = null
  let navTimer: number | undefined
  let pointerHandler: ((event: Event) => void) | null = null

  const feedCards = (): HTMLElement[] =>
    [...doc.querySelectorAll(CARD_SELECTOR)] as HTMLElement[]

  const snapshotDom = (): { type: 'dom'; cards: string[] } => ({
    type: 'dom',
    cards: feedCards().map((card) => card.innerHTML),
  })

  const pushEntry = (entry: HistoryEntry): void => {
    // 后退后又换新：当前位置之后的记录作废（旧版会残留不可达记录，页码分母虚涨）。
    if (index < history.length - 1) history.splice(index + 1)
    history.push(entry)
    if (history.length > HISTORY_CAP) history.splice(0, history.length - HISTORY_CAP)
    index = history.length - 1
    updatePanel()
  }

  const restoreDom = (entry: { type: 'dom'; cards: string[] }): void => {
    const cards = feedCards()
    cards.forEach((card, position) => {
      const html = entry.cards[position]
      if (html !== undefined) {
        card.innerHTML = html
        card.classList.remove('bili-helper-history-dom-card-hidden')
      } else {
        card.classList.add('bili-helper-history-dom-card-hidden')
      }
    })
  }

  const replayTo = (target: number): void => {
    if (navigating || target < 0 || target >= history.length || target === index) return
    const entry = history[target]
    if (entry === undefined) return
    navigating = true
    const rollback = index
    const finishTimer = window.setTimeout(() => {
      if (navigating) {
        index = rollback
        navigating = false
        updatePanel()
        console.warn('[bili-helper:refresh-history] 回放超时，页码回滚')
      }
    }, REPLAY_TIMEOUT_MS)
    try {
      if (entry.type === 'dom') {
        restoreDom(entry)
        index = target
      } else {
        // response 型：伪造点击触发 B 站请求，短路器返回缓存。
        pendingReplay = entry.responseJson
        const button = doc.querySelector(ROLL_SELECTOR) as HTMLElement | null
        if (button === null) throw new Error('换一换按钮不在')
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          button.dispatchEvent(new Event(type, { bubbles: true }))
        }
        index = target
      }
    } catch (error) {
      index = rollback
      console.error('[bili-helper:refresh-history] 回放失败:', String(error))
    } finally {
      window.clearTimeout(finishTimer)
      navigating = false
      updatePanel()
    }
  }

  const updatePanel = (): void => {
    const indicator = panel?.querySelector('.bili-helper-history-indicator')
    if (indicator !== null && indicator !== undefined) {
      indicator.textContent = history.length === 0 ? '0/0' : `${index + 1}/${history.length}`
    }
    panel?.querySelectorAll('button').forEach((button) => {
      const delta = Number((button as HTMLElement).dataset.delta)
      const disabled = history.length === 0 || navigating || index + delta < 0 || index + delta >= history.length
      ;(button as HTMLButtonElement).disabled = disabled
    })
  }

  const buildPanel = (): void => {
    const button = doc.querySelector(ROLL_SELECTOR)
    if (button === null) return
    if (panel?.isConnected === true && panel.previousElementSibling === button) return
    panel?.remove()
    panel = doc.createElement('div')
    panel.id = PANEL_ID
    panel.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-left:8px;width:40px;align-items:center;'
    const up = doc.createElement('button')
    up.type = 'button'
    up.dataset.delta = '-1'
    up.title = '查看上一次推荐'
    up.setAttribute('aria-label', '查看上一次推荐')
    up.textContent = '↑'
    const indicator = doc.createElement('span')
    indicator.className = 'bili-helper-history-indicator'
    indicator.style.cssText = 'font-size:11px;color:#9b95ad;'
    const down = doc.createElement('button')
    down.type = 'button'
    down.dataset.delta = '1'
    down.title = '查看下一次推荐'
    down.setAttribute('aria-label', '查看下一次推荐')
    down.textContent = '↓'
    for (const item of [up, down]) {
      item.style.cssText = 'border:1px solid #e3def0;background:#fff;border-radius:6px;cursor:pointer;font-size:12px;padding:2px 8px;'
      item.addEventListener('click', () => replayTo(index + Number(item.dataset.delta)))
    }
    panel.append(up, indicator, down)
    button.after(panel)
    updatePanel()
  }

  return {
    id: 'homepage-refresh-history',
    priority: 20,
    match: (url) => url.startsWith(FEED_URL_PREFIX) && url.includes('fresh_type=3'),
    afterResponse(event) {
      try {
        if (pendingReplay !== null) return // 回放期间的响应不入史
        pushEntry({ type: 'response', responseJson: event.responseJson })
      } catch (error) {
        console.error('[bili-helper:refresh-history] 记录批次失败:', String(error))
      }
    },
    shortCircuit() {
      if (pendingReplay === null) return null
      const cached = pendingReplay
      pendingReplay = null
      return { status: 200, responseJson: cached }
    },
    startUi(): void {
      pointerHandler = () => {
        // 回放期间伪造的 pointerdown 不入史（否则自己给自己压栈，页码错乱）。
        if (navigating) return
        // 点「换一换」前快照当前批（栈空或栈首非 DOM 型才压——栈首 DOM 即当前批，不重复）。
        const top = history[index]
        if (top === undefined || top.type !== 'dom') pushEntry(snapshotDom())
      }
      doc.addEventListener('pointerdown', pointerHandler, true)
      navTimer = window.setInterval(() => {
        const href = getHref()
        const isHome = /https:\/\/www\.bilibili\.com\/(?:index\.html)?(?:[?#].*)?$/u.test(href)
        if (!isHome) {
          panel?.remove()
          panel = null
          return
        }
        buildPanel()
      }, NAV_CHECK_MS)
    },
    stopUi(): void {
      if (navTimer !== undefined) window.clearInterval(navTimer)
      navTimer = undefined
      if (pointerHandler !== null) doc.removeEventListener('pointerdown', pointerHandler, true)
      pointerHandler = null
      panel?.remove()
      panel = null
    },
  }
}

/** 注册：开关开 → 拦截器 + 面板一起装配；dispose（配置变化重建）卸面板与监听。 */
export const refreshHistoryRegistration: InterceptorFactoryRegistration = {
  featureId: 'homepageRefreshHistory',
  build: () => {
    if (typeof document === 'undefined') return null
    const runtime = createRefreshHistoryRuntime(() => document, () => location.href)
    runtime.startUi()
    return {
      id: runtime.id,
      priority: runtime.priority,
      match: runtime.match,
      afterResponse: runtime.afterResponse,
      shortCircuit: runtime.shortCircuit,
      dispose: () => runtime.stopUi(),
    }
  },
}
