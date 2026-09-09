// 消息协议：popup（快开关/成就行）经 background 转发给当前页内容脚本。
// 页内开关不跨页持久化；内容脚本不在视频页/未挂载时 background 返回兜底状态。

/** popup → background → 内容脚本 / 内容脚本 → background → popup 的消息类型。 */
export const MSG_AD_SKIP_PAGE_TOGGLE = 'bili-helper:ad-skip-page-toggle'
export const MSG_AD_SKIP_PAGE_STATE = 'bili-helper:ad-skip-page-state'

export interface AdSkipPageState {
  /** 内容脚本是否挂在视频页并响应。 */
  available: boolean
  /** 当前页临时开关（本页内生效，不持久化）。 */
  pageEnabled: boolean
  /** 设置页总开关（adSkipEnabled）。 */
  masterEnabled: boolean
}

export interface AdSkipToggleRequest {
  type: typeof MSG_AD_SKIP_PAGE_TOGGLE
  enabled: boolean
}

export interface AdSkipStateRequest {
  type: typeof MSG_AD_SKIP_PAGE_STATE
}

export interface AdSkipToggleResponse {
  ok: boolean
  state: AdSkipPageState
}

export const UNAVAILABLE_STATE: AdSkipPageState = {
  available: false,
  pageEnabled: false,
  masterEnabled: false,
}

export function isKnownMessage(value: unknown): value is AdSkipToggleRequest | AdSkipStateRequest {
  if (typeof value !== 'object' || value === null) return false
  const type = (value as { type?: unknown }).type
  return type === MSG_AD_SKIP_PAGE_TOGGLE || type === MSG_AD_SKIP_PAGE_STATE
}

export function isPageState(value: unknown): value is AdSkipPageState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Record<string, unknown>
  return (
    typeof state.available === 'boolean' &&
    typeof state.pageEnabled === 'boolean' &&
    typeof state.masterEnabled === 'boolean'
  )
}

export function isToggleResponse(value: unknown): value is AdSkipToggleResponse {
  if (typeof value !== 'object' || value === null) return false
  const response = value as Record<string, unknown>
  return typeof response.ok === 'boolean' && isPageState(response.state)
}