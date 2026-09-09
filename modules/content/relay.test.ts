import { describe, expect, it, vi } from 'vitest'
import {
  MSG_AD_SKIP_PAGE_STATE,
  MSG_AD_SKIP_PAGE_TOGGLE,
  UNAVAILABLE_STATE,
} from './protocol'
import type { AdSkipPageState } from './protocol'
import { relayAdSkipMessage } from './relay'
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