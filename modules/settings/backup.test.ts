// 配置备份测试：导出（密钥默认打码/可选包含、脏配置归一）、解析校验（坏 JSON/格式/版本）、
// 导入（逐项落库、打码密钥不覆盖本机、坏项跳过不整包拒绝）。
import { describe, expect, it } from 'vitest'
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  applyBackup,
  buildBackup,
  exportBackupText,
  maskSecrets,
  parseBackup,
} from './backup'
import { readAiSettings, writeAiSettings } from './index'
import { readFeatureConfigs, writeFeatureConfig } from '../features/config'
import { addUserCorpusEntry, readUserCorpus } from '../ai/rag/user-corpus'
import { AD_FEEDBACK_STORAGE_KEY } from '../content/ad-feedback'

async function seedSettings(): Promise<void> {
  await writeAiSettings({
    apiUrl: 'https://chat.example/v1',
    model: 'm-1',
    apiKey: 'sk-secret-chat',
    embedKey: 'sk-secret-embed',
    detectApiKey: 'sk-secret-detect',
    serverToken: 'tok-secret',
    adSkipEnabled: true,
  })
}

describe('导出', () => {
  it('默认打码密钥：导出文件里的四类密钥为空串，其余字段原样', async () => {
    await seedSettings()
    const backup = await buildBackup()
    expect(backup.format).toBe(BACKUP_FORMAT)
    expect(backup.version).toBe(BACKUP_VERSION)
    expect(backup.withSecrets).toBe(false)
    expect(backup.ai.apiKey).toBe('')
    expect(backup.ai.embedKey).toBe('')
    expect(backup.ai.detectApiKey).toBe('')
    expect(backup.ai.serverToken).toBe('')
    expect(backup.ai.apiUrl).toBe('https://chat.example/v1')
    expect(backup.ai.adSkipEnabled).toBe(true)
    // 导出的 JSON 文本里不得出现任何密钥明文。
    const text = await exportBackupText()
    expect(text).not.toContain('sk-secret')
    expect(text).not.toContain('tok-secret')
  })

  it('显式包含密钥：原样导出并标记 withSecrets', async () => {
    await seedSettings()
    const backup = await buildBackup({ withSecrets: true })
    expect(backup.withSecrets).toBe(true)
    expect(backup.ai.apiKey).toBe('sk-secret-chat')
    expect(backup.ai.serverToken).toBe('tok-secret')
  })

  it('maskSecrets 只清密钥字段', () => {
    const masked = maskSecrets({
      apiUrl: 'u',
      model: 'm',
      apiKey: 'k',
      apiFormat: 'openai',
      embedBaseUrl: '',
      embedModel: '',
      embedKey: 'ek',
      detectApiUrl: '',
      detectModel: '',
      detectApiKey: 'dk',
      detectApiFormat: 'inherit',
      mode: 'local',
      serverBaseUrl: 's',
      serverToken: 'st',
      adSkipEnabled: false,
      panelEnabled: true,
      chapterMarksEnabled: true,
    })
    expect(masked.apiKey).toBe('')
    expect(masked.embedKey).toBe('')
    expect(masked.detectApiKey).toBe('')
    expect(masked.serverToken).toBe('')
    expect(masked.apiUrl).toBe('u')
    expect(masked.serverBaseUrl).toBe('s')
  })

  it('功能配置逐项归一（脏配置收敛）,词库与反馈一并带上', async () => {
    await chrome.storage.local.set({
      biliHelperFeatures: {
        videoFilter: { enabled: true, config: { titleKeywords: ['带货', '带货', ''], viewMin: -5 } },
      },
    })
    await addUserCorpusEntry({ text: '某某品牌', category: 'scripts', note: '' })
    const backup = await buildBackup()
    expect(backup.features.videoFilter.enabled).toBe(true)
    expect(backup.features.videoFilter.config.titleKeywords).toEqual(['带货']) // 去重去空
    expect(backup.features.videoFilter.config.viewMin).toBeNull() // 负数收敛
    expect(backup.corpus.map((entry) => entry.text)).toEqual(['某某品牌'])
  })
})

describe('解析校验', () => {
  it('坏 JSON / 非对象 / 格式不符 / 版本过高 → 抛可读错误', () => {
    expect(() => parseBackup('{oops')).toThrow('不是合法的 JSON 文本')
    expect(() => parseBackup('[]')).toThrow('备份内容不是一个对象')
    expect(() => parseBackup(JSON.stringify({ format: 'other', version: 1 }))).toThrow(
      '不是 bili-helper 的备份文件',
    )
    expect(() => parseBackup(JSON.stringify({ format: BACKUP_FORMAT }))).toThrow('备份缺少版本信息')
    expect(() =>
      parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION + 1 })),
    ).toThrow('高于当前扩展支持')
  })

  it('合法备份原样返回', () => {
    const payload = parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 1 }))
    expect(payload.version).toBe(1)
  })
})

