import { describe, expect, it } from 'vitest'
import {
  buildChatMessages,
  buildSummaryMessages,
  extractJson,
  formatTimecode,
  parseSummarizeResponse,
  renderAiContext,
} from './prompts'
import type { AiContext } from './port'

const CONTEXT: AiContext = {
  video: { bvid: 'BV1xx411c7mD', cid: 1, title: '降噪耳机横评', duration: 600 },
  subtitles: [
    { start: 5, end: 12, text: '大家好，今天横评八款耳机' },
    { start: 492, end: 580, text: '感谢某音乐 App 赞助本视频' },
  ],
  danmaku: [{ time: 30, text: '前排！' }],
  comments: [{ top: { text: '讲得很好' } }],
}

describe('formatTimecode', () => {
  it('秒转 mm:ss 时间码（时间单位秒是端口铁律，UI 层才做 HH:MM:SS）', () => {
    expect(formatTimecode(0)).toBe('00:00')
    expect(formatTimecode(7)).toBe('00:07')
    expect(formatTimecode(65)).toBe('01:05')
    expect(formatTimecode(3599)).toBe('59:59')
    expect(formatTimecode(-3)).toBe('00:00')
    // 坏时间戳（NaN/Infinity）不得产出「NaN:NaN」。
    expect(formatTimecode(Number.NaN)).toBe('00:00')
    expect(formatTimecode(Number.POSITIVE_INFINITY)).toBe('00:00')
  })
})

describe('总结提示词', () => {
  it('system 含「只依据给定资料/禁止编造/资料不足明说」红线与 JSON 输出协议', () => {
    const messages = buildSummaryMessages({ ...CONTEXT })
    const system = messages[0]?.content ?? ''
    expect(system).toContain('只依据给定资料')
    expect(system).toContain('严禁编造')
    expect(system).toContain('资料不足')
    expect(system).toContain('"summary"')
    expect(system).toContain('"segments"')
    expect(system).toContain('广告')
  })

  it('user 携带视频标题、字幕文本与时间码', () => {
    const messages = buildSummaryMessages({ ...CONTEXT })
    const user = messages[1]?.content ?? ''
    expect(user).toContain('降噪耳机横评')
    expect(user).toContain('[00:05] 大家好，今天横评八款耳机')
    expect(user).toContain('[30s] 前排！')
  })
})

describe('提问提示词', () => {
  it('system 含「只依据资料/溯源标注/资料不足」要求', () => {
    const messages = buildChatMessages({ messages: [{ role: 'user', content: '精华片段在哪？' }], context: CONTEXT })
    const system = messages[0]?.content ?? ''
    expect(system).toContain('只依据下面提供的视频资料')
    expect(system).toContain('溯源标注')
    expect(system).toContain('〔字幕 mm:ss–mm:ss〕')
    expect(system).toContain('资料不足')
  })

  it('装配顺序：system → 上下文 user → 调用方会话轮次', () => {
    const messages = buildChatMessages({
      messages: [
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '第一答' },
        { role: 'user', content: '追问' },
      ],
      context: CONTEXT,
    })
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'user', 'assistant', 'user'])
    const contextMessage = messages[1]?.content ?? ''
    expect(contextMessage).toContain('只能依据这些资料')
    expect(contextMessage).toContain('评论：')
    expect(messages[2]?.content).toBe('第一问')
    expect(messages[4]?.content).toBe('追问')
  })
})

describe('renderAiContext', () => {
  it('标题/字幕/弹幕/评论分区渲染，字幕带 mm:ss 时间码', () => {
    const text = renderAiContext(CONTEXT)
    expect(text).toContain('降噪耳机横评')
    expect(text).toContain('[00:05] 大家好')
    expect(text).toContain('[30s] 前排！')
    expect(text).toContain('- 讲得很好')
  })
})

describe('extractJson', () => {
  it('整段合法 JSON 直接解析', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('剥 ```json 围栏后解析', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('夹杂前后口水的 JSON 取首尾花括号截取', () => {
    expect(extractJson('好的，如下：{"summary":"s","segments":[]} 希望有帮助')).toEqual({
      summary: 's',
      segments: [],
    })
  })

  it('无法解析返回 null', () => {
    expect(extractJson('完全不是 JSON')).toBeNull()
    expect(extractJson('')).toBeNull()
  })
})

describe('parseSummarizeResponse（先解析后退化）', () => {
  it('形状完整时返回结构', () => {
    const result = parseSummarizeResponse(
      JSON.stringify({
        summary: '一句话总结',
        segments: [
          { start: 0, end: 10, label: '开场' },
          { start: 492, end: 580, label: '广告：音乐 App 推广' },
        ],
      }),
    )
    expect(result).toEqual({
      summary: '一句话总结',
      segments: [
        { start: 0, end: 10, label: '开场' },
        { start: 492, end: 580, label: '广告：音乐 App 推广' },
      ],
    })
  })

  it('非法 segment 条目被丢弃，合法条目保留', () => {
    const result = parseSummarizeResponse(
      JSON.stringify({
        summary: 's',
        segments: [{ start: 'x', end: 10, label: '坏' }, { start: 4, end: 9, label: '好' }],
      }),
    )
    expect(result.segments).toEqual([{ start: 4, end: 9, label: '好' }])
  })

  it('JSON 不可解析/形状不对时退化为原文 summary、segments 空', () => {
    const degraded = parseSummarizeResponse('模型直接输出的一段文字总结。')
    expect(degraded).toEqual({ summary: '模型直接输出的一段文字总结。', segments: [] })

    const wrongShape = parseSummarizeResponse(JSON.stringify({ nope: true }))
    expect(wrongShape).toEqual({ summary: JSON.stringify({ nope: true }), segments: [] })
  })

  it('空输出退化为空 summary 空 segments，不抛错', () => {
    expect(parseSummarizeResponse('')).toEqual({ summary: '', segments: [] })
  })
})