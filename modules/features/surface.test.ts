// 注入面判定测试（Epic1-S1.2 + 第三阶段扩展）：首页/视频页/热门/搜索的边界与非法输入兜底。
import { describe, expect, it } from 'vitest'
import { classifySurface, surfaceMatches, type FeatureSurfaceLabel } from './surface'

describe('classifySurface', () => {
  it('首页：根路径与 /index.html', () => {
    expect(classifySurface('https://www.bilibili.com/')).toBe('home')
    expect(classifySurface('https://www.bilibili.com/index.html')).toBe('home')
    expect(classifySurface('https://www.bilibili.com/?spm_id_from=x')).toBe('home')
  })

  it('视频页：普通视频 / 稍后再看 / 合集列表', () => {
    expect(classifySurface('https://www.bilibili.com/video/BV18vY969EHJ/')).toBe('video')
    expect(classifySurface('https://www.bilibili.com/video/BV18vY969EHJ/?p=2')).toBe('video')
    expect(classifySurface('https://www.bilibili.com/list/watchlater')).toBe('video')
    expect(classifySurface('https://www.bilibili.com/list/123456789')).toBe('video')
  })

  it('热门：/v/popular 下任意路径（独立于分区页）', () => {
    expect(classifySurface('https://www.bilibili.com/v/popular/all')).toBe('popular')
    expect(classifySurface('https://www.bilibili.com/v/popular')).toBe('popular')
    expect(classifySurface('https://www.bilibili.com/v/popular/weekly')).toBe('popular')
  })

  it('搜索：独立域名 search.bilibili.com 任意路径', () => {
    expect(classifySurface('https://search.bilibili.com/all?keyword=x')).toBe('search')
    expect(classifySurface('https://search.bilibili.com/video?keyword=x')).toBe('search')
  })

  it('非注入面：分区/动态/番剧/直播/其它子域/畸形 BV', () => {
    expect(classifySurface('https://t.bilibili.com/123')).toBe('other')
    expect(classifySurface('https://www.bilibili.com/bangumi/play/ep1')).toBe('other')
    expect(classifySurface('https://live.bilibili.com/1')).toBe('other')
    expect(classifySurface('https://www.bilibili.com/v/douga')).toBe('other') // 分区不是热门
    expect(classifySurface('https://www.bilibili.com/video/BV123')).toBe('other') // BV 位数不对
    expect(classifySurface('https://www.bilibili.com/list/12')).toBe('other') // 列表 id 太短
  })

  it('非法 href 一律按非注入面（宁可不动，不可乱动）', () => {
    expect(classifySurface('')).toBe('other')
    expect(classifySurface('not-a-url')).toBe('other')
  })
})

describe('surfaceMatches', () => {
  it('单面功能只在对应注入面跑；其它页谁都不跑', () => {
    expect(surfaceMatches(['首页'], 'home')).toBe(true)
    expect(surfaceMatches(['首页'], 'video')).toBe(false)
    expect(surfaceMatches(['视频页'], 'video')).toBe(true)
    expect(surfaceMatches(['视频页'], 'home')).toBe(false)
    expect(surfaceMatches(['首页'], 'other')).toBe(false)
    expect(surfaceMatches(['视频页'], 'other')).toBe(false)
  })

  it('多面功能（视频筛选 = 首页+热门+搜索）：三个注入面都命中，视频页/其它页不跑', () => {
    const appliesTo: FeatureSurfaceLabel[] = ['首页', '热门', '搜索']
    expect(surfaceMatches(appliesTo, 'home')).toBe(true)
    expect(surfaceMatches(appliesTo, 'popular')).toBe(true)
    expect(surfaceMatches(appliesTo, 'search')).toBe(true)
    expect(surfaceMatches(appliesTo, 'video')).toBe(false)
    expect(surfaceMatches(appliesTo, 'other')).toBe(false)
  })
})