describe('导入', () => {
  const basePayload = {
    format: BACKUP_FORMAT,
    version: 1,
    ai: { apiUrl: 'https://new.example/v1', model: 'm-2', apiKey: '' },
    features: {
      videoFilter: {
        enabled: true,
        config: { titleKeywords: ['带货'], authorBlacklist: [], durationMinSeconds: 300 },
      },
    },
    corpus: [{ text: '限时国补' }],
    adFeedback: { 'BV1xx411c7mD:1': { cid: 1, notAds: [{ start: 10, end: 20 }], missedAds: [] } },
  }

  it('逐项落库并给出摘要；打码密钥不覆盖本机已有 Key', async () => {
    await seedSettings() // 本机有密钥
    const summary = await applyBackup(parseBackup(JSON.stringify(basePayload)))
    expect(summary.skipped).toEqual([])
    const settings = await readAiSettings()
    expect(settings.apiUrl).toBe('https://new.example/v1') // 非密钥字段照搬
    expect(settings.apiKey).toBe('sk-secret-chat') // 打码（空串）不覆盖
    const features = await readFeatureConfigs()
    expect(features.videoFilter.enabled).toBe(true)
    expect(features.videoFilter.config.titleKeywords).toEqual(['带货'])
    expect(features.videoFilter.config.durationMinSeconds).toBe(300)
    expect((await readUserCorpus()).map((entry) => entry.text)).toContain('限时国补')
    const raw = (await chrome.storage.local.get(AD_FEEDBACK_STORAGE_KEY)) as Record<string, unknown>
    expect(Object.keys(raw[AD_FEEDBACK_STORAGE_KEY] as Record<string, unknown>)).toEqual([
      'BV1xx411c7mD:1',
    ])
    expect(summary.applied.join(' ')).toContain('AI 端点')
    expect(summary.applied.join(' ')).toContain('广告词库')
  })

  it('包含密钥的备份：覆盖本机 Key', async () => {
    await seedSettings()
    await applyBackup({ ai: { apiKey: 'sk-from-backup', serverToken: 'tok-from-backup' } })
    const settings = await readAiSettings()
    expect(settings.apiKey).toBe('sk-from-backup')
    expect(settings.serverToken).toBe('tok-from-backup')
  })

  it('坏项跳过不整包拒绝：坏反馈条目丢弃，好项照常落库', async () => {
    const summary = await applyBackup({
      ai: { apiUrl: 'https://partial.example/v1' },
      features: { videoFilter: 'garbage' },
      adFeedback: {
        'BV1aa:1': { cid: 1, notAds: [{ start: 1, end: 5 }], missedAds: [] },
        'BV1bb:1': 'garbage',
      },
    })
    expect((await readAiSettings()).apiUrl).toBe('https://partial.example/v1')
    const raw = (await chrome.storage.local.get(AD_FEEDBACK_STORAGE_KEY)) as Record<string, unknown>
    expect(Object.keys(raw[AD_FEEDBACK_STORAGE_KEY] as Record<string, unknown>)).toEqual(['BV1aa:1'])
    expect(summary.applied.join(' ')).toContain('误判反馈 1 个视频')
  })

  it('全空备份：不报错、零 applied', async () => {
    const summary = await applyBackup({})
    expect(summary.applied).toEqual([])
    expect(summary.skipped).toEqual([])
  })

  it('导出 → 导入往返：功能规则与词库完整还原（本机密钥保持不变）', async () => {
    await seedSettings()
    await writeFeatureConfig('videoFilter', {
      titleKeywords: ['带货', '开箱'],
      durationMaxSeconds: 900,
      enabled: true,
    })
    const text = await exportBackupText()
    // 模拟新机器：清空功能配置，再导入。
    await chrome.storage.local.remove('biliHelperFeatures')
    await applyBackup(parseBackup(text))
    const features = await readFeatureConfigs()
    expect(features.videoFilter.config.titleKeywords).toEqual(['带货', '开箱'])
    expect(features.videoFilter.config.durationMaxSeconds).toBe(900)
    expect((await readAiSettings()).apiKey).toBe('sk-secret-chat')
  })
})