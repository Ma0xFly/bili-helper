// @vitest-environment happy-dom
// 采集层单测：页面状态优先/view 兜底、字幕 JSON 拉取、弹幕 XML 解析、wbi 评论签名，
// 以及每个 provider 独立容错（任一失败→空数组继续）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  collectComments,
  collectDanmaku,
  collectSubtitles,
  collectVideoMeta,
  collectViewPoints,
  extractBvidFromUrl,
  resetPlayerApiCache,
} from './collectors'
import { parseDanmakuXml } from './collectors'
import { md5, resetWbiKeyCache } from './wbi'
import type { VideoMeta } from './types'

const VIDEO: VideoMeta = { bvid: 'BV1xx411c7mD', cid: 123456, title: '测试视频', duration: 600 }

function setPageState(state: unknown): void {
  ;(window as unknown as Record<string, unknown>).__INITIAL_STATE__ = state
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__INITIAL_STATE__
  resetWbiKeyCache()
  resetPlayerApiCache()
  vi.unstubAllGlobals()
})

describe('collectVideoMeta', () => {
  it('页面状态优先：videoData 直接供 cid/标题/时长，不发任何网络请求', async () => {
    setPageState({
      videoData: { bvid: 'BV1xx411c7mD', aid: 1, cid: 99, title: '恰饭横评', duration: 1200 },
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const meta = await collectVideoMeta('https://www.bilibili.com/video/BV1xx411c7mD/')
    expect(meta).toEqual({ bvid: 'BV1xx411c7mD', cid: 99, title: '恰饭横评', duration: 1200 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('页面状态缺失时走 view 接口兜底', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        expect(String(url)).toContain('x/web-interface/view?bvid=BV1xx411c7mD')
        return jsonResponse({ code: 0, data: { cid: 7, title: '接口标题', duration: 88 } })
      }),
    )
    const meta = await collectVideoMeta('https://www.bilibili.com/video/BV1xx411c7mD')
    expect(meta).toEqual({ bvid: 'BV1xx411c7mD', cid: 7, title: '接口标题', duration: 88 })
  })

  it('页面状态与接口都失败：返回 bvid 基线形状（不抛错）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))))
    expect(await collectVideoMeta('https://www.bilibili.com/video/BV1xx411c7mD')).toEqual({
      bvid: 'BV1xx411c7mD',
      cid: undefined,
      title: '',
      duration: 0,
    })
  })

  it('非视频页 bvid 解出失败返回 null', async () => {
    expect(extractBvidFromUrl('https://www.bilibili.com/')).toBeNull()
  })
})

describe('collectSubtitles', () => {
  it('player 字幕列表 → JSON 拉取归一（毫秒量级修正到秒）', async () => {
    setPageState({
      videoData: {
        subtitle: {
          list: [
            { lan: 'en', subtitle_url: 'https://aisubtitle.example/en.json' },
            { lan: 'zh-CN', subtitle_url: 'https://aisubtitle.example/zh.json' },
          ],
        },
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        expect(String(url)).toBe('https://aisubtitle.example/zh.json')
        return jsonResponse({
          body: [
            { from: 0, to: 2000, content: '大家好，今天横评八款耳机' },
            { from: 2000, to: 5500, content: '感谢某音乐 App 赞助' },
          ],
        })
      }),
    )
    expect(await collectSubtitles(VIDEO)).toEqual([
      { start: 0, end: 2, text: '大家好，今天横评八款耳机' },
      { start: 2, end: 5.5, text: '感谢某音乐 App 赞助' },
    ])
  })

  it('字幕 JSON 拉取失败 → 空数组继续', async () => {
    setPageState({
      videoData: { subtitle: { list: [{ lan: 'zh', subtitle_url: 'https://aisubtitle.example/broken' }] } },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    expect(await collectSubtitles(VIDEO)).toEqual([])
  })

  it('页面状态列表为空 → player wbi 接口兜底（2026 形态：真实列表只在接口里）', async () => {
    setPageState({ videoData: { subtitle: { list: [] } } })
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const target = String(url)
      if (target.includes('/x/web-interface/nav')) {
        return jsonResponse({
          code: 0,
          data: {
            wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/a.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/b.png' },
          },
        })
      }
      if (target.includes('/x/player/wbi/v2')) {
        expect(target).toContain('bvid=BV1xx411c7mD')
        expect(target).toContain('cid=123456')
        expect(target).toContain('w_rid=')
        return jsonResponse({
          code: 0,
          data: {
            subtitle: {
              subtitles: [
                { lan: 'ai-zh', lan_doc: '中文（自动生成）', subtitle_url: '//aisubtitle.example/zh.json' },
              ],
            },
          },
        })
      }
      if (target.includes('aisubtitle.example/zh.json')) {
        // 协议相对 URL 必须补 https 再拉取。
        expect(target.startsWith('https://')).toBe(true)
        return jsonResponse({ body: [{ from: 353, to: 432, content: '限时优惠，点评论区链接下单' }] })
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(await collectSubtitles(VIDEO)).toEqual([
      { start: 353, end: 432, text: '限时优惠，点评论区链接下单' },
    ])
  })

  it('页面状态与 player 接口都拿不到列表 → 空数组（不抛错）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))))
    expect(await collectSubtitles(VIDEO)).toEqual([])
  })

  it('cid 缺失时不发 player 兜底请求 → 空数组', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await collectSubtitles({ ...VIDEO, cid: undefined })).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('collectViewPoints（官方看点）', () => {
  it('view_points 原样透传（解析合并在 chapters 纯函数层）；重复调用命中缓存只发一次请求', async () => {
    let playerCalls = 0
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const target = String(url)
      if (target.includes('/x/web-interface/nav')) {
        return jsonResponse({
          code: 0,
          data: {
            wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/a.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/b.png' },
          },
        })
      }
      if (target.includes('/x/player/wbi/v2')) {
        playerCalls += 1
        return jsonResponse({
          code: 0,
          data: {
            view_points: [
              { from: 0, to: 90, content: '开场', type: 1 },
              { from: 90, to: 600, content: '正片', type: 1 },
            ],
          },
        })
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const points = await collectViewPoints(VIDEO)
    expect(points).toEqual([
      { from: 0, to: 90, content: '开场', type: 1 },
      { from: 90, to: 600, content: '正片', type: 1 },
    ])
    await collectViewPoints(VIDEO)
    expect(playerCalls).toBe(1) // bvid:cid 缓存命中，字幕兜底同享这一次请求
  })

  it('接口正常但无 view_points → 空数组（成功无数据）；网络失败 → null（可重试）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      const target = String(url)
      if (target.includes('/x/web-interface/nav')) {
        return jsonResponse({
          code: 0,
          data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/a.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/b.png' } },
        })
      }
      return jsonResponse({ code: 0, data: {} })
    }))
    expect(await collectViewPoints(VIDEO)).toEqual([])

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))))
    expect(await collectViewPoints({ ...VIDEO, cid: 777 })).toBeNull()
  })

  it('cid 缺失 → null，不发请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await collectViewPoints({ ...VIDEO, cid: undefined })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('collectDanmaku', () => {
  it('cid 缺失直接空数组，不发请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await collectDanmaku({ ...VIDEO, cid: undefined })).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('XML 端点解析（p 属性首字段为时刻秒）', async () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<i><chatserver>chat.bilibili.com</chatserver><chatid>1</chatid>',
      '<d p="12.7,1,25,16777215,1700000000,0,abc,1">恰饭啦</d>',
      '<d p="30.1,5,25,16777215,1700000001,0,def,2">后面接广告？</d>',
      '</i>',
    ].join('')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(xml, { status: 200 })))
    expect(await collectDanmaku(VIDEO)).toEqual([
      { time: 12.7, text: '恰饭啦' },
      { time: 30.1, text: '后面接广告？' },
    ])
  })

  it('parseDanmakuXml 对坏 XML 容错', () => {
    expect(parseDanmakuXml('不是 XML')).toEqual([])
  })

  it('XML 拉取失败 → 空数组', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('net down'))))
    expect(await collectDanmaku(VIDEO)).toEqual([])
  })
})

