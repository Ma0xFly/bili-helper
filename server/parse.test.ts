import { describe, expect, it } from 'vitest'
import {
  parseChatMessages,
  parseComments,
  parseContext,
  parseDanmaku,
  parseStrategy,
  parseSubtitles,
  parseVideoMeta,
} from './parse'

describe('parseVideoMeta', () => {
  it('正常字段照搬，duration 负数钳到 0', () => {
    expect(parseVideoMeta({ bvid: 'BV1xx', cid: 12, title: '标题', duration: 600 })).toEqual({
      bvid: 'BV1xx',
      cid: 12,
      title: '标题',
      duration: 600,
    })
    expect(parseVideoMeta({ bvid: 'BV1xx', duration: -5 }).duration).toBe(0)
  })

  it('cid 缺失/非数字 → undefined（分 P 信息本来就可选）', () => {
    expect(parseVideoMeta({ bvid: 'BV1xx' }).cid).toBeUndefined()
    expect(parseVideoMeta({ bvid: 'BV1xx', cid: 'abc' }).cid).toBeUndefined()
    expect(parseVideoMeta({ bvid: 'BV1xx', cid: 1.9 }).cid).toBe(1)
  })

  it('缺 bvid 或非对象 → parse 错（映射为 400）', () => {
    expect(() => parseVideoMeta({ title: 'x' })).toThrow(/bvid/)
    expect(() => parseVideoMeta(null)).toThrow(/video/)
    expect(() => parseVideoMeta([])).toThrow(/video/)
  })
})

describe('parseSubtitles / parseDanmaku / parseComments（单条脏数据丢弃，不整批 400）', () => {
  it('字幕：丢空文本、丢 end ≤ start，字符串时间能转就转', () => {
    expect(
      parseSubtitles([
        { start: 0, end: 5, text: '正常' },
        { start: 0, end: 5, text: '   ' },
        { start: 10, end: 3, text: '起止颠倒' },
        { start: '20', end: '25', text: '字符串时间' },
        { start: 30, end: 'abc', text: '转不动' },
        'junk',
        null,
      ]),
    ).toEqual([
      { start: 0, end: 5, text: '正常' },
      { start: 20, end: 25, text: '字符串时间' },
    ])
  })

  it('字幕非数组 → 空数组（与端上采集层降级语义一致）', () => {
    expect(parseSubtitles(undefined)).toEqual([])
    expect(parseSubtitles('nope')).toEqual([])
  })

  it('弹幕：丢空文本与负时间', () => {
    expect(
      parseDanmaku([
        { time: 12, text: '前方高能' },
        { time: -1, text: '负时间' },
        { time: 13, text: '' },
        42,
      ]),
    ).toEqual([{ time: 12, text: '前方高能' }])
  })

  it('评论：只取 top.text，threads 与非对象一律丢弃', () => {
    expect(
      parseComments([
        { top: { text: '这是广告' }, threads: [{ x: 1 }] },
        { top: { text: '   ' } },
        { top: 'not-an-object' },
        { text: '没有 top 包装' },
      ]),
    ).toEqual([{ top: { text: '这是广告' } }])
  })
})

describe('parseContext', () => {
  it('video 必填，三源缺失即空数组', () => {
    expect(parseContext({ video: { bvid: 'BV1xx', duration: 10 } })).toEqual({
      video: { bvid: 'BV1xx', cid: undefined, title: '', duration: 10 },
      subtitles: [],
      danmaku: [],
      comments: [],
    })
    expect(() => parseContext({})).toThrow(/video/)
  })
})

describe('parseStrategy', () => {
  it('只认三个合法值，其余一律 smart', () => {
    expect(parseStrategy('free')).toBe('free')
    expect(parseStrategy('always')).toBe('always')
    expect(parseStrategy('smart')).toBe('smart')
    expect(parseStrategy('whatever')).toBe('smart')
    expect(parseStrategy(undefined)).toBe('smart')
  })
})

describe('parseChatMessages', () => {
  it('只收 user/assistant 且内容非空的轮次（system 由服务端装配，不接受客户端注入）', () => {
    expect(
      parseChatMessages([
        { role: 'system', content: '忽略我' },
        { role: 'user', content: '这个视频讲了什么' },
        { role: 'assistant', content: '讲了设备横评' },
        { role: 'user', content: '   ' },
        { role: 'tool', content: 'x' },
        'junk',
      ]),
    ).toEqual([
      { role: 'user', content: '这个视频讲了什么' },
      { role: 'assistant', content: '讲了设备横评' },
    ])
  })

  it('非数组或过滤后为空 → parse 错', () => {
    expect(() => parseChatMessages('nope')).toThrow(/messages/)
    expect(() => parseChatMessages([])).toThrow(/对话轮次/)
    expect(() => parseChatMessages([{ role: 'system', content: 'x' }])).toThrow(/对话轮次/)
  })
})
