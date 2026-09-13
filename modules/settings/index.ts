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
}

export interface EmbeddingEndpoint {
  baseUrl: string
  model: string
  apiKey: string
}

export const DEFAULT_SETTINGS: AiSettings = {
  apiUrl: '',
  model: '',
  apiKey: '',
  apiFormat: 'openai',
  embedBaseUrl: '',
  embedModel: '',
  embedKey: '',
  mode: 'local',
  serverBaseUrl: '',
  serverToken: '',
  adSkipEnabled: false,
  panelEnabled: true,
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
    mode: isAiMode(source.mode) ? source.mode : DEFAULT_SETTINGS.mode,
    serverBaseUrl: asString(source.serverBaseUrl, DEFAULT_SETTINGS.serverBaseUrl),
    serverToken: asString(source.serverToken, DEFAULT_SETTINGS.serverToken),
    adSkipEnabled:
      typeof source.adSkipEnabled === 'boolean'
        ? source.adSkipEnabled
        : DEFAULT_SETTINGS.adSkipEnabled,
    panelEnabled:
      typeof source.panelEnabled === 'boolean' ? source.panelEnabled : DEFAULT_SETTINGS.panelEnabled,
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