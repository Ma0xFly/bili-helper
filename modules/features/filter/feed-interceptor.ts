// 视频筛选拦截器（主世界运行）：观察推荐/热门/搜索三个 feed 接口的响应（observe-only，
// 不改响应体），按八维度规则判定，命中的卡片加 class 隐藏。目录 LRU 2000；滚动加载由
// MutationObserver 重扫（节流 100ms）。过严保护：某批「有普通视频且全被筛掉」连续 3 批 →
// 熔断——停止隐藏后续批次并插入可读提示（页面无限拉新有账号风控风险，宁可放过）；
// 熔断粘滞，配置变化重建时自动复位。dispose（配置变化/注销）：样式、body class、
// 隐藏 class、提示节点全清理。
//
// 三个数据源的形状差异在 sources 里各自归一（热门补 goto，搜索剥 <em>、换算时长），
// processBatch 与规则引擎只面对归一后的 FeedItem。拦截明细经 postMessage 回传隔离侧
//（主世界没有 chrome.storage），隔离侧落 storage 供设置页展示。

import type { NetworkInterceptor } from '../intercept/protocol'
import type { InterceptorFactoryRegistration } from '../intercept/runtime'
import { pushFilterLogEvent } from '../intercept/protocol'
import { classifySurface, type PageSurface } from '../surface'
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

// 各注入面的卡片定位（2026-09 真机踏勘）：
//   首页：.feed-card/.bili-feed-card 槽位（沿用旧产物口径，含网格 margin 补偿）；
//   热门：ul.card-list 里的 .video-card（数据来自 /x/web-interface/popular）；
//   搜索：.video-list 网格里的 .bili-video-card，隐藏目标上溯到 .col_3 单元格整格收起。
interface SurfaceDom {
  cardSelector: string
  /** 命中卡片的隐藏目标：先上溯到该祖先（网格单元格），找不到退回卡片本身。 */
  hideAncestor?: string
  /** 卡片内 BV 链接定位（默认任意 /video/BV 链接）。 */
  linkSelector?: string
}

const SURFACE_DOM: Partial<Record<PageSurface, SurfaceDom>> = {
  home: { cardSelector: CARD_SELECTOR, linkSelector: CARD_LINK_SELECTOR },
  popular: { cardSelector: '.card-list .video-card' },
  search: { cardSelector: '.video-list .bili-video-card', hideAncestor: '.col_3' },
}

/** 目录上限：超出从最旧淘汰（长刷页面防内存膨胀）。 */
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

// ---------- 数据源：URL 判定 + 响应形状归一 ----------

type FeedSurface = 'home' | 'popular' | 'search'

