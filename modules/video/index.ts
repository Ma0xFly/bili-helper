import type { Comment, Danmaku, Subtitle, VideoMeta } from './types'

// 采集层骨架与归一化入口。

// 从 location（或等价 URL 字符串/对象）解出 bvid；cid 无法从 URL 获得，留待 page 状态填充。
// 支持双入参：URL 字符串 或 形如 { url }/{ href } 的对象；非 /video/ 路径或非 B 站域名返回 null。
export function collectVideoMeta(
  source?: string | { url?: string; href?: string } | URL,
): VideoMeta | null {
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

  return {
    bvid: match[1],
    cid: undefined,
    title: '',
    duration: 0,
  }
}

// 只认主域名与其子域名，避免其他站点借 /video/ 路径被误判为 B 站视频页。
function isBilibiliHost(hostname: string): boolean {
  return hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com')
}

function resolveHref(source?: string | { url?: string; href?: string } | URL): string {
  if (source == null) return typeof location === 'undefined' ? '' : location.href
  if (typeof source === 'string') return source
  if (source instanceof URL) return source.href
  return source.url ?? source.href ?? ''
}

// 三个 provider 均为空实现：暂不逆向 B 站字幕/弹幕/评论接口，
// 返回空数组、不抛错，真实抓取留待后续实现。
export async function collectSubtitles(_video: VideoMeta): Promise<Subtitle[]> {
  return []
}

export async function collectDanmaku(_video: VideoMeta): Promise<Danmaku[]> {
  return []
}

export async function collectComments(_video: VideoMeta): Promise<Comment[]> {
  return []
}