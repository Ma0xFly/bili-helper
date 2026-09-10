import { describe, expect, it, vi } from 'vitest'
import {
  MSG_AD_SKIP_PAGE_STATE,
  MSG_AD_SKIP_PAGE_TOGGLE,
  MSG_PANEL_PAGE_STATE,
  MSG_PANEL_PAGE_TOGGLE,
  UNAVAILABLE_PANEL_STATE,
  UNAVAILABLE_STATE,
  isPanelMessage,
  isPanelPageState,
  isPanelToggleResponse,
} from './protocol'
import type { AdSkipPageState } from './protocol'
import { relayAdSkipMessage, relayPanelMessage, routeMessage } from './relay'
import type { RelayDeps } from './relay'

const PAGE_STATE: AdSkipPageState = { available: true, pageEnabled: true, masterEnabled: true }

function depsOf(overrides: Partial<RelayDeps>): RelayDeps {
  return {
    queryActiveTab: vi.fn(async () => 7),
    sendToTab: vi.fn(async () => PAGE_STATE),
    ...overrides,
  }
}

describe('relayAdSkipMessage（三分支）', () => {
  it('有活动页且内容脚本响应合法：透传状态', async () => {
    const sendToTab = vi.fn(async () => PAGE_STATE)
    const result = await relayAdSkipMessage(
      { type: MSG_AD_SKIP_PAGE_STATE },
      depsOf({ sendToTab }),
    )
    expect(result).toEqual(PAGE_STATE)
    expect(sendToTab).toHaveBeenCalledWith(7, { type: MSG_AD_SKIP_PAGE_STATE })
  })

  it('无活动页：状态查询回不可用、toggle 回 ok:false', async () => {
    const result = await relayAdSkipMessage(
      { type: MSG_AD_SKIP_PAGE_STATE },
      depsOf({ queryActiveTab: vi.fn(async () => undefined) }),
    )
    expect(result).toEqual(UNAVAILABLE_STATE)

    const toggle = await relayAdSkipMessage(
      { type: MSG_AD_SKIP_PAGE_TOGGLE, enabled: true },
      depsOf({ queryActiveTab: vi.fn(async () => undefined) }),
    )
    expect(toggle).toEqual({ ok: false, state: UNAVAILABLE_STATE })
  })

  it('转发异常（内容脚本未挂载）：按不可用降级，不向上抛', async () => {
    const result = await relayAdSkipMessage(
      { type: MSG_AD_SKIP_PAGE_STATE },
      depsOf({ sendToTab: vi.fn(async () => Promise.reject(new Error('no receiver'))) }),
    )
    expect(result).toEqual(UNAVAILABLE_STATE)
  })

  it('响应形状不合法：toggle 回 ok:false、状态查询回不可用', async () => {
    const toggle = await relayAdSkipMessage(
      { type: MSG_AD_SKIP_PAGE_TOGGLE, enabled: false },
      depsOf({ sendToTab: vi.fn(async () => ({ whatever: true })) }),
    )
    expect(toggle).toEqual({ ok: false, state: UNAVAILABLE_STATE })

    const state = await relayAdSkipMessage(
      { type: MSG_AD_SKIP_PAGE_STATE },
      depsOf({ sendToTab: vi.fn(async () => 'nope') }),
    )
    expect(state).toEqual(UNAVAILABLE_STATE)
  })

  it('未知消息类型上抛（background 已先过滤，属编程错误）', async () => {
    await expect(
      relayAdSkipMessage({ type: 'unknown' }, depsOf({})),
    ).rejects.toThrow('未知消息类型')
  })
})

