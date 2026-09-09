// popup ↔ 内容脚本消息转发的纯逻辑：background 只做依赖接线（查活动页/发消息），
// 判断与降级都可注入测试。三分支：无活动页 → 不可用；转发异常 → 不可用；
// 正常转发按协议校验响应形状。

import {
  MSG_AD_SKIP_PAGE_TOGGLE,
  UNAVAILABLE_STATE,
  isKnownMessage,
  isPageState,
  isToggleResponse,
} from './protocol'
import type { AdSkipPageState, AdSkipToggleResponse } from './protocol'

export interface RelayDeps {
  /** 查当前活动页 id；无可用 tab 时返回 undefined。 */
  queryActiveTab: () => Promise<number | undefined>
  /** 向指定 tab 发消息（内容脚本无响应时以异常表达）。 */
  sendToTab: (tabId: number, message: unknown) => Promise<unknown>
}

function unavailableFor(message: unknown): AdSkipToggleResponse | AdSkipPageState {
  return (message as { type?: unknown }).type === MSG_AD_SKIP_PAGE_TOGGLE
    ? { ok: false, state: UNAVAILABLE_STATE }
    : UNAVAILABLE_STATE
}

export async function relayAdSkipMessage(
  message: unknown,
  deps: RelayDeps,
): Promise<AdSkipToggleResponse | AdSkipPageState> {
  if (!isKnownMessage(message)) throw new Error('未知消息类型')
  const tabId = await deps.queryActiveTab()
  if (tabId === undefined) return unavailableFor(message)
  try {
    const response = await deps.sendToTab(tabId, message)
    if ((message as { type?: unknown }).type === MSG_AD_SKIP_PAGE_TOGGLE) {
      return isToggleResponse(response) ? response : { ok: false, state: UNAVAILABLE_STATE }
    }
    return isPageState(response) ? response : UNAVAILABLE_STATE
  } catch {
    // 内容脚本未挂载/页面已导航：按不可用降级。
    return unavailableFor(message)
  }
}