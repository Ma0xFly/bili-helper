// 真实采集实现：视频元数据（页面状态优先、x/web-interface/view 兜底）、
// 字幕（player 字幕列表 → JSON 拉取）、弹幕（comment.bilibili.com/{cid}.xml）、
// 评论（wbi 签名 top 评论）。只从 B 站自有端点/页面状态取数；
// 每个 provider 独立 try/catch：任一失败→空数组继续，绝不让单个数据源拖垮整条链路。
// 时间一律归一到「秒（number）」。

import type { Comment, Danmaku, Subtitle, VideoMeta } from './types'
import { fetchJsonWithWbi } from './wbi'

/** 单个采集请求的超时（毫秒）：页面状态拿不到时不能让链路无限悬挂。 */
const FETCH_TIMEOUT_MS = 15_000

interface BiliSubtitleListItem {
  id?: number
  lan?: string
  subtitle_url?: string
}

interface BiliPageVideoData {
  bvid?: string
  aid?: number
  cid?: number
  title?: string
  duration?: number
  subtitle?: { list?: BiliSubtitleListItem[] }
}

interface BiliInitialState {
  videoData?: BiliPageVideoData
}

function pageState(): BiliInitialState | undefined {
  if (typeof window === 'undefined') return undefined
  const state = (window as unknown as { __INITIAL_STATE__?: BiliInitialState }).__INITIAL_STATE__
  return state && typeof state === 'object' ? state : undefined
}

function videoData(): BiliPageVideoData | undefined {
  const state = pageState()?.videoData
  return state && typeof state === 'object' ? state : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

async function fetchBiliJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { credentials: 'include', signal })
  if (!response.ok) throw new Error(`请求失败：${response.status}`)
  return await response.json()
}

/** 给采集请求拼一个超时死线；fetch 本身没有全局超时约定。 */
function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
    : undefined
}

// ---------- 视频元数据 ----------

/** 页面状态里取一条视频数据（cid/标题/时长优先走这里，零网络成本）。 */
function metaFromPageState(bvid: string): VideoMeta | null {
  const data = videoData()
  if (!data) return null
  return {
    bvid,
    cid: asPositiveNumber(data.cid),
    title: typeof data.title === 'string' ? data.title : '',
    duration: typeof data.duration === 'number' && data.duration > 0 ? data.duration : 0,
  }
}

/** view 接口兜底：数据码/标题/时长；任何失败（网络/形状/未登录态）都返回 null。 */
async function metaFromViewApi(bvid: string): Promise<VideoMeta | null> {
  try {
    const data = await fetchBiliJson(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
      timeoutSignal(),
    )
    if (!isRecord(data) || !isRecord(data.data)) return null
    const view = data.data
    return {
      bvid,
      cid: asPositiveNumber(view.cid),
      title: typeof view.title === 'string' ? view.title : '',
      duration: typeof view.duration === 'number' && view.duration > 0 ? view.duration : 0,
    }
  } catch {
    // 兜底失败降级为基线元数据，采集层绝不抛错。
    return null
  }
}

function resolveHref(source?: string | { url?: string; href?: string } | URL): string {
  if (source == null) return typeof location === 'undefined' ? '' : location.href
  if (typeof source === 'string') return source
  if (source instanceof URL) return source.href
  return source.url ?? source.href ?? ''
}

function isBilibiliHost(hostname: string): boolean {
  return hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com')
}

