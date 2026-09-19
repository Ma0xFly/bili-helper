// 首页视频筛选拦截器（Epic2-S2.4/S2.5，主世界运行）：
// 观察首页推荐接口响应（observe-only，不改响应体），按八维度规则判定，命中的卡片加 class 隐藏
// （display:none + 网格行距补偿，不留布局空洞）；目录 LRU 2000；滚动加载由 MutationObserver 重扫（节流 100ms）。
// 过严保护（S2.5）：某批「有普通视频且全被筛掉」连续 3 批 → 熔断——停止隐藏后续批次并插入
// 可读提示（页面无限拉新有账号风控风险，宁可放过）；熔断粘滞，配置变化重建时自动复位。
// dispose（配置变化/注销）：样式、body class、隐藏 class、提示节点全清理。

import type { NetworkInterceptor } from '../intercept/protocol'
import type { InterceptorFactoryRegistration } from '../intercept/runtime'
import type { VideoFilterConfig } from '../config'
import {
  extractBvid,
  filterReason,
  hasAnyCriteria,
  itemIsComplete,
  validateFilterConfig,
  type FeedItem,
} from './rules'

const FEED_API_URL = 'https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd'
const HIDDEN_CLASS = 'bili-helper-video-filter-hidden'
const BODY_CLASS = 'bili-helper-video-filter-active'
const STYLE_ID = 'bili-helper-video-filter-style'
const NOTICE_ID = 'bili-helper-video-filter-protection-notice'
const CARD_SELECTOR =
  '.recommended-container_floor-aside .container > .feed-card, .recommended-container_floor-aside .container > .bili-feed-card'
const CARD_LINK_SELECTOR = '.bili-video-card__image--link[href*="/video/"]'
const BV_IN_HREF = /BV[0-9A-Za-z]{10}/u

/** 目录上限：超出从最旧淘汰（防止长刷首页把 storage…这里是内存 Map，上限防内存膨胀）。 */
const CATALOG_LIMIT = 2000
/** 熔断阈值：连续 N 批「有普通视频且全被筛掉」。 */
export const PROTECTION_THRESHOLD = 3
/** 观察器重扫节流。 */
const RESCAN_THROTTLE_MS = 100

const NOTICE_TEXT =
  '视频筛选条件过严，已暂停过滤后续推荐，避免页面频繁加载。请在扩展设置中放宽条件。'

const HIDE_CSS = `
body.${BODY_CLASS} .${HIDDEN_CLASS} { display: none !important; }
body.${BODY_CLASS} .recommended-container_floor-aside .container > *:nth-of-type(n+6) { margin-top: 0 !important; }
#${NOTICE_ID} { position: fixed; top: 16px; right: 16px; z-index: 2147483000; max-width: 320px; padding: 10px 14px; background: #fff7d6; border: 1px solid #e6c94a; border-radius: 10px; font-size: 12.5px; line-height: 1.6; color: #6b5a10; box-shadow: 0 6px 20px rgba(0,0,0,.12); }
`

export interface FeedFilterDebug {
  config: VideoFilterConfig
  catalogSize: number
  hiddenSize: number
  protection: { tripped: boolean; consecutive: number }
}

/**
 * 构造视频筛选拦截器（主世界）。config 为空或校验失败 → 返回 null（零拦截）。
 * 导出工厂注册给 intercept.content.ts。
 */
