import { describe, expect, it } from 'vitest'
import { collectVideoMeta } from './index'

describe('collectVideoMeta', () => {
  it('从视频页 URL 解出 bvid，cid 留空等待 page 状态填充', () => {
    expect(collectVideoMeta('https://www.bilibili.com/video/BV1xx411c7mD/?p=2')).toEqual({
      bvid: 'BV1xx411c7mD',
      cid: undefined,
      title: '',
      duration: 0,
    })
  })

  it('支持对象形入参（href）', () => {
    expect(collectVideoMeta({ href: 'https://www.bilibili.com/video/BV1xx411c7mD' })).toEqual(
      expect.objectContaining({ bvid: 'BV1xx411c7mD', cid: undefined }),
    )
  })

  it('支持 URL 对象入参', () => {
    expect(collectVideoMeta(new URL('https://www.bilibili.com/video/BV123'))).toEqual(
      expect.objectContaining({ bvid: 'BV123' }),
    )
  })

  it('非 /video/ 路径返回 null（首页）', () => {
    expect(collectVideoMeta('https://www.bilibili.com/')).toBeNull()
  })

  it('非 B 站视频页返回 null（其他站点）', () => {
    expect(collectVideoMeta('https://www.youtube.com/watch?v=abc')).toBeNull()
  })

  it('其他域名借 /video/ 路径也返回 null', () => {
    expect(collectVideoMeta('https://www.youtube.com/video/BV1xx411c7mD')).toBeNull()
    expect(collectVideoMeta('https://evilbilibili.com/video/BV1xx411c7mD')).toBeNull()
  })

  it('裸域名 bilibili.com 同样可解出 bvid', () => {
    expect(collectVideoMeta('https://bilibili.com/video/BV1xx411c7mD')).toEqual(
      expect.objectContaining({ bvid: 'BV1xx411c7mD' }),
    )
  })

  it('空字符串与无效 URL 返回 null', () => {
    expect(collectVideoMeta('')).toBeNull()
    expect(collectVideoMeta('not a url')).toBeNull()
  })
})