export function extractBvidFromUrl(source?: string | { url?: string; href?: string } | URL): string | null {
  const href = resolveHref(source)
  if (!href) return null
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (!isBilibiliHost(url.hostname)) return null
  const match = url.pathname.match(/^\/video\/([^/?#]+)/)
  if (!match || !match[1]) return null
  return match[1]
}

export async function collectVideoMeta(
  source?: string | { url?: string; href?: string } | URL,
): Promise<VideoMeta | null> {
  const bvid = extractBvidFromUrl(source)
  if (!bvid) return null
  const fromPage = metaFromPageState(bvid)
  if (fromPage) return fromPage
  const fromApi = await metaFromViewApi(bvid)
  if (fromApi) return fromApi
  // 无页面状态且 view 接口失败：仍返回带 bvid 的基线形状，cid 留空等待各 provider 自行降级。
  return { bvid, cid: undefined, title: '', duration: 0 }
}

// ---------- 字幕 ----------

/** 字幕 JSON 的原始行形状：from/to 为秒或毫秒量级整数，归一为秒。 */
function normalizeSubtitleLine(line: Record<string, unknown>, scale: number): Subtitle | null {
  const text = typeof line.content === 'string' ? line.content.trim() : ''
  if (text === '') return null
  const from = asPositiveNumber(line.from)
  const to = asPositiveNumber(line.to)
  if (from === undefined || to === undefined) return null
  const start = from * scale
  const end = to * scale
  if (!(end > start)) return null
  return { start, end, text }
}

/** 档级单位判定：全文整数且最大时间戳远超视频时长（或 1 小时下限）→ 毫秒档。 */
function isMillisecondUnit(rawLines: Record<string, unknown>[], duration: number): boolean {
  const values = rawLines
    .flatMap((line) => [line.from, line.to])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (values.length === 0 || !values.every(Number.isInteger)) return false
  const maxValue = Math.max(...values)
  const secondsCeiling = Math.max(duration > 0 ? duration * 1.2 : 0, 3600)
  return maxValue > secondsCeiling
}

async function fetchSubtitleJson(url: string, duration: number): Promise<Subtitle[]> {
  const raw = ensureHttps(url)
  if (!raw) {
    console.info(`[bili-helper] 字幕 JSON：URL 无法规范化（${url.slice(0, 60)}）`)
    return []
  }
  console.info('[bili-helper] 字幕 JSON：拉取', raw.slice(0, 96))
  // 字幕 CDN（aisubtitle.hdslb.com）回 Access-Control-Allow-Origin: *——规范禁止 * 与
  // credentials:'include' 共用，带上就直接 Failed to fetch。URL 自带 auth_key 鉴权，
  // 不需要 cookie，用默认凭据模式（跨域不发送）即可。
  const response = await fetch(raw, { signal: timeoutSignal() })
  if (!response.ok) throw new Error(`请求失败：${response.status}`)
  const data: unknown = await response.json()
  if (!isRecord(data) || !Array.isArray(data.body)) {
    console.info('[bili-helper] 字幕 JSON：响应缺少 body 数组', JSON.stringify(data).slice(0, 120))
    return []
  }
  const rawLines = data.body.filter(isRecord)
  const scale = isMillisecondUnit(rawLines, duration) ? 0.001 : 1
  const lines: Subtitle[] = []
  for (const item of rawLines) {
    const line = normalizeSubtitleLine(item, scale)
    if (line) lines.push(line)
  }
  lines.sort((a, b) => a.start - b.start)
  return lines
}

function ensureHttps(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('//')) return `https:${trimmed}`
  return trimmed.startsWith('https://') ? trimmed : ''
}

/** player wbi 接口回的列表项形状（与页面状态同构：lan + subtitle_url）。 */
interface PlayerApiSubtitleItem {
  lan?: string
  subtitle_url?: string
}

/**
 * player wbi/v2 响应的按视频缓存（bvid:cid → Promise）：同一响应里有字幕列表与
 * 官方看点（view_points）两组数据，字幕兜底与章节标记都拉这一个接口，命中即零额外请求。
 * 页面生命周期内的内存缓存，SPA 换视频自然换键，无需失效策略。
 */
const playerApiCache = new Map<string, Promise<unknown>>()

/** 清空 player 接口缓存（测试隔离用；线上自然常驻，无需主动调用）。 */
export function resetPlayerApiCache(): void {
  playerApiCache.clear()
}

function fetchPlayerApiCached(video: VideoMeta, signal?: AbortSignal): Promise<unknown> {
  if (video.cid === undefined) return Promise.resolve(null)
  const key = `${video.bvid}:${video.cid}`
  const cached = playerApiCache.get(key)
  if (cached) return cached
  const pending = fetchJsonWithWbi(
    'https://api.bilibili.com/x/player/wbi/v2',
    { bvid: video.bvid, cid: video.cid },
    signal,
  ).catch((error: unknown) => {
    // 失败不缓存：下次调用（重试节拍/字幕兜底）还能再试。
    playerApiCache.delete(key)
    throw error
  })
  playerApiCache.set(key, pending)
  return pending
}

/**
 * 页面状态的字幕列表经常是空的（B 站把真实列表挪到了 x/player/wbi/v2，AI 字幕还要求登录态）——
 * 空列表时走 player 接口兜底：WBI 签名 + 浏览器自动带 cookie，与登录用户身份一致。
 */
async function subtitleListFromPlayerApi(video: VideoMeta): Promise<BiliSubtitleListItem[]> {
  if (video.cid === undefined) return []
  try {
    const data = await fetchPlayerApiCached(video, timeoutSignal())
    if (!isRecord(data) || !isRecord(data.data)) {
      console.info('[bili-helper] 字幕兜底：player 接口响应形状异常', JSON.stringify(data).slice(0, 160))
      return []
    }
    const code = typeof data.code === 'number' ? data.code : undefined
    const subtitle = isRecord(data.data.subtitle) ? data.data.subtitle : undefined
    const list = subtitle && Array.isArray(subtitle.subtitles) ? subtitle.subtitles : []
    console.info(
      `[bili-helper] 字幕兜底：player 接口 code=${code} login_mid=${String((data.data as Record<string, unknown>).login_mid ?? '?')} 字幕轨=${list.length}`,
    )
    return list
      .filter(isRecord)
      .map((item) => ({
        lan: typeof item.lan === 'string' ? item.lan : undefined,
        subtitle_url: typeof item.subtitle_url === 'string' ? item.subtitle_url : undefined,
      }))
  } catch (error) {
    console.info('[bili-helper] 字幕兜底：player 接口请求失败', error instanceof Error ? error.message : String(error))
    return []
  }
}

export async function collectSubtitles(video: VideoMeta): Promise<Subtitle[]> {
  try {
    // 字幕列表：页面状态优先（零网络成本），空则 player wbi 接口兜底。
    const pageList = videoData()?.subtitle?.list ?? []
    let candidates = pageList.filter(
      (item): item is BiliSubtitleListItem =>
        typeof item.subtitle_url === 'string' && item.subtitle_url.trim() !== '',
    )
    if (candidates.length === 0) {
      candidates = (await subtitleListFromPlayerApi(video)).filter(
        (item): item is BiliSubtitleListItem =>
          typeof item.subtitle_url === 'string' && item.subtitle_url.trim() !== '',
      )
    }
    // 优先中文档（lan 含 zh），退而取第一档。
    const zh = candidates.find((item) => (item.lan ?? '').toLowerCase().includes('zh'))
    const chosen = (zh ?? candidates[0]) as PlayerApiSubtitleItem | undefined
    if (!chosen) {
      console.info(`[bili-helper] 字幕：无可用轨道（候选 ${candidates.length}）`)
      return []
    }
    const lines = await fetchSubtitleJson(chosen.subtitle_url ?? '', video.duration)
    console.info(
      `[bili-helper] 字幕：选中 lan=${chosen.lan ?? '?'} url=${(chosen.subtitle_url ?? '').slice(0, 48)}… 解析=${lines.length}行`,
    )
    return lines
  } catch (error) {
    console.info('[bili-helper] 字幕采集异常：', error instanceof Error ? error.message : String(error))
    return []
  }
}

// ---------- 官方看点（章节） ----------

/**
 * 拉取官方「看点/章节」（view_points）原始数组：与字幕兜底共用 player/wbi/v2 的缓存请求。
 * 失败（网络/形状/cid 缺失）返回 null（与「成功但无看点」的空数组区分，调用方可重试）；
 * 解析与合并规则在 modules/content/chapters（纯函数层）。
 */
export async function collectViewPoints(video: VideoMeta): Promise<unknown[] | null> {
  if (video.cid === undefined) return null
  try {
    const data = await fetchPlayerApiCached(video, timeoutSignal())
    if (!isRecord(data) || !isRecord(data.data)) return null
    const viewPoints = (data.data as Record<string, unknown>).view_points
    return Array.isArray(viewPoints) ? viewPoints : []
  } catch {
    return null
  }
}

// ---------- 弹幕 ----------

/** 解析 comment.bilibili.com/{cid}.xml：<d p="time,mode,...">text</d>，首字段即弹幕时刻（秒）。 */
export function parseDanmakuXml(xmlText: string): Danmaku[] {
  if (typeof DOMParser === 'undefined') return []
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml')
  if (doc.querySelector('parsererror')) return []
  const danmaku: Danmaku[] = []
  for (const node of Array.from(doc.querySelectorAll('d'))) {
    const p = node.getAttribute('p') ?? ''
    const time = Number(p.split(',')[0])
    const text = node.textContent?.trim() ?? ''
    if (Number.isFinite(time) && text) danmaku.push({ time, text })
  }
  return danmaku
}

export async function collectDanmaku(video: VideoMeta): Promise<Danmaku[]> {
  if (video.cid === undefined) return []
  try {
    const response = await fetch(`https://comment.bilibili.com/${video.cid}.xml`, {
      credentials: 'include',
      signal: timeoutSignal(),
    })
    if (!response.ok) return []
    return parseDanmakuXml(await response.text())
  } catch {
    return []
  }
}

// ---------- 评论 ----------

/** 从页面状态取 aid；没有则走 view 接口按 bvid 反查（顺带把分 P 首页 aid 找回来）。 */
async function aidFor(video: VideoMeta): Promise<number | undefined> {
  const fromPage = asPositiveNumber(videoData()?.aid)
  if (fromPage !== undefined) return fromPage
  try {
    const data = await fetchBiliJson(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(video.bvid)}`,
      timeoutSignal(),
    )
    if (!isRecord(data) || !isRecord(data.data)) return undefined
    return asPositiveNumber(data.data.aid)
  } catch {
    return undefined
  }
}

/** 顶部评论文本归一：wbi 签名请求 x/v2/reply/wbi/main；threads 未结构化前一律不送 LLM。 */
export async function collectComments(video: VideoMeta): Promise<Comment[]> {
  try {
    const aid = await aidFor(video)
    if (aid === undefined) return []
    const data = await fetchJsonWithWbi(
      'https://api.bilibili.com/x/v2/reply/wbi/main',
      { type: 1, oid: aid, mode: 3, ps: 20 },
      timeoutSignal(),
    )
    if (!isRecord(data) || !isRecord(data.data)) return []
    const replies = Array.isArray(data.data.replies) ? data.data.replies : []
    const comments: Comment[] = []
    for (const reply of replies) {
      const message = isRecord(reply) && isRecord(reply.content) ? reply.content.message : undefined
      if (typeof message === 'string' && message.trim() !== '') {
        comments.push({ top: { text: message } })
      }
    }
    return comments
  } catch {
    return []
  }
}