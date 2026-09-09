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
  if (!raw) return []
  const data = await fetchBiliJson(raw, timeoutSignal())
  if (!isRecord(data) || !Array.isArray(data.body)) return []
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

export async function collectSubtitles(video: VideoMeta): Promise<Subtitle[]> {
  try {
    // player 字幕列表：优先中文档（lan 含 zh），退而取第一档。
    const list = videoData()?.subtitle?.list ?? []
    const candidates = list.filter((item) => typeof item.subtitle_url === 'string' && item.subtitle_url.trim() !== '')
    const zh = candidates.find((item) => (item.lan ?? '').toLowerCase().includes('zh'))
    const chosen = zh ?? candidates[0]
    if (!chosen) return []
    return await fetchSubtitleJson(chosen.subtitle_url ?? '', video.duration)
  } catch {
    return []
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