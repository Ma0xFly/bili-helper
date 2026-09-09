import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collectVideoMeta } from './index'

describe('collectVideoMeta（bvid 解出）', () => {
  beforeEach(() => {
    // view 接口兜底路径：默认 404，让断言聚焦 bvid 解出与降级形状。
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('从视频页 URL 解出 bvid；view 兜底失败时保留基线形状', async () => {
    expect(await collectVideoMeta('https://www.bilibili.com/video/BV1xx411c7mD/?p=2')).toEqual({
      bvid: 'BV1xx411c7mD',
      cid: undefined,
      title: '',
      duration: 0,
    })
  })

  it('支持对象形入参（href）', async () => {
    expect(await collectVideoMeta({ href: 'https://www.bilibili.com/video/BV1xx411c7mD' })).toEqual(
      expect.objectContaining({ bvid: 'BV1xx411c7mD', cid: undefined }),
    )
  })

  it('支持 URL 对象入参', async () => {
    expect(await collectVideoMeta(new URL('https://www.bilibili.com/video/BV123'))).toEqual(
      expect.objectContaining({ bvid: 'BV123' }),
    )
  })

  it('非 /video/ 路径返回 null（首页）', async () => {
    expect(await collectVideoMeta('https://www.bilibili.com/')).toBeNull()
  })

  it('非 B 站视频页返回 null（其他站点）', async () => {
    expect(await collectVideoMeta('https://www.youtube.com/watch?v=abc')).toBeNull()
  })

  it('其他域名借 /video/ 路径也返回 null', async () => {
    expect(await collectVideoMeta('https://www.youtube.com/video/BV1xx411c7mD')).toBeNull()
    expect(await collectVideoMeta('https://evilbilibili.com/video/BV1xx411c7mD')).toBeNull()
  })

  it('裸域名 bilibili.com 同样可解出 bvid', async () => {
    expect(await collectVideoMeta('https://bilibili.com/video/BV1xx411c7mD')).toEqual(
      expect.objectContaining({ bvid: 'BV1xx411c7mD' }),
    )
  })

  it('空字符串与无效 URL 返回 null', async () => {
    expect(await collectVideoMeta('')).toBeNull()
    expect(await collectVideoMeta('not a url')).toBeNull()
  })
})