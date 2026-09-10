// popup ↔ 内容脚本消息转发的纯逻辑：background 只做依赖接线（查活动页/发消息），
// 判断与降级都可注入测试。三个分支：无活动页 → 不可用；转发异常 → 不可用；
// 正常转发按协议校验响应形状。「AI 去广告」与「总结面板」两条快开关共用同一机制。

import {
  MSG_AD_SKIP_PAGE_TOGGLE,
  MSG_PANEL_PAGE_TOGGLE,
  UNAVAILABLE_PANEL_STATE,
  UNAVAILABLE_STATE,
  isKnownMessage,
  isPageState,
  isPanelMessage,
  isPanelPageState,
  isPanelToggleResponse,
  isToggleResponse,
} from './protocol'
import type {
  AdSkipPageState,
  AdSkipToggleResponse,
  PanelPageState,
  PanelToggleResponse,
} from './protocol'

export interface RelayDeps {
  /** 查当前活动页 id；无可用 tab 时返回 undefined。 */
  queryActiveTab: () => Promise<number | undefined>
  /** 向指定 tab 发消息（内容脚本无响应时以异常表达）。 */
  sendToTab: (tabId: number, message: unknown) => Promise<unknown>
}

function isToggleType(message: unknown, toggleType: string): boolean {
  return (message as { type?: unknown }).type === toggleType
}

function unavailableFor(message: unknown): AdSkipToggleResponse | AdSkipPageState {
  return isToggleType(message, MSG_AD_SKIP_PAGE_TOGGLE)
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
    if (isToggleType(message, MSG_AD_SKIP_PAGE_TOGGLE)) {
      return isToggleResponse(response) ? response : { ok: false, state: UNAVAILABLE_STATE }
    }
    return isPageState(response) ? response : UNAVAILABLE_STATE
  } catch {
    // 内容脚本未挂载/页面已导航：按不可用降级。
    return unavailableFor(message)
  }
}

function unavailablePanelFor(message: unknown): PanelToggleResponse | PanelPageState {
  return isToggleType(message, MSG_PANEL_PAGE_TOGGLE)
    ? { ok: false, state: UNAVAILABLE_PANEL_STATE }
    : UNAVAILABLE_PANEL_STATE
}

export async function relayPanelMessage(
  message: unknown,
  deps: RelayDeps,
): Promise<PanelToggleResponse | PanelPageState> {
  const tabId = await deps.queryActiveTab()
  if (tabId === undefined) return unavailablePanelFor(message)
  try {
    const response = await deps.sendToTab(tabId, message)
    if (isToggleType(message, MSG_PANEL_PAGE_TOGGLE)) {
      return isPanelToggleResponse(response)
        ? response
        : { ok: false, state: UNAVAILABLE_PANEL_STATE }
    }
    return isPanelPageState(response) ? response : UNAVAILABLE_PANEL_STATE
  } catch {
    // 内容脚本未挂载/页面已导航：按不可用降级。
    return unavailablePanelFor(message)
  }
}

export type RoutedMessageResult =
  | AdSkipToggleResponse
  | AdSkipPageState
  | PanelToggleResponse
  | PanelPageState
  | undefined

/**
 * 消息路由单点：「AI 去广告」与「总结面板」两分支在此分派，未识别的消息返回 undefined
 * （background 一层即可接线为 onMessage 监听器，也便于单测覆盖两个分支）。
 */
export async function routeMessage(message: unknown, deps: RelayDeps): Promise<RoutedMessageResult> {
  if (isPanelMessage(message)) return relayPanelMessage(message, deps)
  if (isKnownMessage(message)) return relayAdSkipMessage(message, deps)
  return undefined
}