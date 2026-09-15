import { describe, expect, it } from 'vitest'
import {
  CHAT_TURN_LIMIT,
  adSegmentLabel,
  buildContextUserMessage,
  mergeSegmentsWithAds,
  panelErrorCopy,
  parseCitation,
  splitCitations,
  summaryAgoSeconds,
  trimChatHistory,
} from './panel-logic'
import type { AdSegment, AiContext, SummarySegment } from './port'

const VIDEO: AiContext['video'] = { bvid: 'BV1xx', cid: 1, title: '测试视频', duration: 600 }

function segment(start: number, end: number, label: string): SummarySegment {
  return { start, end, label }
}

function ad(start: number, end: number): AdSegment {
  return { start, end, product_name: 'P', ad_content: '', confidence: 0.9 }
}

describe('mergeSegmentsWithAds', () => {
  it('无 ads：纯分段且按 start 排序', () => {
    const merged = mergeSegmentsWithAds(
      [segment(30, 60, '后'), segment(0, 30, '前')],
      [],
    )
    expect(merged.map((s) => s.label)).toEqual(['前', '后'])
    expect(merged.every((s) => !s.isAd)).toBe(true)
  })

  it('落入广告区间的分段打 isAd（重叠/包含/被包含均判定）', () => {
    const merged = mergeSegmentsWithAds(
      [
        segment(0, 20, '开场'),
        segment(20, 40, '恰饭段'), // 与广告完全重叠
        segment(100, 130, '含广告大段'), // 广告在其内部
        segment(180, 200, '后半程'),
      ],
      [ad(20, 40), ad(105, 120)],
    )
    expect(merged[0]).toMatchObject({ label: '开场', isAd: false })
    expect(merged[1]).toMatchObject({ label: '恰饭段', isAd: true })
    expect(merged[2]).toMatchObject({ label: '含广告大段', isAd: true })
    expect(merged[3]).toMatchObject({ label: '后半程', isAd: false })
  })

  it('首尾相接不算重叠（分段结束 = 广告开始）', () => {
    const merged = mergeSegmentsWithAds([segment(0, 20, '前')], [ad(20, 40)])
    expect(merged[0]?.isAd).toBe(false)
  })
})

describe('adSegmentLabel', () => {
  it('标区间提示（至 HH:MM:SS）', () => {
    expect(adSegmentLabel('恰饭段：某会员推广', 580)).toBe(
      '恰饭段：某会员推广（至 00:09:40）',
    )
  })

  it('已含「至」字不重复追加', () => {
    expect(adSegmentLabel('恰饭段（至 00:09:40）', 580)).toBe('恰饭段（至 00:09:40）')
  })
})

describe('parseCitation / splitCitations', () => {
  it('字幕记法：取引用点 mm:ss（含 ⧸ 行范围变体）', () => {
    expect(parseCitation('字幕', '12:30⧸12:30–13:05')).toEqual({
      kind: 'subtitle',
      seconds: 750,
      label: '字幕 12:30',
    })
    expect(parseCitation('字幕', '01:05–01:12')).toEqual({
      kind: 'subtitle',
      seconds: 65,
      label: '字幕 01:05',
    })
  })

  it('弹幕记法：123s 提取秒数（支持小数）', () => {
    expect(parseCitation('弹幕', '123s')).toEqual({ kind: 'danmaku', seconds: 123, label: '弹幕 123s' })
    expect(parseCitation('弹幕', '45.5s')).toEqual({ kind: 'danmaku', seconds: 45.5, label: '弹幕 45.5s' })
  })

  it('非法记法（无秒数/秒位超 59）回退 null', () => {
    expect(parseCitation('字幕', '不清楚')).toBeNull()
    expect(parseCitation('字幕', '12:99')).toBeNull()
    expect(parseCitation('弹幕', 'x')).toBeNull()
  })

  it('splitCitations 切成 markdown 与 citation 交替序列，无效记法保持原文', () => {
    const parts = splitCitations(
      '两处：〔字幕 12:30〕与〔弹幕 123s〕；〔字幕 到这里看不清〕留在文本里。',
    )
    expect(parts).toEqual([
      { type: 'markdown', markdown: '两处：' },
      { type: 'citation', citation: { kind: 'subtitle', seconds: 750, label: '字幕 12:30' } },
      { type: 'markdown', markdown: '与' },
      { type: 'citation', citation: { kind: 'danmaku', seconds: 123, label: '弹幕 123s' } },
      { type: 'markdown', markdown: '；〔字幕 到这里看不清〕留在文本里。' },
    ])
  })

  it('无记法的纯文本整体作为 markdown 段', () => {
    expect(splitCitations('普通回答。')).toEqual([{ type: 'markdown', markdown: '普通回答。' }])
  })
})

