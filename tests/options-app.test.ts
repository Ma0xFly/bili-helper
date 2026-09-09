// @vitest-environment happy-dom
// options 页 AI 助手组（本故事唯一用户界面）的组件级回归：
// 字段回填、mode 条件显示（server 字段仅 server/auto 可见）、保存写 storage 完整表单值。
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import App from '../entrypoints/options/App.vue'
import type { AiSettings } from '../modules/settings'

async function storedSettings(): Promise<AiSettings> {
  const result = await chrome.storage.sync.get('aiAssistantSettings')
  return result.aiAssistantSettings as AiSettings
}

function inputValue(el: Element): string {
  return (el as HTMLInputElement).value
}

describe('options AI 助手表单', () => {
  it('字段回填 + mode=server 显示服务器字段；切 local 隐藏；保存写入完整表单值', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: {
        apiUrl: 'https://chat.example/v1',
        model: 'gpt-4o-mini',
        apiKey: 'sk-chat',
        mode: 'server',
        serverBaseUrl: 'https://srv.example',
        serverToken: 'tok',
      },
    })

    const wrapper = mount(App)
    await flushPromises() // 等 onMounted 异步回填完成

    // 字段回填：对话 Base URL 与模型取到存储值。
    expect(inputValue(wrapper.find('input[type="url"]').element)).toBe('https://chat.example/v1')
    expect(inputValue(wrapper.find('input[list="chat-model-options"]').element)).toBe('gpt-4o-mini')
    expect(
      (wrapper.find('input[name="mode"][value="server"]').element as HTMLInputElement).checked,
    ).toBe(true)

    // mode=server：服务器字段可见且回填。
    const serverUrlInput = wrapper.find('input[placeholder="https://your-service.example.com"]')
    expect(serverUrlInput.exists()).toBe(true)
    expect(inputValue(serverUrlInput.element)).toBe('https://srv.example')

    // 切 mode=local：服务器字段整块隐藏。
    await wrapper.find('input[name="mode"][value="local"]').setValue()
    expect(wrapper.find('input[placeholder="https://your-service.example.com"]').exists()).toBe(false)

    // 点保存：storage 写入完整表单值（含改动后的 mode 与默认关的 adSkipEnabled）。
    await wrapper.find('button.primary').trigger('click')
    await flushPromises()
    const stored = await storedSettings()
    expect(stored).toEqual({
      apiUrl: 'https://chat.example/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-chat',
      embedBaseUrl: '',
      embedModel: '',
      embedKey: '',
      mode: 'local',
      serverBaseUrl: 'https://srv.example',
      serverToken: 'tok',
      adSkipEnabled: false,
    })
  })

  it('AI 去广告总开关回填并写回 schema', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: { adSkipEnabled: true },
    })

    const wrapper = mount(App)
    await flushPromises()

    const checkbox = wrapper.find('input[type="checkbox"]')
    expect((checkbox.element as HTMLInputElement).checked).toBe(true)

    await checkbox.setValue(false)
    await wrapper.find('button.primary').trigger('click')
    await flushPromises()
    expect((await storedSettings()).adSkipEnabled).toBe(false)
  })
})