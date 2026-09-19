// 视频筛选规则引擎（Epic2-S2.4）：八维度判定的纯函数层——主世界拦截器与单测共用，
// 不碰 DOM、不碰存储。语义沿旧产物口径（见 PRD FR-1/FR-2）：
//   标题关键词：子串、大小写不敏感、多值 OR；UP 主黑名单：mid 字符串或名字全等（trim+忽略大小写）；
//   时长（秒）/弹幕/点赞/浏览量：闭区间，null=不限；点赞率 = 点赞/浏览×100（浏览≤0 视为不限）；
//   发布时间：距今天数（整数语义，判定时用真实浮点天数对比）。
//   数据不完整的条目一律不筛（宁可放过，不可误杀）。

import type { VideoFilterConfig } from '../config'

/** 首页推荐条目的读取面（主世界拦截器喂进来的原始形状子集）。 */
export interface FeedItem {
  bvid?: unknown
  uri?: unknown
  title?: unknown
  owner?: { name?: unknown; mid?: unknown }
  duration?: unknown
  goto?: unknown
  stat?: { danmaku?: unknown; like?: unknown; view?: unknown }
  pubdate?: unknown
}

const BV_PATTERN = /BV[0-9A-Za-z]{10}/u

/** BV 提取：先 bvid 字段，再 uri 正则；取不到返回 null（该条无法定位卡片，不筛）。 */
export function extractBvid(item: FeedItem): string | null {
  if (typeof item.bvid === 'string') {
    const direct = item.bvid.match(BV_PATTERN)
    if (direct !== null) return direct[0]
  }
  if (typeof item.uri === 'string') {
    const fromUri = item.uri.match(BV_PATTERN)
    if (fromUri !== null) return fromUri[0]
  }
  return null
}

/** 完整性门槛：非普通视频（goto≠av）、缺 UP/统计/发布时间的条目不参与筛选。 */
export function itemIsComplete(item: FeedItem): boolean {
  if (item.goto !== 'av') return false
  if (typeof item.owner !== 'object' || item.owner === null) return false
  if (typeof item.stat !== 'object' || item.stat === null) return false
  if (typeof item.pubdate !== 'number' || !Number.isFinite(item.pubdate)) return false
  return true
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function inRange(value: number | null, min: number | null, max: number | null): boolean {
  if (value === null) return true // 数据缺失 = 不筛该维度
  if (min !== null && value < min) return false
  if (max !== null && value > max) return false
  return true
}

/** 点赞率（百分比）：浏览量 ≤0 或数据缺失 → null（视为不限，不误杀）。 */
export function likeRateOf(item: FeedItem): number | null {
  const like = asFiniteNumber(item.stat?.like)
  const view = asFiniteNumber(item.stat?.view)
  if (like === null || view === null || view <= 0) return null
  return (like / view) * 100
}

const MS_PER_DAY = 86_400_000

/** 距今天数（浮点）：发布时间缺失 → null。 */
export function ageDaysOf(item: FeedItem, now = Date.now()): number | null {
  const pubdate = asFiniteNumber(item.pubdate)
  if (pubdate === null) return null
  return (now - pubdate * 1000) / MS_PER_DAY
}

/**
 * 单条判定：命中返回原因（诊断用，如「标题关键词」），未命中返回 null。
 * 不完整条目直接返回 null（不筛）。
 */
export function filterReason(item: FeedItem, config: VideoFilterConfig, now = Date.now()): string | null {
  if (!itemIsComplete(item)) return null
  const title = typeof item.title === 'string' ? item.title.toLocaleLowerCase() : ''
  for (const raw of config.titleKeywords) {
    const keyword = raw.trim()
    if (keyword !== '' && title.includes(keyword.toLocaleLowerCase())) return `标题关键词:${keyword}`
  }
  const ownerName =
    typeof item.owner?.name === 'string' ? item.owner.name.trim().toLocaleLowerCase() : ''
  const mid = item.owner?.mid
  for (const entry of config.authorBlacklist) {
    const normalized = entry.trim().toLocaleLowerCase()
    if (normalized === '') continue
    if (typeof mid === 'string' && mid.trim() === entry.trim()) return `UP黑名单:${entry}`
    if (typeof mid === 'number' && String(mid) === entry.trim()) return `UP黑名单:${entry}`
    if (ownerName !== '' && ownerName === normalized) return `UP黑名单:${entry}`
  }
  if (!inRange(asFiniteNumber(item.duration), config.durationMinSeconds, config.durationMaxSeconds)) {
    return '时长'
  }
  if (!inRange(asFiniteNumber(item.stat?.danmaku), config.danmakuMin, config.danmakuMax)) return '弹幕数'
  if (!inRange(asFiniteNumber(item.stat?.like), config.likeMin, config.likeMax)) return '点赞数'
  if (!inRange(asFiniteNumber(item.stat?.view), config.viewMin, config.viewMax)) return '浏览量'
  if (!inRange(likeRateOf(item), config.likeRateMin, config.likeRateMax)) return '点赞率'
  if (!inRange(ageDaysOf(item, now), config.pubdateMinDays, config.pubdateMaxDays)) return '发布时间'
  return null
}

/** 至少配置了一条规则才生效（全空 = 拦截器不构建，零开销）。 */
export function hasAnyCriteria(config: VideoFilterConfig): boolean {
  return (
    config.titleKeywords.length > 0 ||
    config.authorBlacklist.length > 0 ||
    config.durationMinSeconds !== null ||
    config.durationMaxSeconds !== null ||
    config.danmakuMin !== null ||
    config.danmakuMax !== null ||
    config.likeMin !== null ||
    config.likeMax !== null ||
    config.viewMin !== null ||
    config.viewMax !== null ||
    config.likeRateMin !== null ||
    config.likeRateMax !== null ||
    config.pubdateMinDays !== null ||
    config.pubdateMaxDays !== null
  )
}

interface RangeField {
  key: string
  label: string
  min: number | null
  max: number | null
}

/** 校验：最小值大于最大值（两值都填时）按字段定位报错；这是 UI 阻止保存与拦截器暂停的依据。 */
export function validateFilterConfig(config: VideoFilterConfig): string[] {
  const ranges: RangeField[] = [
    { key: 'duration', label: '视频时长', min: config.durationMinSeconds, max: config.durationMaxSeconds },
    { key: 'danmaku', label: '弹幕数', min: config.danmakuMin, max: config.danmakuMax },
    { key: 'like', label: '点赞数', min: config.likeMin, max: config.likeMax },
    { key: 'view', label: '浏览量', min: config.viewMin, max: config.viewMax },
    { key: 'likeRate', label: '点赞率', min: config.likeRateMin, max: config.likeRateMax },
    { key: 'pubdate', label: '发布距今天数', min: config.pubdateMinDays, max: config.pubdateMaxDays },
  ]
  const errors: string[] = []
  for (const range of ranges) {
    if (range.min !== null && range.max !== null && range.min > range.max) {
      errors.push(`${range.label}最小值不能大于最大值`)
    }
  }
  return errors
}
