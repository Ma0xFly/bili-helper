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

// ---------- 去广告开销记录（成本可观测） ----------
// 「这次检测走了哪条路、花了多少 token」落同一存储区，设置页诊断控制台直接展示：
// 贵不贵是数据不是感觉。红线同上：只有计数与路径，没有任何凭据。

const COST_KEY = 'aiDetectCostLog'
const COST_LIMIT = 20

export interface DetectCostEntry {
  /** 毫秒时间戳。 */
  time: number
  bvid: string
  /** 检测路径：cache=缓存命中（0 token）/ consensus=双源强一致免 LLM / llm / fulltext / retrieval / none。 */
  path: string
  /** 对话请求次数。 */
  llmCalls: number
  /** token 用量（端点未回 usage 时缺省）。 */
  inputTokens?: number
  outputTokens?: number
  /** 检测耗时（毫秒）。 */
  elapsedMs: number
  /** 识别出的广告段数与可自动跳过数。 */
  ads: number
  skippable: number
}

function isCostEntry(value: unknown): value is DetectCostEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.time === 'number' && typeof entry.path === 'string'
}

/** 读最近检测开销（最新在前）；读失败回空数组。 */
export async function readDetectCosts(): Promise<DetectCostEntry[]> {
  try {
    const result = await chrome.storage.local.get({ [COST_KEY]: [] })
    const list = (result as Record<string, unknown>)[COST_KEY]
    if (!Array.isArray(list)) return []
    return list.filter(isCostEntry).slice(0, COST_LIMIT)
  } catch {
    return []
  }
}

/** 追加一条开销记录（最新在前），环形淘汰。写失败静默。 */
export async function recordDetectCost(entry: DetectCostEntry): Promise<void> {
  const sanitized: DetectCostEntry = {
    time: Number.isFinite(entry.time) ? entry.time : Date.now(),
    bvid: String(entry.bvid ?? '').slice(0, 32),
    path: String(entry.path ?? '').slice(0, 16),
    llmCalls: Math.max(0, Math.round(entry.llmCalls) || 0),
    ...(Number.isFinite(entry.inputTokens) ? { inputTokens: Math.max(0, Math.round(entry.inputTokens as number)) } : {}),
    ...(Number.isFinite(entry.outputTokens) ? { outputTokens: Math.max(0, Math.round(entry.outputTokens as number)) } : {}),
    elapsedMs: Math.max(0, Math.round(entry.elapsedMs) || 0),
    ads: Math.max(0, Math.round(entry.ads) || 0),
    skippable: Math.max(0, Math.round(entry.skippable) || 0),
  }
  try {
    const current = await readDetectCosts()
    await chrome.storage.local.set({
      [COST_KEY]: [sanitized, ...current].slice(0, COST_LIMIT),
    })
  } catch {
    // 开销记录写入失败不影响业务链路。
  }
}
