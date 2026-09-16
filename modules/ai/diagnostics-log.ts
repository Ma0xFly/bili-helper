// AI 失败记录（诊断控制台的数据源）：总结/提问/去广告/探测失败时把
// kind、文案、原始响应摘录落 chrome.storage.local（环形 20 条，最新在前）。
// 红线：绝不落 API Key/Token（本层接触不到也存不进）；端点只存 baseUrl
// （本就不含凭据）；原始响应是模型自己的回答文本，截 400 字防止爆存储。
// 消费方：设置页「诊断记录」卡片，直观看错在哪一层（网络/鉴权/格式）。

import type { AiErrorKind } from '../shared/error'

const STORAGE_KEY = 'aiFailureLog'
/** 环形上限：够回看一次排障会话，又不至于把 storage.local 变成日志倾倒场。 */
const ENTRY_LIMIT = 20
/** 原始响应摘录上限（字符）。 */
const RAW_EXCERPT_LIMIT = 400

export type AiFailureFeature = '总结' | '提问' | '去广告' | '连通测试' | '模型列表'

export interface AiFailureEntry {
  /** 毫秒时间戳。 */
  time: number
  feature: AiFailureFeature
  kind: AiErrorKind
  message: string
  /** 原始响应摘录（截断）；请求没发出去/没响应体时缺省。 */
  rawExcerpt?: string
  /** 端点 baseUrl（不含凭据）。 */
  endpoint?: string
  model?: string
}

function sanitizeEntry(entry: AiFailureEntry): AiFailureEntry {
  return {
    time: Number.isFinite(entry.time) ? entry.time : Date.now(),
    feature: entry.feature,
    kind: entry.kind,
    message: entry.message.slice(0, 300),
    ...(entry.rawExcerpt && entry.rawExcerpt.trim() !== ''
      ? { rawExcerpt: entry.rawExcerpt.slice(0, RAW_EXCERPT_LIMIT) }
      : {}),
    ...(entry.endpoint && entry.endpoint.trim() !== '' ? { endpoint: entry.endpoint } : {}),
    ...(entry.model && entry.model.trim() !== '' ? { model: entry.model } : {}),
  }
}

function isEntry(value: unknown): value is AiFailureEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.time === 'number' && typeof entry.message === 'string'
}

/** 读最近失败（最新在前）；存储缺失/形状不符回空数组，排障入口永不抛错。 */
export async function readAiFailures(): Promise<AiFailureEntry[]> {
  const result = await chrome.storage.local.get({ [STORAGE_KEY]: [] })
  const list = (result as Record<string, unknown>)[STORAGE_KEY]
  if (!Array.isArray(list)) return []
  return list.filter(isEntry).slice(0, ENTRY_LIMIT)
}

/** 追加一条失败记录（最新在前），环形淘汰最旧。写失败静默：诊断记录不能拖垮主链路。 */
export async function recordAiFailure(entry: AiFailureEntry): Promise<void> {
  try {
    const current = await readAiFailures()
    await chrome.storage.local.set({
      [STORAGE_KEY]: [sanitizeEntry(entry), ...current].slice(0, ENTRY_LIMIT),
    })
  } catch {
    // 排障数据写入失败不影响业务链路。
  }
}

export async function clearAiFailures(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: [] })
}
