// 注入面判定（Epic1-S1.2）：功能只在自己的注入面上运行——首页/视频页/热门/搜索
// 四个注入面之外（分区/动态/番剧/直播…）一律不执行任何功能逻辑。
// 纯函数、无 DOM 依赖，内容脚本与单测共用同一份口径。

export type PageSurface = 'home' | 'video' | 'popular' | 'search' | 'other'

/** PRD 锁定的视频页路径：普通视频、稍后再看、合集/列表（4–12 位数字 id）。 */
const VIDEO_PATH_PATTERNS: RegExp[] = [
  /^\/video\/BV[0-9A-Za-z]{10}(?:\/|$)/u,
  /^\/list\/watchlater(?:\/|$)/u,
  /^\/list\/\d{4,12}(?:\/|$)/u,
]

/** 首页：仅 www.bilibili.com 的根路径（含 /index.html）。 */
export function classifySurface(href: string, hostnameOverride?: string): PageSurface {
  try {
    const url = new URL(href)
    const hostname = hostnameOverride ?? url.hostname
    // 搜索页独立域名：search.bilibili.com（任何路径都算搜索注入面）。
    if (hostname === 'search.bilibili.com') return 'search'
    if (hostname !== 'www.bilibili.com') return 'other'
    const path = url.pathname
    if (path === '/' || path === '/index.html') return 'home'
    if (path === '/v/popular' || path.startsWith('/v/popular/')) return 'popular'
    if (VIDEO_PATH_PATTERNS.some((pattern) => pattern.test(path))) return 'video'
    return 'other'
  } catch {
    // 解析不了的 href 一律按非注入面处理（宁可不动，不可乱动）。
    return 'other'
  }
}

/** 注入面标签 → 页面注入面。 */
const LABEL_SURFACE: Record<FeatureSurfaceLabel, PageSurface> = {
  首页: 'home',
  视频页: 'video',
  热门: 'popular',
  搜索: 'search',
}

export type FeatureSurfaceLabel = '首页' | '视频页' | '热门' | '搜索'

/** 功能的适用注入面（可多面）→ 页面注入面匹配。 */
export function surfaceMatches(appliesTo: FeatureSurfaceLabel[], surface: PageSurface): boolean {
  return appliesTo.some((label) => LABEL_SURFACE[label] === surface)
}