describe('collectComments（wbi 签名）', () => {
  it('页面状态取 aid → wbi 签名请求 → 顶部评论文本', async () => {
    setPageState({ videoData: { bvid: 'BV1xx411c7mD', aid: 42 } })
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const target = String(url)
      if (target.includes('/x/web-interface/nav')) {
        return jsonResponse({
          code: 0,
          data: {
            wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/a.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/b.png' },
          },
        })
      }
      if (target.includes('/x/v2/reply/wbi/main')) {
        expect(target).toContain('oid=42')
        expect(target).toContain('w_rid=')
        return jsonResponse({
          code: 0,
          data: {
            replies: [{ content: { message: '恰饭太明显了吧' } }, { content: { message: '耳机不错' } }],
          },
        })
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(await collectComments(VIDEO)).toEqual([
      { top: { text: '恰饭太明显了吧' } },
      { top: { text: '耳机不错' } },
    ])
  })

  it('nav 密钥拉取失败 → 空数组（provider 独立容错）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 502 })))
    setPageState({ videoData: { bvid: 'BV1xx411c7mD', aid: 42 } })
    expect(await collectComments(VIDEO)).toEqual([])
  })
})

describe('wbi/md5 基础', () => {
  it('纯 TS MD5 与标准向量一致', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e')
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72')
    expect(md5('恰饭赞助')).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('provider 独立容错', () => {
  it('字幕/弹幕/评论互相独立：一个字幕失败不拖垮其他源', async () => {
    setPageState({
      videoData: {
        aid: 1,
        subtitle: { list: [{ lan: 'zh', subtitle_url: 'https://aisubtitle.example/broken' }] },
      },
    })
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      const target = String(url)
      if (target.includes('aisubtitle')) return new Response('boom', { status: 500 })
      return jsonResponse({ code: 0, data: { replies: [{ content: { message: '好的' } }] } })
    }))
    const [subtitles, danmaku, comments] = await Promise.all([
      collectSubtitles(VIDEO),
      collectDanmaku(VIDEO),
      collectComments(VIDEO),
    ])
    expect(subtitles).toEqual([])
    expect(danmaku).toEqual([]) // nav 假响应里没有 wbi 密钥，同样降级
    expect(comments).toEqual([])
  })
})