describe('trimChatHistory / buildContextUserMessage', () => {
  const context: AiContext = {
    video: VIDEO,
    subtitles: [{ start: 0, end: 2, text: '你好' }],
    danmaku: [],
    comments: [],
  }

  it('上下文首条经 buildChatMessages 装配（含字幕资料）', () => {
    const message = buildContextUserMessage(context)
    expect(message.role).toBe('user')
    expect(message.content).toContain('BV1xx')
    expect(message.content).toContain('[00:00] 你好')
  })

  it('未超上限原样返回副本', () => {
    const messages = Array.from({ length: 5 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `m${i}`,
    }))
    const trimmed = trimChatHistory(messages)
    expect(trimmed).toEqual(messages)
    expect(trimmed).not.toBe(messages)
  })

  it('超上限裁剪最旧轮次、保留上下文首条', () => {
    const messages = [
      { role: 'user' as const, content: 'ctx' },
      ...Array.from({ length: 30 }, (_, i) => ({
        role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `t${i}`,
      })),
    ]
    const trimmed = trimChatHistory(messages, CHAT_TURN_LIMIT)
    expect(trimmed.length).toBe(CHAT_TURN_LIMIT)
    expect(trimmed[0]?.content).toBe('ctx')
    // 最旧轮次被裁掉，最新轮次保留。
    expect(trimmed.map((m) => m.content)).not.toContain('t0')
    expect(trimmed.at(-1)?.content).toBe('t29')
  })

  it('上限边界：恰好上限不裁', () => {
    const messages = Array.from({ length: CHAT_TURN_LIMIT }, (_, i) => ({
      role: 'user' as const,
      content: `m${i}`,
    }))
    expect(trimChatHistory(messages)).toHaveLength(CHAT_TURN_LIMIT)
  })

  it('limit===1：只保留上下文首条（索引 0 永不被裁）', () => {
    const messages = [
      { role: 'user' as const, content: 'ctx' },
      { role: 'user' as const, content: 't1' },
      { role: 'assistant' as const, content: 't2' },
    ]
    expect(trimChatHistory(messages, 1)).toEqual([{ role: 'user', content: 'ctx' }])
  })
})

describe('panelErrorCopy（EXPERIENCE 文案表）', () => {
  it('network', () => {
    const copy = panelErrorCopy({ kind: 'network', message: 'x' })
    expect(copy.title).toBe('AI 掉线了，去看看端点设置？')
    expect(copy.hint).toContain('系统代理')
  })

  it('http 带状态码且 5xx 提示稍后重试', () => {
    expect(panelErrorCopy({ kind: 'http', status: 404, message: 'x' }).title).toBe(
      '端点返回了 404，去设置里看看？',
    )
    expect(panelErrorCopy({ kind: 'http', status: 502, message: 'x' }).hint).toContain('稍后重试')
  })

  it('auth / parse / config', () => {
    expect(panelErrorCopy({ kind: 'auth', message: 'x' }).title).toBe(
      'API Key 好像不对，去设置里核对一下？',
    )
    expect(panelErrorCopy({ kind: 'parse', message: 'x' }).title).toBe(
      'AI 的回答没看懂（格式不对），再试一次？',
    )
    const config = panelErrorCopy({ kind: 'config', message: 'x' })
    expect(config.title).toBe('还没配置端点，先去设置页填一下？')
    expect(config.withSettingsLink).toBe(true)
  })
})

describe('summaryAgoSeconds', () => {
  it('向下取整、负值归零', () => {
    expect(summaryAgoSeconds(10_000, 22_400)).toBe(12)
    expect(summaryAgoSeconds(10_000, 9_000)).toBe(0)
  })
})