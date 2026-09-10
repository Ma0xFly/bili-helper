import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HOST,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_PORT,
  missingConfigReasons,
  readServerConfig,
} from './config'

describe('readServerConfig（环境变量 → 设置）', () => {
  it('六个 AI_* 变量按端上同一套字段落位，mode 强制 local', () => {
    const config = readServerConfig({
      AI_API_URL: ' https://chat.example/v1 ',
      AI_MODEL: 'gpt-4o-mini',
      AI_API_KEY: 'sk-chat',
      AI_EMBED_BASE_URL: 'https://emb.example',
      AI_EMBED_MODEL: 'bge-m3',
      AI_EMBED_API_KEY: 'sk-emb',
      AI_SERVER_TOKEN: 'tok',
    })
    expect(config.settings).toMatchObject({
      apiUrl: 'https://chat.example/v1', // 首尾空白被 trim
      model: 'gpt-4o-mini',
      apiKey: 'sk-chat',
      embedBaseUrl: 'https://emb.example',
      embedModel: 'bge-m3',
      embedKey: 'sk-emb',
      mode: 'local',
      serverBaseUrl: '',
      serverToken: '',
    })
    expect(config.token).toBe('tok')
  })

  it('mode 永远是 local：即使环境里写了 server/auto 也不能让服务端转发给自己', () => {
    // 环境变量里没有 mode 入口，这里钉死结果，防止有人日后把 mode 做成可配。
    expect(readServerConfig({ AI_API_URL: 'https://a', AI_MODEL: 'm' }).settings.mode).toBe('local')
  })

  it('缺省值：端口/监听地址/请求体上限/放行来源', () => {
    const config = readServerConfig({})
    expect(config.port).toBe(DEFAULT_PORT)
    expect(config.host).toBe(DEFAULT_HOST)
    expect(config.maxBodyBytes).toBe(DEFAULT_MAX_BODY_BYTES)
    expect(config.allowOrigin).toBe('*')
    expect(config.token).toBe('')
    expect(config.storageFile).toBe('')
  })

  it('非法数字（0/负数/非数字）回落默认，不产生 0 端口或 0 上限', () => {
    const config = readServerConfig({
      PORT: '0',
      AI_SERVER_MAX_BODY_BYTES: '-5',
    })
    expect(config.port).toBe(DEFAULT_PORT)
    expect(config.maxBodyBytes).toBe(DEFAULT_MAX_BODY_BYTES)
    expect(readServerConfig({ PORT: '9000' }).port).toBe(9000)
  })

  it('空白字符串等同未设置（不会把 "  " 当成端点地址）', () => {
    const config = readServerConfig({ AI_API_URL: '   ', AI_MODEL: '', AI_SERVER_ORIGIN: '  ' })
    expect(config.settings.apiUrl).toBe('')
    expect(config.allowOrigin).toBe('*')
  })

  it('启动体检：缺端点/模型时点名缺哪个变量', () => {
    expect(missingConfigReasons(readServerConfig({}))).toEqual([
      'AI_API_URL（对话端点 Base URL）',
      'AI_MODEL（对话模型名）',
    ])
    expect(missingConfigReasons(readServerConfig({ AI_API_URL: 'https://a' }))).toEqual([
      'AI_MODEL（对话模型名）',
    ])
    // API Key 可以为空（本地 Ollama 等无鉴权端点），不算缺配置。
    expect(
      missingConfigReasons(readServerConfig({ AI_API_URL: 'https://a', AI_MODEL: 'm' })),
    ).toEqual([])
  })
})
