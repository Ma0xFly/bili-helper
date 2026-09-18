// 注入面判定（Epic1-S1.2）：功能只在自己的注入面上运行——首页功能不在视频页跑、
// 视频页功能不在首页跑、两类之外（分区/搜索/动态/番剧/直播…）一律不执行任何功能逻辑。
// 纯函数、无 DOM 依赖，内容脚本与单测共用同一份口径。

export type PageSurface = 'home' | 'video' | 'other'

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
    if (hostname !== 'www.bilibili.com') return 'other'
    const path = url.pathname
    if (path === '/' || path === '/index.html') return 'home'
    if (VIDEO_PATH_PATTERNS.some((pattern) => pattern.test(path))) return 'video'
    return 'other'
  } catch {
    // 解析不了的 href 一律按非注入面处理（宁可不动，不可乱动）。
    return 'other'
  }
}

/** 功能组的适用注入面 → 页面注入面匹配。 */
export function surfaceMatches(appliesTo: '首页' | '视频页', surface: PageSurface): boolean {
  if (appliesTo === '首页') return surface === 'home'
  return surface === 'video'
}