describe('总结面板消息协议与转发（relayPanelMessage）', () => {
  const PANEL_PAGE_STATE = { available: true, pageEnabled: true, masterEnabled: true }

  it('isPanelMessage 只认 panel 两消息、不混认去广告消息', () => {
    expect(isPanelMessage({ type: MSG_PANEL_PAGE_STATE })).toBe(true)
    expect(isPanelMessage({ type: MSG_PANEL_PAGE_TOGGLE, enabled: true })).toBe(true)
    expect(isPanelMessage({ type: MSG_AD_SKIP_PAGE_STATE })).toBe(false)
    expect(isPanelMessage(null)).toBe(false)
    expect(isPanelMessage({ type: 'unknown' })).toBe(false)
  })

  it('isPanelPageState / isPanelToggleResponse 形状校验', () => {
    expect(isPanelPageState(PANEL_PAGE_STATE)).toBe(true)
    expect(isPanelPageState({ available: true })).toBe(false)
    expect(isPanelToggleResponse({ ok: true, state: PANEL_PAGE_STATE })).toBe(true)
    expect(isPanelToggleResponse({ ok: true, state: { available: true } })).toBe(false)
    expect(isPanelToggleResponse('nope')).toBe(false)
  })

  it('有活动页且内容脚本响应合法：state 透传（发送物按原消息类型）', async () => {
    const sendToTab = vi.fn(async () => PANEL_PAGE_STATE)
    const result = await relayPanelMessage(
      { type: MSG_PANEL_PAGE_STATE },
      depsOf({ sendToTab }),
    )
    expect(result).toEqual(PANEL_PAGE_STATE)
    expect(sendToTab).toHaveBeenCalledWith(7, { type: MSG_PANEL_PAGE_STATE })

    const toggle = await relayPanelMessage(
      { type: MSG_PANEL_PAGE_TOGGLE, enabled: false },
      depsOf({ sendToTab: vi.fn(async () => ({ ok: true, state: PANEL_PAGE_STATE })) }),
    )
    expect(toggle).toEqual({ ok: true, state: PANEL_PAGE_STATE })
  })

  it('无活动页：状态查询回不可用、toggle 回 ok:false', async () => {
    const noTab = depsOf({ queryActiveTab: vi.fn(async () => undefined) })
    expect(await relayPanelMessage({ type: MSG_PANEL_PAGE_STATE }, noTab)).toEqual(
      UNAVAILABLE_PANEL_STATE,
    )
    expect(
      await relayPanelMessage({ type: MSG_PANEL_PAGE_TOGGLE, enabled: true }, noTab),
    ).toEqual({ ok: false, state: UNAVAILABLE_PANEL_STATE })
  })

  it('转发异常与坏形状：按不可用降级，不向上抛', async () => {
    const failing = depsOf({ sendToTab: vi.fn(async () => Promise.reject(new Error('no receiver'))) })
    expect(await relayPanelMessage({ type: MSG_PANEL_PAGE_STATE }, failing)).toEqual(
      UNAVAILABLE_PANEL_STATE,
    )
    const badShape = await relayPanelMessage(
      { type: MSG_PANEL_PAGE_TOGGLE, enabled: true },
      depsOf({ sendToTab: vi.fn(async () => ({ whatever: true })) }),
    )
    expect(badShape).toEqual({ ok: false, state: UNAVAILABLE_PANEL_STATE })
  })
})

describe('routeMessage（background 单点接线）', () => {
  it('ad-skip 分支：状态查询路由到去广告转发', async () => {
    const sendToTab = vi.fn(async () => PAGE_STATE)
    const result = await routeMessage({ type: MSG_AD_SKIP_PAGE_STATE }, depsOf({ sendToTab }))
    expect(result).toEqual(PAGE_STATE)
    expect(sendToTab).toHaveBeenCalledWith(7, { type: MSG_AD_SKIP_PAGE_STATE })
  })

  it('panel 分支：状态查询路由到面板转发', async () => {
    const panelState = { available: true, pageEnabled: true, masterEnabled: true }
    const sendToTab = vi.fn(async () => panelState)
    const result = await routeMessage({ type: MSG_PANEL_PAGE_STATE }, depsOf({ sendToTab }))
    expect(result).toEqual(panelState)
    expect(sendToTab).toHaveBeenCalledWith(7, { type: MSG_PANEL_PAGE_STATE })
  })

  it('panel 分支三分支回退：无活动页/转发异常 → 不可用', async () => {
    expect(
      await routeMessage(
        { type: MSG_PANEL_PAGE_STATE },
        depsOf({ queryActiveTab: vi.fn(async () => undefined) }),
      ),
    ).toEqual(UNAVAILABLE_PANEL_STATE)
    expect(
      await routeMessage(
        { type: MSG_PANEL_PAGE_TOGGLE, enabled: true },
        depsOf({ sendToTab: vi.fn(async () => Promise.reject(new Error('no receiver'))) }),
      ),
    ).toEqual({ ok: false, state: UNAVAILABLE_PANEL_STATE })
  })

  it('未知消息返回 undefined（background 不响应）', async () => {
    expect(await routeMessage({ type: 'unknown' }, depsOf({}))).toBeUndefined()
    expect(await routeMessage(null, depsOf({}))).toBeUndefined()
  })
})