import { describe, expect, it } from 'vitest'
import type { AiSettings } from './index'
import {
  DEFAULT_SETTINGS,
  readAiSettings,
  resolveEmbeddingEndpoint,
  writeAiSettings,
} from './index'

describe('readAiSettings', () => {
  it('首读无存储返回含默认值的完整 settings', async () => {
    expect(await readAiSettings()).toEqual(DEFAULT_SETTINGS)
    expect((await readAiSettings()).mode).toBe('local')
  })

  it('非法 mode（bogus）收敛到默认 local', async () => {
    await chrome.storage.sync.set({ aiAssistantSettings: { mode: 'bogus' } })
    const settings = await readAiSettings()
    expect(settings.mode).toBe('local')
  })

  it('非字符串字段收敛到默认值', async () => {
    await chrome.storage.sync.set({ aiAssistantSettings: { apiUrl: 42, mode: 'server' } })
    const settings = await readAiSettings()
    expect(settings.apiUrl).toBe('')
    expect(settings.mode).toBe('server')
  })

  it('adSkipEnabled 默认 false（全新安装不自动跑）', async () => {
    expect((await readAiSettings()).adSkipEnabled).toBe(false)
  })

  it('adSkipEnabled 非布尔值收敛到默认 false', async () => {
    await chrome.storage.sync.set({ aiAssistantSettings: { adSkipEnabled: 1 } })
    expect((await readAiSettings()).adSkipEnabled).toBe(false)
  })

  it('adSkipEnabled 持久化开合', async () => {
    await writeAiSettings({ adSkipEnabled: true })
    expect((await readAiSettings()).adSkipEnabled).toBe(true)
    await writeAiSettings({ adSkipEnabled: false })
    expect((await readAiSettings()).adSkipEnabled).toBe(false)
  })

  it('panelEnabled 默认 true（面板是被动 UI）', async () => {
    expect((await readAiSettings()).panelEnabled).toBe(true)
  })

  it('panelEnabled 非布尔值收敛到默认 true', async () => {
    await chrome.storage.sync.set({ aiAssistantSettings: { panelEnabled: 'yes' } })
    expect((await readAiSettings()).panelEnabled).toBe(true)
  })

  it('panelEnabled 持久化开合', async () => {
    await writeAiSettings({ panelEnabled: false })
    expect((await readAiSettings()).panelEnabled).toBe(false)
    await writeAiSettings({ panelEnabled: true })
    expect((await readAiSettings()).panelEnabled).toBe(true)
  })
})

describe('writeAiSettings', () => {
  it('部分字段写入，缺失字段回落默认', async () => {
    await writeAiSettings({ mode: 'server' })
    const settings = await readAiSettings()
    expect(settings.mode).toBe('server')
    expect(settings.apiUrl).toBe('')
    expect(settings.embedBaseUrl).toBe('')
  })

  it('写入合并不丢已有键', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: { apiUrl: 'https://chat', apiKey: 'chat-key' },
    })
    await writeAiSettings({ model: 'gpt-4' })
    const settings = await readAiSettings()
    expect(settings.apiUrl).toBe('https://chat')
    expect(settings.apiKey).toBe('chat-key')
    expect(settings.model).toBe('gpt-4')
  })
})

describe('resolveEmbeddingEndpoint', () => {
  it('三字段全空时继承对话端点，且不回写存储', async () => {
    await writeAiSettings({ apiUrl: 'https://chat', model: 'gpt-4', apiKey: 'chat-key' })
    const settings = await readAiSettings()
    expect(resolveEmbeddingEndpoint(settings)).toEqual({
      baseUrl: 'https://chat',
      model: 'gpt-4',
      apiKey: 'chat-key',
    })

    const stored = await chrome.storage.sync.get('aiAssistantSettings')
    expect((stored.aiAssistantSettings as AiSettings).embedBaseUrl).toBe('')
  })

  it('逐字段继承：部分字段留空各自回落对话侧', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      apiUrl: 'https://chat',
      model: 'gpt-4',
      apiKey: 'chat-key',
      embedModel: 'text-embedding',
    }
    const resolved = resolveEmbeddingEndpoint(settings)
    expect(resolved.baseUrl).toBe('https://chat')
    expect(resolved.model).toBe('text-embedding')
    expect(resolved.apiKey).toBe('chat-key')
  })

  it('trim 后空串按空处理继承', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      apiUrl: 'https://chat',
      embedBaseUrl: '   ',
      embedKey: '\t',
    }
    const resolved = resolveEmbeddingEndpoint(settings)
    expect(resolved.baseUrl).toBe('https://chat')
    expect(resolved.apiKey).toBe('')
  })

  it('非空时返回 trim 后的值', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      embedBaseUrl: '  https://emb.example  ',
      embedModel: '\ttext-embedding\n',
      embedKey: 'emb-key',
    }
    const resolved = resolveEmbeddingEndpoint(settings)
    expect(resolved.baseUrl).toBe('https://emb.example')
    expect(resolved.model).toBe('text-embedding')
    expect(resolved.apiKey).toBe('emb-key')
  })
})