export function createVideoFilterInterceptor(
  config: VideoFilterConfig,
  hooks: { getDocument?: () => Document } = {},
): NetworkInterceptor | null {
  if (!hasAnyCriteria(config) || validateFilterConfig(config).length > 0) return null
  const getDocument = hooks.getDocument ?? (() => document)
  const doc = getDocument()
  if (doc === null || doc.body === null) return null

  const catalog = new Map<string, FeedItem>()
  const hidden = new Map<string, { title: string; reason: string }>()
  let protectionConsecutive = 0
  let protectionTripped = false
  let styleElement: HTMLStyleElement | null = null
  let noticeElement: HTMLElement | null = null
  let observer: MutationObserver | null = null
  let rescanTimer: number | undefined

  const ensureStyle = (): void => {
    if (styleElement !== null) return
    styleElement = doc.createElement('style')
    styleElement.id = STYLE_ID
    styleElement.textContent = HIDE_CSS
    doc.head.append(styleElement)
    doc.body?.classList.add(BODY_CLASS)
  }

  const bvidOfCard = (card: Element): string | null => {
    const link = card.querySelector(CARD_LINK_SELECTOR)
    const href = link?.getAttribute('href')
    if (typeof href !== 'string') return null
    const match = href.match(BV_IN_HREF)
    return match !== null ? match[0] : null
  }

  const applyToDom = (): void => {
    let hiddenCount = 0
    for (const card of doc.querySelectorAll(CARD_SELECTOR)) {
      const bvid = bvidOfCard(card)
      if (bvid !== null && hidden.has(bvid)) {
        card.classList.add(HIDDEN_CLASS)
        hiddenCount += 1
      } else {
        card.classList.remove(HIDDEN_CLASS)
      }
    }
    if (hiddenCount > 0) ensureStyle()
    else doc.body?.classList.remove(BODY_CLASS)
  }

  const scheduleRescan = (): void => {
    if (rescanTimer !== undefined) return
    rescanTimer = window.setTimeout(() => {
      rescanTimer = undefined
      applyToDom()
    }, RESCAN_THROTTLE_MS)
  }

  const ensureObserver = (): void => {
    if (observer !== null) return
    observer = new MutationObserver((records) => {
      const relevant = records.some(
        (record) =>
          record.type === 'childList' ||
          (record.type === 'attributes' && record.attributeName === 'href'),
      )
      if (relevant) scheduleRescan()
    })
    observer.observe(doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href'],
    })
  }

  const showNotice = (): void => {
    if (noticeElement !== null) return
    noticeElement = doc.createElement('div')
    noticeElement.id = NOTICE_ID
    noticeElement.setAttribute('role', 'status')
    noticeElement.textContent = NOTICE_TEXT
    doc.body?.append(noticeElement)
  }

  const processBatch = (items: unknown): void => {
    if (!Array.isArray(items)) {
      console.warn('[BiliHelper:video-filter] feed response has no item array')
      return
    }
    let ordinary = 0
    let filtered = 0
    for (const raw of items) {
      if (typeof raw !== 'object' || raw === null) continue
      const item = raw as FeedItem
      const bvid = extractBvid(item)
      if (bvid === null) continue
      // 目录插入序 LRU：超限删最旧。
      catalog.delete(bvid)
      catalog.set(bvid, item)
      if (catalog.size > CATALOG_LIMIT) {
        const oldest = catalog.keys().next().value
        if (oldest !== undefined) {
          catalog.delete(oldest)
          hidden.delete(oldest)
        }
      }
      if (!itemIsComplete(item)) continue
      ordinary += 1
      const reason = filterReason(item, config)
      if (reason === null) continue
      if (protectionTripped) continue // 熔断后不再写入隐藏集（宁可放过）
      filtered += 1
      hidden.set(bvid, { title: typeof item.title === 'string' ? item.title : '', reason })
    }
    // 过严保护：批内「有普通视频且全被筛掉」计数。
    if (ordinary > 0 && filtered === ordinary) {
      protectionConsecutive += 1
      if (protectionConsecutive >= PROTECTION_THRESHOLD && !protectionTripped) {
        protectionTripped = true
        showNotice()
        console.warn('[BiliHelper:video-filter] protection tripped', { consecutive: protectionConsecutive })
      }
    } else {
      protectionConsecutive = 0
    }
    ensureObserver()
    applyToDom()
  }

  return {
    id: 'video-filter-homepage-feed',
    priority: 30,
    match: (url) => url === FEED_API_URL,
    afterResponse(event) {
      try {
        const data = event.responseJson as { data?: { item?: unknown } } | null
        processBatch(data?.data?.item)
      } catch (error) {
        console.error('[BiliHelper:video-filter] afterResponse failed:', String(error))
      }
    },
    dispose() {
      if (rescanTimer !== undefined) window.clearTimeout(rescanTimer)
      rescanTimer = undefined
      observer?.disconnect()
      observer = null
      noticeElement?.remove()
      noticeElement = null
      styleElement?.remove()
      styleElement = null
      doc.body?.classList.remove(BODY_CLASS)
      for (const card of doc.querySelectorAll(`.${HIDDEN_CLASS}`)) card.classList.remove(HIDDEN_CLASS)
      console.info('[BiliHelper:video-filter] disposed')
    },
  }
}

// 拦截器注册（主世界入口登记）：配置变化时 buildInterceptors 重建——空规则/校验失败返回 null（零拦截），
// dispose 由 InterceptRuntime 在替换时调用（样式/隐藏 class/提示全清理，熔断状态随重建复位）。
export const videoFilterInterceptorRegistration: InterceptorFactoryRegistration = {
  featureId: 'videoFilter',
  build: (entry) => createVideoFilterInterceptor(entry.config as unknown as VideoFilterConfig),
}
