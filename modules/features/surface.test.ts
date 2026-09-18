// 注入面判定测试（Epic1-S1.2）：首页/视频页/其它页的边界与非法输入兜底。
import { describe, expect, it } from 'vitest'
import { classifySurface, surfaceMatches } from './surface'

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

  it('非注入面：分区/搜索/动态/番剧/直播/其它子域/畸形 BV', () => {
    expect(classifySurface('https://www.bilibili.com/v/popular/all')).toBe('other')
    expect(classifySurface('https://search.bilibili.com/all?keyword=x')).toBe('other')
    expect(classifySurface('https://t.bilibili.com/123')).toBe('other')
    expect(classifySurface('https://www.bilibili.com/bangumi/play/ep1')).toBe('other')
    expect(classifySurface('https://live.bilibili.com/1')).toBe('other')
    expect(classifySurface('https://www.bilibili.com/video/BV123')).toBe('other') // BV 位数不对
    expect(classifySurface('https://www.bilibili.com/list/12')).toBe('other') // 列表 id 太短
  })

  it('非法 href 一律按非注入面（宁可不动，不可乱动）', () => {
    expect(classifySurface('')).toBe('other')
    expect(classifySurface('not-a-url')).toBe('other')
  })
})

describe('surfaceMatches', () => {
  it('首页功能只在首页跑；视频页功能只在视频页跑；其它页谁都不跑', () => {
    expect(surfaceMatches('首页', 'home')).toBe(true)
    expect(surfaceMatches('首页', 'video')).toBe(false)
    expect(surfaceMatches('视频页', 'video')).toBe(true)
    expect(surfaceMatches('视频页', 'home')).toBe(false)
    expect(surfaceMatches('首页', 'other')).toBe(false)
    expect(surfaceMatches('视频页', 'other')).toBe(false)
  })
})
