// @vitest-environment happy-dom
// popup 组件回归：两条快开关（AI 去广告 / 总结面板）状态回填、切换经 background 转发
// （消息类型与 payload 校验）、不可用态提示与禁用。browser API 全部 mock（wxt/browser）。
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MSG_AD_SKIP_PAGE_STATE,
  MSG_AD_SKIP_PAGE_TOGGLE,
  MSG_PANEL_PAGE_STATE,
  MSG_PANEL_PAGE_TOGGLE,
} from '../modules/content/protocol'

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      sendMessage: vi.fn(),
      openOptionsPage: vi.fn(async () => {}),
    },
  },
}))

// vi.mock 工厂被提升，以下导入拿到 mocked 模块。
import App from '../entrypoints/popup/App.vue'
import { browser } from 'wxt/browser'

const sendMessage = browser.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>

interface MockState {
  available?: boolean
  pageEnabled?: boolean
  masterEnabled?: boolean
}

function stateOf(base: MockState) {
  return {
    available: base.available ?? true,
    pageEnabled: base.pageEnabled ?? true,
    masterEnabled: base.masterEnabled ?? true,
  }
}

async function mountedPopup(ad: MockState = {}, panel: MockState = {}) {
  sendMessage.mockImplementation(async (message: unknown) => {
    const type = (message as { type?: unknown }).type
    if (type === MSG_AD_SKIP_PAGE_STATE) return stateOf(ad)
    if (type === MSG_PANEL_PAGE_STATE) return stateOf(panel)
    if (type === MSG_AD_SKIP_PAGE_TOGGLE || type === MSG_PANEL_PAGE_TOGGLE) {
      const target = type === MSG_AD_SKIP_PAGE_TOGGLE ? ad : panel
      return {
        ok: true,
        state: stateOf({ ...target, pageEnabled: (message as { enabled: boolean }).enabled }),
      }
    }
    throw new Error(`未知 popup 消息：${String(type)}`)
  })
  const wrapper = mount(App)
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('popup 快开关（AI 去广告 + 总结面板）', () => {
  it('两条开关按内容脚本状态回填（开态）', async () => {
    const wrapper = await mountedPopup({ pageEnabled: true }, { pageEnabled: true })
    const switches = wrapper.findAll('input[type="checkbox"]')
    expect(switches).toHaveLength(2)
    expect((switches[0]!.element as HTMLInputElement).checked).toBe(true)
    expect((switches[1]!.element as HTMLInputElement).checked).toBe(true)
    expect(wrapper.text()).toContain('本页自动跳过恰饭段')
    expect(wrapper.text()).toContain('本页显示总结 / 提问面板')
  })

  it('切换总结面板快开关 → 经 background 转发 panel-page-toggle', async () => {
    const wrapper = await mountedPopup({}, { pageEnabled: true })

    const panelSwitch = wrapper.findAll('input[type="checkbox"]')[1]!
    await panelSwitch.setValue(false)
    await flushPromises()

    expect(sendMessage).toHaveBeenCalledWith({ type: MSG_PANEL_PAGE_TOGGLE, enabled: false })

    // 响应回填：关态 + 「本页已隐藏」提示。
    expect((panelSwitch.element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.text()).toContain('本页已隐藏')
  })

  it('非视频页（不可用）：两条开关禁用 + 「当前页不是 B 站视频页」', async () => {
    const wrapper = await mountedPopup(
      { available: false, pageEnabled: false, masterEnabled: false },
      { available: false, pageEnabled: false, masterEnabled: false },
    )
    const switches = wrapper.findAll('input[type="checkbox"]')
    expect((switches[0]!.element as HTMLInputElement).disabled).toBe(true)
    expect((switches[1]!.element as HTMLInputElement).disabled).toBe(true)
    expect(wrapper.text()).toContain('当前页不是 B 站视频页')
  })

  it('设置页总开关关：对应开关禁用并提示', async () => {
    const wrapper = await mountedPopup(
      { pageEnabled: false, masterEnabled: false },
      { pageEnabled: false, masterEnabled: false },
    )
    expect(wrapper.text()).toContain('未在设置页开启 AI 去广告')
    expect(wrapper.text()).toContain('未在设置页开启 AI 面板')
    const switches = wrapper.findAll('input[type="checkbox"]')
    expect((switches[0]!.element as HTMLInputElement).disabled).toBe(true)
    expect((switches[1]!.element as HTMLInputElement).disabled).toBe(true)
  })
})
describe('今日拦截行（Epic1-S1.4）', () => {
  it('广告+推广统计合并显示；0 条不占行', async () => {
    const now = new Date()
    const pad = (value: number): string => String(value).padStart(2, '0')
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    await chrome.storage.local.set({
      biliHelperFeatureStats: {
        adVideoBlocker: { statsDate: today, totalBlocked: 3 },
        promotedVideoBlocker: { statsDate: today, totalBlocked: 2 },
      },
    })
    const wrapper = await mountedPopup()
    await flushPromises()
    expect(wrapper.text()).toContain('今日拦截推广 5 条')
    expect(wrapper.text()).toContain('广告 3')
    expect(wrapper.text()).toContain('小火箭 2')
  })

  it('没有拦截记录时不显示该行', async () => {
    const wrapper = await mountedPopup()
    await flushPromises()
    expect(wrapper.text()).not.toContain('今日拦截')
  })
})