interface FeedSourceDef {
  surface: FeedSurface
  match(url: string): boolean
  /** 响应 JSON → 归一后的候选条目（形状坏的响应返回空数组）。 */
  extractItems(json: unknown): FeedItem[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 热门条目（archive 全量形状，无 goto 字段）→ FeedItem。 */
export function normalizePopularItem(raw: unknown): FeedItem {
  if (!isRecord(raw)) return {}
  const owner = isRecord(raw.owner) ? raw.owner : {}
  const stat = isRecord(raw.stat) ? raw.stat : {}
  return {
    bvid: typeof raw.bvid === 'string' ? raw.bvid : undefined,
    title: typeof raw.title === 'string' ? raw.title : undefined,
    owner: { mid: owner.mid, name: owner.name },
    stat: { danmaku: stat.danmaku, like: stat.like, view: stat.view },
    duration: raw.duration,
    pubdate: raw.pubdate,
    goto: 'av',
  }
}

/** 「mm:ss / h:mm:ss」时长串 → 秒；非法返回 undefined。 */
export function parseColonDuration(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parts = value.trim().split(':')
  if (parts.length < 2 || parts.length > 3) return undefined
  let seconds = 0
  for (const part of parts) {
    if (!/^\d{1,5}$/.test(part)) return undefined
    seconds = seconds * 60 + Number(part)
  }
  return seconds
}

/** 搜索条目（扁平形状：author/play/video_review、时长串、标题带 <em> 高亮）→ FeedItem。 */
export function normalizeSearchItem(raw: unknown): FeedItem {
  if (!isRecord(raw)) return {}
  const title = typeof raw.title === 'string' ? raw.title.replace(/<[^>]+>/g, '') : undefined
  const bvid =
    typeof raw.bvid === 'string'
      ? raw.bvid
      : typeof raw.arcurl === 'string'
        ? (raw.arcurl.match(BV_IN_HREF)?.[0] ?? undefined)
        : undefined
  return {
    bvid,
    title,
    owner: { mid: raw.mid, name: raw.author },
    stat: { view: raw.play, danmaku: raw.video_review, like: raw.like },
    duration: parseColonDuration(raw.duration) ?? (typeof raw.duration === 'number' ? raw.duration : undefined),
    pubdate: raw.pubdate,
    goto: 'av',
  }
}

const HOME_SOURCE: FeedSourceDef = {
  surface: 'home',
  match: (url) => url === FEED_API_URL,
  extractItems(json) {
    const data = isRecord(json) && isRecord(json.data) ? json.data : {}
    return Array.isArray(data.item) ? (data.item as FeedItem[]) : []
  },
}

const POPULAR_SOURCE: FeedSourceDef = {
  surface: 'popular',
  match: (url) =>
    url.startsWith('https://api.bilibili.com/x/web-interface/popular') ||
    url.startsWith('https://api.bilibili.com/x/web-interface/wbi/popular'),
  extractItems(json) {
    const data = isRecord(json) && isRecord(json.data) ? json.data : {}
    return Array.isArray(data.list) ? data.list.map(normalizePopularItem) : []
  },
}

const SEARCH_SOURCE: FeedSourceDef = {
  surface: 'search',
  // search/type 是现行通道（扁平数组）；all/v2 是分块形态，一并兼容防 B 门切换。
  match: (url) =>
    url.startsWith('https://api.bilibili.com/x/web-interface/wbi/search/type') ||
    url.startsWith('https://api.bilibili.com/x/web-interface/search/type') ||
    url.startsWith('https://api.bilibili.com/x/web-interface/wbi/search/all/v2') ||
    url.startsWith('https://api.bilibili.com/x/web-interface/search/all/v2'),
  extractItems(json) {
    const data = isRecord(json) && isRecord(json.data) ? json.data : {}
    if (Array.isArray(data.result)) {
      // all/v2：[{result_type:'video', data:[...]}] 只取 video 块；search/type：扁平数组直接归一。
      const flat = data.result.filter((item) => isRecord(item))
      const hasBlocks = flat.some((item) => Array.isArray((item as Record<string, unknown>).data))
      if (hasBlocks) {
        return flat.flatMap((block) => {
          const record = block as Record<string, unknown>
          return record.result_type === 'video' && Array.isArray(record.data)
            ? record.data.map(normalizeSearchItem)
            : []
        })
      }
      return flat.map(normalizeSearchItem)
    }
    return []
  },
}

const SOURCES: FeedSourceDef[] = [HOME_SOURCE, POPULAR_SOURCE, SEARCH_SOURCE]

export interface FeedFilterDebug {
  config: VideoFilterConfig
  catalogSize: number
  hiddenSize: number
  protection: { tripped: boolean; consecutive: number }
}

/**
 * 构造视频筛选拦截器（主世界）。config 为空或校验失败 → 返回 null（零拦截）。
 * hooks.getSurface：注入面判定注入（默认按 location.href；测试注入）。
 * 导出工厂注册给 intercept.content.ts。
 */
export function createVideoFilterInterceptor(
  config: VideoFilterConfig,
  hooks: { getDocument?: () => Document; getSurface?: () => PageSurface } = {},
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

  const currentDom = (): SurfaceDom | null => {
    const surface = (hooks.getSurface ?? (() => classifySurface(location.href)))()
    return SURFACE_DOM[surface] ?? null
  }

  const bvidOfCard = (card: Element, dom: SurfaceDom): string | null => {
    const link = card.querySelector(dom.linkSelector ?? 'a[href*="/video/BV"]')
    const href = link?.getAttribute('href')
    if (typeof href !== 'string') return null
    const match = href.match(BV_IN_HREF)
    return match !== null ? match[0] : null
  }

  const hideTargetOf = (card: Element, dom: SurfaceDom): Element => {
    if (dom.hideAncestor === undefined) return card
    return card.closest(dom.hideAncestor) ?? card
  }

  const applyToDom = (): void => {
    const dom = currentDom()
    if (dom === null) return
    let hiddenCount = 0
    for (const card of doc.querySelectorAll(dom.cardSelector)) {
      const bvid = bvidOfCard(card, dom)
      const target = hideTargetOf(card, dom)
      if (bvid !== null && hidden.has(bvid)) {
        target.classList.add(HIDDEN_CLASS)
        hiddenCount += 1
      } else {
        target.classList.remove(HIDDEN_CLASS)
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

  const processBatch = (items: FeedItem[], surface: FeedSurface): void => {
    let ordinary = 0
    let filtered = 0
    for (const item of items) {
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
      const title = typeof item.title === 'string' ? item.title : ''
      hidden.set(bvid, { title, reason })
      // 拦截明细回传隔离侧落库（主世界没有 chrome.storage）；页面脚本伪造的后果
      // 与配置广播同评价：只是日志展示，不涉及任何凭据。
      pushFilterLogEvent(window, { bvid, title, reason, surface })
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
    id: 'video-filter-feed',
    priority: 30,
    match: (url) => SOURCES.some((source) => source.match(url)),
    afterResponse(event) {
      try {
        const source = SOURCES.find((candidate) => candidate.match(event.url))
        if (!source) return
        processBatch(source.extractItems(event.responseJson), source.surface)
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
      for (const target of doc.querySelectorAll(`.${HIDDEN_CLASS}`)) target.classList.remove(HIDDEN_CLASS)
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
