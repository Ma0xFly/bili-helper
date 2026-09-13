// 配置方案存储层回归：保存/同名覆盖/应用合并（功能开关不动）/删除/上限淘汰/坏形状容错。
import { beforeEach, describe, expect, it } from 'vitest'
import { readAiSettings, writeAiSettings } from './index'
import {
  PROFILE_LIMIT,
  applyProfile,
  deleteProfile,
  profileSettingsOf,
  readAiProfiles,
  saveProfileFromCurrent,
} from './profiles'

beforeEach(async () => {
  await writeAiSettings({
    apiUrl: 'https://a.example/v1',
    model: 'm-a',
    apiKey: 'k-a',
    mode: 'local',
    adSkipEnabled: false,
    panelEnabled: true,
  })
})

async function storedProfiles(): Promise<unknown> {
  const result = await chrome.storage.sync.get('aiAssistantProfiles')
  return result.aiAssistantProfiles
}

describe('saveProfileFromCurrent（存为方案）', () => {
  it('快照连接字段；应用时整体覆盖回主设置，功能开关保持现状', async () => {
    // 给主设置带上非默认的功能开关与另一套端点，验证方案只搬连接字段。
    await writeAiSettings({ apiUrl: 'https://b.example/v1', model: 'm-b', adSkipEnabled: true })
    await saveProfileFromCurrent('B 端点')

    // 切到另一套配置（含不同功能开关），应用方案后连接字段还原、开关不动。
    await writeAiSettings({ apiUrl: 'https://c.example/v1', model: 'm-c', adSkipEnabled: false })
    const profiles = await readAiProfiles()
    expect(profiles).toHaveLength(1)
    const applied = await applyProfile(profiles[0]!.id)
    expect(applied.apiUrl).toBe('https://b.example/v1')
    expect(applied.model).toBe('m-b')
    expect(applied.adSkipEnabled).toBe(false) // 方案不带功能开关：保持当前值
    expect((await readAiSettings()).apiKey).toBe('k-a') // 继承自 beforeEach 的 Key 原样保留
  })

  it('空名单独抛错；同名覆盖而不是重复堆积', async () => {
    await expect(saveProfileFromCurrent('   ')).rejects.toThrow(/名字/)
    await saveProfileFromCurrent('A')
    await writeAiSettings({ apiUrl: 'https://x.example/v1' })
    const second = await saveProfileFromCurrent('A')
    expect(second).toHaveLength(1)
    expect(second[0]?.name).toBe('A')
    expect(second[0]?.settings.apiUrl).toBe('https://x.example/v1')
  })

  it('超上限淘汰最旧方案（存档语义：静默淘汰比报错可预期）', async () => {
    for (let index = 0; index <= PROFILE_LIMIT; index += 1) {
      await writeAiSettings({ model: `m-${index}` })
      await saveProfileFromCurrent(`方案${index}`)
    }
    const profiles = await readAiProfiles()
    expect(profiles).toHaveLength(PROFILE_LIMIT)
    expect(profiles.some((profile) => profile.name === '方案0')).toBe(false)
    expect(profiles.at(-1)?.name).toBe(`方案${PROFILE_LIMIT}`)
  })
})

describe('readAiProfiles（坏形状容错）', () => {
  it('存储损坏/形状不合法 → 空列表，不抛错', async () => {
    await chrome.storage.sync.set({ aiAssistantProfiles: { not: 'an array' } })
    expect(await readAiProfiles()).toEqual([])

    await chrome.storage.sync.set({ aiAssistantProfiles: 'broken' })
    expect(await readAiProfiles()).toEqual([])
  })

  it('条目缺 id/name 丢弃，其余归一保留；mode 非法回落 local', async () => {
    await chrome.storage.sync.set({
      aiAssistantProfiles: [
        { id: 'p1', name: '好的', savedAt: 123, settings: { apiUrl: 'https://z.example', mode: 'nope' } },
        { name: '缺 id', settings: {} },
        'junk',
      ],
    })
    const profiles = await readAiProfiles()
    expect(profiles).toHaveLength(1)
    expect(profiles[0]?.name).toBe('好的')
    expect(profiles[0]?.settings.mode).toBe('local')
    expect(profiles[0]?.settings.apiFormat).toBe('openai')
  })
})

describe('deleteProfile / applyProfile 边界', () => {
  it('删除后列表落盘；应用不存在的方案抛错', async () => {
    await saveProfileFromCurrent('临时')
    const profiles = await readAiProfiles()
    const next = await deleteProfile(profiles[0]!.id)
    expect(next).toEqual([])
    expect(await storedProfiles()).toEqual([])
    await expect(applyProfile('missing')).rejects.toThrow(/不存在/)
  })

  it('profileSettingsOf 只取连接字段（apiFormat 进方案，开关不进）', () => {
    const snapshot = profileSettingsOf({
      apiUrl: 'https://q.example/v1',
      model: 'm',
      apiKey: 'k',
      apiFormat: 'anthropic',
      embedBaseUrl: '',
      embedModel: '',
      embedKey: '',
      mode: 'server',
      serverBaseUrl: 'https://srv',
      serverToken: 't',
      adSkipEnabled: true,
      panelEnabled: false,
    } as Parameters<typeof profileSettingsOf>[0])
    expect(snapshot).toEqual({
      apiUrl: 'https://q.example/v1',
      model: 'm',
      apiKey: 'k',
      apiFormat: 'anthropic',
      embedBaseUrl: '',
      embedModel: '',
      embedKey: '',
      mode: 'server',
      serverBaseUrl: 'https://srv',
      serverToken: 't',
    })
  })
})
