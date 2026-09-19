// 配置备份（导出 / 导入）：把「攒了很久的东西」一键带走——AI 端点与方案、功能开关与
// 八维筛选规则、补录的广告词库、误判反馈。换浏览器、重装、多设备同步都用得上。
//
// 密钥默认打码：导出文件里 apiKey/embedKey/detectApiKey/serverToken 一律替换为 ''，
// 需要连密钥一起搬的用户显式勾选「包含密钥」（文案里说明这是明文）。
// 导入语义：逐项校验，坏项跳过、好项落库（不整包拒绝——备份文件部分损坏不该让用户全丢）；
// 打码字段（''）不覆盖本机已有密钥——这正是「不含密钥的备份」能被两台机器共用的原因。

import { FEATURE_IDS, FEATURE_REGISTRY, writeFeatureConfig } from '../features/config'
import type { FeatureConfigMap } from '../features/config'
import { addUserCorpusEntries, readUserCorpus } from '../ai/rag/user-corpus'
import type { UserCorpusEntry } from '../ai/rag/user-corpus'
import { readAiSettings, writeAiSettings } from './index'
import type { AiSettings } from './index'
import { readAiProfiles } from './profiles'
import type { AiProfile } from './profiles'
import {
  AD_FEEDBACK_STORAGE_KEY,
  normalizeAdFeedback,
  type AdFeedback,
} from '../content/ad-feedback'

export const BACKUP_FORMAT = 'bili-helper-backup'
export const BACKUP_VERSION = 1

/** 备份里的密钥字段（默认打码为 ''；勾选「包含密钥」则原样导出）。 */
const SECRET_FIELDS = ['apiKey', 'embedKey', 'detectApiKey', 'serverToken'] as const

export interface BackupPayload {
  format: typeof BACKUP_FORMAT
  version: number
  exportedAt: string
  /** 是否包含明文密钥（导入侧提示与自检用）。 */
  withSecrets: boolean
  ai: Partial<AiSettings>
  profiles: AiProfile[]
  features: FeatureConfigMap
  corpus: UserCorpusEntry[]
  adFeedback: Record<string, AdFeedback>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 打码：密钥字段替换为空串（其余原样）。 */
export function maskSecrets(settings: AiSettings): Partial<AiSettings> {
  const out: Record<string, unknown> = { ...settings }
  for (const field of SECRET_FIELDS) out[field] = ''
  return out as Partial<AiSettings>
}

/** 生成备份对象（导出主入口）。withSecrets=false 时密钥字段打码。 */
export async function buildBackup(
  options: { withSecrets?: boolean; now?: () => Date } = {},
): Promise<BackupPayload> {
  const withSecrets = options.withSecrets === true
  const now = options.now ?? (() => new Date())
  const settings = await readAiSettings()
  const profiles = await readAiProfiles()
  const raw = (await chrome.storage.local.get(null)) as Record<string, unknown>
  const feedbackRaw = isRecord(raw[AD_FEEDBACK_STORAGE_KEY]) ? raw[AD_FEEDBACK_STORAGE_KEY] : {}
  const adFeedback: Record<string, AdFeedback> = {}
  for (const [key, value] of Object.entries(feedbackRaw)) {
    const entry = normalizeAdFeedback(value)
    if (entry !== null) adFeedback[key] = entry
  }
  const featureRaw = isRecord(raw.biliHelperFeatures) ? raw.biliHelperFeatures : {}
  // 中间用宽类型收集（mapped-type 逐键赋值要过一次收敛），出口整体归到精确形状。
  const features: Record<string, { config: unknown; enabled: boolean }> = {}
  for (const id of FEATURE_IDS) {
    const record = isRecord(featureRaw[id]) ? (featureRaw[id] as Record<string, unknown>) : {}
    // 读侧归一走注册表（脏配置收敛到默认值），保证导出的文件永远是可导入的形状。
    const normalized = FEATURE_REGISTRY[id].normalize(isRecord(record.config) ? record.config : {})
    features[id] = {
      config: { ...FEATURE_REGISTRY[id].defaults, ...normalized },
      enabled: record.enabled === true,
    }
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now().toISOString(),
    withSecrets,
    ai: withSecrets ? { ...settings } : maskSecrets(settings),
    profiles,
    features: features as FeatureConfigMap,
    corpus: await readUserCorpus(),
    adFeedback,
  }
}

/** 导出文本（带缩进的 JSON，方便人工查看与 diff）。 */
export async function exportBackupText(options: { withSecrets?: boolean } = {}): Promise<string> {
  return JSON.stringify(await buildBackup(options), null, 2)
}

// ---------- 导入 ----------

export interface ImportSummary {
  /** 导入成功的项（文案直接展示，如「对话端点」「视频筛选规则」）。 */
  applied: string[]
  /** 跳过的项与原因（坏数据不整包拒绝）。 */
  skipped: string[]
}

/** 解析与格式校验：非 JSON / format 不符 / version 高于本版 → 抛可读错误。
 * 返回宽类型记录——内容形状由 applyBackup 逐项校验（坏项跳过，不整包拒绝）。 */
export function parseBackup(text: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('不是合法的 JSON 文本')
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) {
    // 数组也是对象但绝不是备份：直接按格式不符处理（比「不是一个对象」更贴近用户所见）。
    throw new Error('备份内容不是一个对象')
  }
  if (parsed.format !== BACKUP_FORMAT) throw new Error('不是 bili-helper 的备份文件')
  const version = typeof parsed.version === 'number' ? parsed.version : 0
  if (version < 1) throw new Error('备份缺少版本信息')
  if (version > BACKUP_VERSION) {
    throw new Error(`备份版本（v${version}）高于当前扩展支持的 v${BACKUP_VERSION}，请先升级扩展`)
  }
  return parsed
}

