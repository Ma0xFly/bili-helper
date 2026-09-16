import { describe, expect, it, vi } from 'vitest'
import { clearAiFailures, readAiFailures, recordAiFailure } from './diagnostics-log'
import type { AiFailureEntry } from './diagnostics-log'

describe('AI 失败日志（诊断控制台数据源）', () => {
  it('记录并回读（最新在前）；重复读取不影响顺序', async () => {
    await clearAiFailures()
    await recordAiFailure({ time: 1000, feature: '总结', kind: 'parse', message: '响应不是合法 JSON', rawExcerpt: '不是JSON' })
    await recordAiFailure({ time: 2000, feature: '提问', kind: 'network', message: '请求超时' })
    const list = await readAiFailures()
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ feature: '提问', kind: 'network', time: 2000 })
    expect(list[1]).toMatchObject({ feature: '总结', kind: 'parse', rawExcerpt: '不是JSON' })
  })

  it('环形 20 条：第 21 条淘汰最旧', async () => {
    await clearAiFailures()
    for (let i = 0; i < 22; i++) {
      await recordAiFailure({ time: i, feature: '总结', kind: 'http', message: `失败 ${i}` })
    }
    const list = await readAiFailures()
    expect(list).toHaveLength(20)
    expect(list[0]).toMatchObject({ time: 21 })
    expect(list.at(-1)).toMatchObject({ time: 2 })
  })

  it('摘录与文案截断（400/300 字符），空字段不落', async () => {
    await clearAiFailures()
    await recordAiFailure({
      time: 1,
      feature: '总结',
      kind: 'parse',
      message: '长'.repeat(500),
      rawExcerpt: 'x'.repeat(600),
      endpoint: '  ',
      model: '',
    })
    const [entry] = await readAiFailures() as [AiFailureEntry]
    expect(entry.message).toHaveLength(300)
    expect(entry.rawExcerpt).toHaveLength(400)
    expect(entry.endpoint).toBeUndefined()
    expect(entry.model).toBeUndefined()
  })

  it('清空后回空数组；存储形状不符按空处理不抛错', async () => {
    await recordAiFailure({ time: 1, feature: '去广告', kind: 'network', message: 'x' })
    await clearAiFailures()
    expect(await readAiFailures()).toEqual([])

    await chrome.storage.local.set({ aiFailureLog: [{ bad: 1 }, 'junk', { time: 1, message: 'ok' }] })
    const list = await readAiFailures()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ message: 'ok' })
    await clearAiFailures()
  })

  it('写入失败静默（记录不能拖垮主链路）', async () => {
    const setMock = chrome.storage.local.set as unknown as ReturnType<typeof vi.fn>
    setMock.mockRejectedValueOnce(new Error('quota'))
    await expect(
      recordAiFailure({ time: 1, feature: '总结', kind: 'network', message: 'x' }),
    ).resolves.toBeUndefined()
    await clearAiFailures()
  })
})
