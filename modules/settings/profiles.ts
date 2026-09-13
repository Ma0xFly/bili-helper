// 配置方案（多套端点方案）：把「连接设置」存成命名快照，一键换家。
// 与主设置的关系：aiAssistantSettings 永远是运行时唯一事实来源；方案只是
// 连接字段的存档，应用 = 把快照字段合并回主设置（功能开关不属于方案，保持原样）。

import {
  readAiSettings,
  writeAiSettings,
  type AiMode,
  type AiSettings,
} from './index'
import type { ApiFormat } from '../ai/llm/client'

export const PROFILES_STORAGE_KEY = 'aiAssistantProfiles'
/** 上限：整份列表是 sync 存储里的单个键（单键 8KB 配额），10 套绰绰有余。 */
export const PROFILE_LIMIT = 10

/** 方案快照覆盖的连接字段：端点/Key/模型/协议/运行模式/服务器。功能开关不在内。 */
export interface AiProfileSettings {
  apiUrl: string
  model: string
  apiKey: string
  apiFormat: ApiFormat
  embedBaseUrl: string
  embedModel: string
  embedKey: string
  mode: AiMode
  serverBaseUrl: string
  serverToken: string
}

export interface AiProfile {
  id: string
  name: string
  savedAt: number
  settings: AiProfileSettings
}

const PROFILE_FIELDS = [
  'apiUrl',
  'model',
  'apiKey',
  'apiFormat',
  'embedBaseUrl',
  'embedModel',
  'embedKey',
  'mode',
  'serverBaseUrl',
  'serverToken',
] as const

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isAiMode(value: unknown): value is AiMode {
  return value === 'local' || value === 'server' || value === 'auto'
}

function normalizeProfileSettings(source: unknown): AiProfileSettings {
  const record = typeof source === 'object' && source !== null ? (source as Record<string, unknown>) : {}
  return {
    apiUrl: asString(record.apiUrl),
    model: asString(record.model),
    apiKey: asString(record.apiKey),
    apiFormat: record.apiFormat === 'anthropic' ? 'anthropic' : 'openai',
    embedBaseUrl: asString(record.embedBaseUrl),
    embedModel: asString(record.embedModel),
    embedKey: asString(record.embedKey),
    mode: isAiMode(record.mode) ? record.mode : 'local',
    serverBaseUrl: asString(record.serverBaseUrl),
    serverToken: asString(record.serverToken),
  }
}

/** 从主设置抽取连接字段（单点定义，字段增减只改 PROFILE_FIELDS）。 */
export function profileSettingsOf(settings: AiSettings): AiProfileSettings {
  const source = settings as unknown as Record<string, unknown>
  const snapshot: Record<string, unknown> = {}
  for (const field of PROFILE_FIELDS) snapshot[field] = source[field]
  return normalizeProfileSettings(snapshot)
}

/** 读回方案列表：坏形状逐条丢弃，整体损坏视为空列表（方案坏了不该拖垮设置页）。 */
export async function readAiProfiles(): Promise<AiProfile[]> {
  try {
    const result = await chrome.storage.sync.get(PROFILES_STORAGE_KEY)
    const raw = result[PROFILES_STORAGE_KEY]
    if (!Array.isArray(raw)) return []
    const profiles: AiProfile[] = []
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      const id = asString(record.id)
      const name = asString(record.name).trim()
      if (id === '' || name === '') continue
      profiles.push({
        id,
        name,
        savedAt: typeof record.savedAt === 'number' && Number.isFinite(record.savedAt) ? record.savedAt : 0,
        settings: normalizeProfileSettings(record.settings),
      })
    }
    return profiles
  } catch {
    return []
  }
}

function newId(): string {
  // crypto.randomUUID 现代浏览器全支持；拿不到就用时间戳兜底（同毫秒碰撞无实害）。
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `p-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * 把当前主设置的连接字段存成方案。同名覆盖（更新快照与时间）而不是重复堆积；
 * 超上限淘汰最旧的方案（存档语义下静默淘汰比报错打断更可预期）。
 */
export async function saveProfileFromCurrent(rawName: string): Promise<AiProfile[]> {
  const name = rawName.trim()
  if (name === '') throw new Error('先给方案起个名字')
  const profiles = await readAiProfiles()
  const settings = profileSettingsOf(await readAiSettings())
  const existing = profiles.find((profile) => profile.name === name)
  const profile: AiProfile = {
    id: existing?.id ?? newId(),
    name,
    savedAt: Date.now(),
    settings,
  }
  const next = existing
    ? profiles.map((item) => (item.id === profile.id ? profile : item))
    : [...profiles, profile]
  const trimmed = next.length > PROFILE_LIMIT ? next.slice(next.length - PROFILE_LIMIT) : next
  await chrome.storage.sync.set({ [PROFILES_STORAGE_KEY]: trimmed })
  return trimmed
}

export async function deleteProfile(id: string): Promise<AiProfile[]> {
  const profiles = await readAiProfiles()
  const next = profiles.filter((profile) => profile.id !== id)
  await chrome.storage.sync.set({ [PROFILES_STORAGE_KEY]: next })
  return next
}

/** 应用方案：连接字段整体覆盖回主设置（功能开关保持现状），返回合并后的主设置。 */
export async function applyProfile(id: string): Promise<AiSettings> {
  const profiles = await readAiProfiles()
  const profile = profiles.find((item) => item.id === id)
  if (!profile) throw new Error('方案不存在或已被删除')
  return writeAiSettings(profile.settings)
}