/**
 * 应用导入：AI 端点、配置方案、功能开关与规则、广告词库、误判反馈逐项落库。
 * 返回 applied/skipped 摘要——部分坏数据不影响其余项落库。
 */
export async function applyBackup(payload: unknown): Promise<ImportSummary> {
  const applied: string[] = []
  const skipped: string[] = []
  const source: Record<string, unknown> = isRecord(payload) ? payload : {}

  // 1) AI 设置：只搬备份里出现的字段（打码的空串不覆盖本机密钥）。
  if (isRecord(source.ai)) {
    const patch: Record<string, unknown> = {}
    const current = await readAiSettings()
    for (const [key, value] of Object.entries(source.ai)) {
      if (!(key in current)) continue
      if (value === undefined || value === null) continue
      if ((SECRET_FIELDS as readonly string[]).includes(key) && value === '') continue
      patch[key] = value
    }
    if (Object.keys(patch).length > 0) {
      try {
        await writeAiSettings(patch as Partial<AiSettings>)
        applied.push('AI 端点与开关')
      } catch (error) {
        skipped.push(`AI 端点（${error instanceof Error ? error.message : String(error)}）`)
      }
    }
  }

  // 2) 配置方案：备份里有的整体替换（同名去重保留备份版本）。
  if (Array.isArray(source.profiles) && source.profiles.length > 0) {
    try {
      const valid = source.profiles.filter(
        (profile: unknown): profile is AiProfile =>
          isRecord(profile) && profile.name !== '' && isRecord(profile.settings),
      )
      if (valid.length > 0) {
        await chrome.storage.sync.set({ aiAssistantProfiles: valid })
        applied.push(`配置方案 ${valid.length} 套`)
      }
    } catch {
      skipped.push('配置方案（写入失败）')
    }
  }

  // 3) 功能开关与配置：逐功能经 writeFeatureConfig 写入（读侧归一保证形状）。
  if (isRecord(source.features)) {
    let count = 0
    for (const id of FEATURE_IDS) {
      const entry = (source.features as Record<string, unknown>)[id]
      if (!isRecord(entry)) continue
      try {
        await writeFeatureConfig(id, {
          ...(isRecord(entry.config) ? entry.config : {}),
          enabled: entry.enabled === true,
        } as never)
        count += 1
      } catch {
        skipped.push(`功能 ${FEATURE_REGISTRY[id].title}`)
      }
    }
    if (count > 0) applied.push(`功能开关与规则 ${count} 项`)
  }

  // 4) 广告词库：经 addUserCorpusEntries 逐条校验并入（重复自动跳过）。
  if (Array.isArray(source.corpus) && source.corpus.length > 0) {
    try {
      const result = await addUserCorpusEntries({
        texts: source.corpus
          .filter((item: unknown): item is UserCorpusEntry => isRecord(item) && typeof item.text === 'string')
          .map((item) => item.text),
        category: 'scripts',
        note: '配置导入',
      })
      if (result.ok) applied.push(`广告词库 ${result.added} 条`)
      else skipped.push(`广告词库（${result.reason}）`)
    } catch {
      skipped.push('广告词库（写入失败）')
    }
  }

  // 5) 误判反馈：按视频条目合并（同 bvid:cid 以备份为准）。
  if (isRecord(source.adFeedback)) {
    const existing = (await chrome.storage.local.get(AD_FEEDBACK_STORAGE_KEY)) as Record<string, unknown>
    const map: Record<string, AdFeedback> = {}
    for (const [key, value] of Object.entries(
      isRecord(existing[AD_FEEDBACK_STORAGE_KEY]) ? (existing[AD_FEEDBACK_STORAGE_KEY] as Record<string, unknown>) : {},
    )) {
      const entry = normalizeAdFeedback(value)
      if (entry !== null) map[key] = entry
    }
    let count = 0
    for (const [key, value] of Object.entries(source.adFeedback as Record<string, unknown>)) {
      const entry = normalizeAdFeedback(value)
      if (entry === null) continue
      map[key] = entry
      count += 1
    }
    if (count > 0) {
      try {
        await chrome.storage.local.set({ [AD_FEEDBACK_STORAGE_KEY]: map })
        applied.push(`广告误判反馈 ${count} 个视频`)
      } catch {
        skipped.push('广告误判反馈（写入失败）')
      }
    }
  }

  return { applied, skipped }
}