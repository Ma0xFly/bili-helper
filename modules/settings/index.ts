// settings 单一来源：AI 配置只存 chrome.storage.sync 的 aiAssistantSettings 键，
// 唯一读写走 readAiSettings()/writeAiSettings()；其他层禁止直接 storage.get 该键自造形状。

import type { ApiFormat } from '../ai/llm/client'

export type { ApiFormat }

export const STORAGE_KEY = 'aiAssistantSettings'

export type AiMode = 'local' | 'server' | 'auto'

export interface AiSettings {
  /** 对话端点（OpenAI 兼容或 Anthropic Messages）。 */
  apiUrl: string
  model: string
  apiKey: string
  /** 对话协议：openai（默认）/ anthropic。仅浏览器直连消费；服务器转发由服务端自身配置决定。 */
  apiFormat: ApiFormat
  /** 向量端点；三项为空时读取侧继承对话端点（不写回存储）。 */
  embedBaseUrl: string
  embedModel: string
  embedKey: string
  /**
   * 去广告专用端点（可选，省 token）：定界是约束很强的结构化任务，便宜模型够用。
   * 三项为空时读取侧继承对话端点；detectApiFormat='inherit' 时协议同继承结果。
   */
  detectApiUrl: string
  detectModel: string
  detectApiKey: string
  detectApiFormat: DetectApiFormat
  /** 后端分派唯一事实来源，值域 local/server/auto。 */
  mode: AiMode
  /** server 适配器端点/鉴权。 */
  serverBaseUrl: string
  serverToken: string
  /**
   * 去广告总开关：全新安装不自动跑，用户配好端点后手动开启。
   * popup 的「AI 去广告」快开关是页内临时开关，与此总开关正交。
   */
  adSkipEnabled: boolean
  /**
   * AI 面板（总结/提问）显隐总开关：默认 true——面板是被动 UI，无惊扰。
   * popup 的「总结面板」快开关是页内临时开关，与此总开关正交。
   */
  panelEnabled: boolean
  /**
   * 进度条章节标记（官方看点 + AI 总结时间线）总开关：默认 true——标记是被动 UI、
   * 官方看点零 token；AI 时间线只在用户手动点总结后才可能出现。
   */
  chapterMarksEnabled: boolean
}

export interface EmbeddingEndpoint {
  baseUrl: string
  model: string
  apiKey: string
}

/** 去广告专用端点的协议：inherit = 跟随对话端点（默认）。 */
export type DetectApiFormat = 'inherit' | ApiFormat

/** 去广告专用端点的解析结果（三项为空即继承对话端点）。 */
export interface DetectEndpoint {
  baseUrl: string
  model: string
  apiKey: string
  format: ApiFormat
}

export const DEFAULT_SETTINGS: AiSettings = {
  apiUrl: '',
  model: '',
  apiKey: '',
  apiFormat: 'openai',
  embedBaseUrl: '',
  embedModel: '',
  embedKey: '',
  detectApiUrl: '',
  detectModel: '',
  detectApiKey: '',
  detectApiFormat: 'inherit',
  mode: 'local',
  serverBaseUrl: '',
  serverToken: '',
  adSkipEnabled: false,
  panelEnabled: true,
  chapterMarksEnabled: true,
}

function isAiMode(value: unknown): value is AiMode {
  return value === 'local' || value === 'server' || value === 'auto'
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

// 输入鲁棒性：非法 mode 与非字符串字段一律收敛到默认，避免坏数据流入后续后端分派。
function normalizeSettings(raw: unknown): AiSettings {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  return {
    apiUrl: asString(source.apiUrl, DEFAULT_SETTINGS.apiUrl),
    model: asString(source.model, DEFAULT_SETTINGS.model),
    apiKey: asString(source.apiKey, DEFAULT_SETTINGS.apiKey),
    apiFormat: source.apiFormat === 'anthropic' ? 'anthropic' : 'openai',
    embedBaseUrl: asString(source.embedBaseUrl, DEFAULT_SETTINGS.embedBaseUrl),
    embedModel: asString(source.embedModel, DEFAULT_SETTINGS.embedModel),
    embedKey: asString(source.embedKey, DEFAULT_SETTINGS.embedKey),
    detectApiUrl: asString(source.detectApiUrl, DEFAULT_SETTINGS.detectApiUrl),
    detectModel: asString(source.detectModel, DEFAULT_SETTINGS.detectModel),
    detectApiKey: asString(source.detectApiKey, DEFAULT_SETTINGS.detectApiKey),
    detectApiFormat:
      source.detectApiFormat === 'openai' || source.detectApiFormat === 'anthropic'
        ? source.detectApiFormat
        : 'inherit',
    mode: isAiMode(source.mode) ? source.mode : DEFAULT_SETTINGS.mode,
    serverBaseUrl: asString(source.serverBaseUrl, DEFAULT_SETTINGS.serverBaseUrl),
    serverToken: asString(source.serverToken, DEFAULT_SETTINGS.serverToken),
    adSkipEnabled:
      typeof source.adSkipEnabled === 'boolean'
        ? source.adSkipEnabled
        : DEFAULT_SETTINGS.adSkipEnabled,
    panelEnabled:
      typeof source.panelEnabled === 'boolean' ? source.panelEnabled : DEFAULT_SETTINGS.panelEnabled,
    chapterMarksEnabled:
      typeof source.chapterMarksEnabled === 'boolean'
        ? source.chapterMarksEnabled
        : DEFAULT_SETTINGS.chapterMarksEnabled,
  }
}

export async function readAiSettings(): Promise<AiSettings> {
  // 对象形入参让 chrome.storage 在键缺失时回填默认值，缺失字段再经 normalizeSettings 收敛。
  const result = await chrome.storage.sync.get({ [STORAGE_KEY]: DEFAULT_SETTINGS })
  return normalizeSettings(result[STORAGE_KEY])
}

export async function writeAiSettings(partial: Partial<AiSettings>): Promise<AiSettings> {
  const current = await readAiSettings()
  const next = normalizeSettings({ ...current, ...partial })
  await chrome.storage.sync.set({ [STORAGE_KEY]: next })
  return next
}

// 逐字段继承：向量侧字段 trim 后仍为空才回落对话侧，非空时返回 trim 后的值，
// 避免空白包裹破坏后续 URL/fetch 构造。
export function resolveEmbeddingEndpoint(settings: AiSettings): EmbeddingEndpoint {
  return {
    baseUrl: settings.embedBaseUrl.trim() || settings.apiUrl,
    model: settings.embedModel.trim() || settings.model,
    apiKey: settings.embedKey.trim() || settings.apiKey,
  }
}

// 去广告专用端点：同样逐字段继承；协议 inherit 时跟随对话端点的协议。
// 单独存在只为一件事——把「定界」这类约束强的结构化任务交给更便宜的模型，省 token 不省精度。
export function resolveDetectEndpoint(settings: AiSettings): DetectEndpoint {
  return {
    baseUrl: settings.detectApiUrl.trim() || settings.apiUrl,
    model: settings.detectModel.trim() || settings.model,
    apiKey: settings.detectApiKey.trim() || settings.apiKey,
    format: settings.detectApiFormat === 'inherit' ? settings.apiFormat : settings.detectApiFormat,
  }
}

/** 是否配了独立的去广告端点（UI 提示与诊断展示用；不影响解析结果）。 */
export function hasDedicatedDetectEndpoint(settings: AiSettings): boolean {
  return (
    settings.detectApiUrl.trim() !== '' ||
    settings.detectModel.trim() !== '' ||
    settings.detectApiKey.trim() !== ''
  )
}