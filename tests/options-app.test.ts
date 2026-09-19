// @vitest-environment happy-dom
// options 页 AI 助手组的组件级回归：字段回填、运行模式的开关化表达（开关关=local、
// 开=server、回退勾上=auto）、向量端点默认折叠、保存写 storage 完整表单值。
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../entrypoints/options/App.vue'
import { AD_SIGNAL_CORPUS } from '../modules/ai/rag/corpus'
import { readUserCorpus } from '../modules/ai/rag/user-corpus'
import type { AiSettings } from '../modules/settings'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 体检用 fetch 桩：记录被探测的地址，按路径回最小可用响应。 */
function stubProbeFetch(): string[] {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) => {
      const target = String(url)
      calls.push(target)
      if (target.includes('/embeddings')) {
        return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1] }] }), { status: 200 })
      }
      if (target.includes('/ai/health')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), {
        status: 200,
      })
    }),
  )
  return calls
}

function findButton(wrapper: ReturnType<typeof mount>, text: string) {
  const button = wrapper.findAll('button').find((item) => item.text().includes(text))
  if (!button) throw new Error(`找不到按钮：${text}`)
  return button
}

async function storedSettings(): Promise<AiSettings> {
  const result = await chrome.storage.sync.get('aiAssistantSettings')
  return result.aiAssistantSettings as AiSettings
}

function inputValue(el: Element): string {
  return (el as HTMLInputElement).value
}

const SERVER_URL_PLACEHOLDER = 'https://your-service.example.com'

describe('options AI 助手表单', () => {
  it('字段回填 + 服务器开关态；关掉开关即 local 且服务器字段消失', async () => {
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
    expect(inputValue(wrapper.find('input[aria-label="对话模型"]').element)).toBe('gpt-4o-mini')

    // mode=server → 服务器开关为开，字段可见且回填，回退子开关为关。
    const serverSwitch = wrapper.find('input[aria-label="使用自己的服务器"]')
    expect((serverSwitch.element as HTMLInputElement).checked).toBe(true)
    const serverUrlInput = wrapper.find(`input[placeholder="${SERVER_URL_PLACEHOLDER}"]`)
    expect(serverUrlInput.exists()).toBe(true)
    expect(inputValue(serverUrlInput.element)).toBe('https://srv.example')
    expect(
      (wrapper.find('input[aria-label="服务器失败时回退直连"]').element as HTMLInputElement).checked,
    ).toBe(false)

    // 关掉服务器开关 → 服务器字段整块消失（v-if），模式落回 local。
    await serverSwitch.setValue(false)
    expect(wrapper.find(`input[placeholder="${SERVER_URL_PLACEHOLDER}"]`).exists()).toBe(false)

    // 点保存：storage 写入完整表单值（含改动后的 mode、默认关的 adSkipEnabled、
    // 默认开的 panelEnabled 与 chapterMarksEnabled；服务器地址保留，便于再开回来）。
    await wrapper.find('button.primary').trigger('click')
    await flushPromises()
    expect(await storedSettings()).toEqual({
      apiUrl: 'https://chat.example/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-chat',
      apiFormat: 'openai',
      embedBaseUrl: '',
      embedModel: '',
      embedKey: '',
      detectApiUrl: '',
      detectModel: '',
      detectApiKey: '',
      detectApiFormat: 'inherit',
      mode: 'local',
      serverBaseUrl: 'https://srv.example',
      serverToken: 'tok',
      adSkipEnabled: false,
      panelEnabled: true,
      chapterMarksEnabled: true,
    })
  })

  it('mode=auto 回填为「开关开 + 回退勾上」；取消回退保存即 server', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: { mode: 'auto', serverBaseUrl: 'https://srv.example' },
    })

    const wrapper = mount(App)
    await flushPromises()

    expect(
      (wrapper.find('input[aria-label="使用自己的服务器"]').element as HTMLInputElement).checked,
    ).toBe(true)
    const fallback = wrapper.find('input[aria-label="服务器失败时回退直连"]')
    expect((fallback.element as HTMLInputElement).checked).toBe(true)

    await fallback.setValue(false)
    await wrapper.find('button.primary').trigger('click')
    await flushPromises()
    expect((await storedSettings()).mode).toBe('server')
  })

  it('开启服务器开关默认落 server；再勾回退落 auto（无需认识模式术语）', async () => {
    const wrapper = mount(App)
    await flushPromises()

    // 默认 local：服务器字段不渲染，回退开关也无处可点。
    expect(wrapper.find(`input[placeholder="${SERVER_URL_PLACEHOLDER}"]`).exists()).toBe(false)

    await wrapper.find('input[aria-label="使用自己的服务器"]').setValue(true)
    await wrapper.find('button.primary').trigger('click')
    await flushPromises()
    expect((await storedSettings()).mode).toBe('server')

    await wrapper.find('input[aria-label="服务器失败时回退直连"]').setValue(true)
    await wrapper.find('button.primary').trigger('click')
    await flushPromises()
    expect((await storedSettings()).mode).toBe('auto')
  })

  it('关掉服务器开关后重开，回退意愿不丢（仍为 auto）', async () => {
    await chrome.storage.sync.set({ aiAssistantSettings: { mode: 'auto' } })

    const wrapper = mount(App)
    await flushPromises()

    const serverSwitch = wrapper.find('input[aria-label="使用自己的服务器"]')
    await serverSwitch.setValue(false)
    await serverSwitch.setValue(true)
    expect(
      (wrapper.find('input[aria-label="服务器失败时回退直连"]').element as HTMLInputElement).checked,
    ).toBe(true)

    await wrapper.find('button.primary').trigger('click')
    await flushPromises()
    expect((await storedSettings()).mode).toBe('auto')
  })

  it('向量端点默认折叠（继承对话端点），展开后字段可编辑并随保存写回', async () => {
    const wrapper = mount(App)
    await flushPromises()

    // happy-dom 下 isVisible() 不可靠，直接断言 v-show 写入的内联 display。
    const advanced = wrapper.find('#advanced-embed')
    expect((advanced.element as HTMLElement).style.display).toBe('none')
    expect(wrapper.find('input[aria-label="嵌入模型"]').exists()).toBe(true)

    const toggle = wrapper.find('button[aria-controls="advanced-embed"]')
    expect(toggle.text()).toContain('向量端点')
    await toggle.trigger('click')
    expect((advanced.element as HTMLElement).style.display).not.toBe('none')
    expect(toggle.text()).toContain('收起')

    const embedModel = wrapper.find('input[aria-label="嵌入模型"]')
    await embedModel.setValue('bge-m3')
    await wrapper.find('button.primary').trigger('click')
    await flushPromises()
    expect((await storedSettings()).embedModel).toBe('bge-m3')
  })

  it('广告词库：补录 → 列表出现 → 重复红灯 → 删除消失', async () => {
    const wrapper = mount(App)
    await flushPromises()

    expect(wrapper.text()).toContain(`内置 ${AD_SIGNAL_CORPUS.length} 条`)
    expect(wrapper.text()).toContain('你还没有补录词条')

    await wrapper.find('input[aria-label="补录词条"]').setValue('某新品牌')
    await wrapper.find('select[aria-label="词条品类"]').setValue('brands-digital')
    await wrapper.find('input[aria-label="词条来源备注"]').setValue('BV1xx 03:20 漏检')
    await findButton(wrapper, '补录').trigger('click')
    await flushPromises()

    expect(wrapper.find('.corpus-word').text()).toBe('某新品牌')
    expect(wrapper.find('.corpus-tag').text()).toBe('brands-digital')
    expect(wrapper.find('.corpus-note').text()).toContain('BV1xx')
    expect(wrapper.text()).toContain('已补录「某新品牌」')

    // 同词重复补录：红灯说明原因，不产生第二条。
    await wrapper.find('input[aria-label="补录词条"]').setValue('某新品牌')
    await findButton(wrapper, '补录').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('已经在你的词库里')
    expect(wrapper.findAll('.corpus-item')).toHaveLength(1)

    // 内置词库已有的词同样拦下。
    await wrapper.find('input[aria-label="补录词条"]').setValue('恰饭')
    await findButton(wrapper, '补录').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('内置词库已经有这个词')

    await wrapper.find('button[aria-label="删除 某新品牌"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.corpus-word').exists()).toBe(false)
    expect(await readUserCorpus()).toEqual([])
  })

  it('广告词库：清空补录', async () => {
    await chrome.storage.local.set({
      biliHelperUserCorpus: [
        { text: '词A', category: 'scripts', kind: 'script', weight: 2, note: '', createdAt: 'x' },
        { text: '词B', category: 'deals', kind: 'deal', weight: 2, note: '', createdAt: 'x' },
      ],
    })

    const wrapper = mount(App)
    await flushPromises()
    expect(wrapper.findAll('.corpus-item')).toHaveLength(2)

    await findButton(wrapper, '清空补录').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.corpus-item')).toHaveLength(0)
    expect(await readUserCorpus()).toEqual([])
  })

  it('广告词库：导出入库 patch（格式与 corpus/*.md 同构，可复制走审核入库）', async () => {
    await chrome.storage.local.set({
      biliHelperUserCorpus: [
        {
          text: '某新品牌',
          category: 'brands-digital',
          kind: 'brand',
          weight: 1,
          note: 'BV1xx 03:20 漏检',
          createdAt: 'x',
        },
      ],
    })
    // 剪贴板不可用是常态（无焦点/权限），必须降级到文本框手动复制而不是报错。
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
      configurable: true,
    })

    const wrapper = mount(App)
    await flushPromises()
    expect(wrapper.find('textarea[aria-label="导出的词库 patch"]').exists()).toBe(false)

    await findButton(wrapper, '导出入库 patch').trigger('click')
    await flushPromises()

    const patch = wrapper.find('textarea[aria-label="导出的词库 patch"]')
    expect(patch.exists()).toBe(true)
    const value = (patch.element as HTMLTextAreaElement).value
    expect(value).toContain('# —— brands-digital.md ——')
    expect(value).toContain('# 来源：BV1xx 03:20 漏检')
    expect(value).toContain('某新品牌')
    expect(wrapper.findAll('.feedback.warn')).toHaveLength(1)
  })

  it('服务商预设：选中即填地址、模型占位随预设切换；手改地址回落「自定义」', async () => {
    const wrapper = mount(App)
    await flushPromises()

    const select = wrapper.find('select[aria-label="服务商预设"]')
    await select.setValue('DeepSeek')
    const baseUrl = wrapper.find('input[type="url"]')
    expect(inputValue(baseUrl.element)).toBe('https://api.deepseek.com/v1')
    // 模型输入的占位符换成该服务商的推荐名（只是提示，不写入表单值）。
    expect(wrapper.find('input[aria-label="对话模型"]').attributes('placeholder')).toBe(
      'deepseek-chat',
    )
    // 下拉反显当前命中的预设（computed 从地址反推）。
    expect((select.element as HTMLSelectElement).value).toBe('DeepSeek')

    // 手动改地址：预设回落「自定义」，占位符回到通用默认。
    await baseUrl.setValue('https://my-proxy.example/v1')
    const after = wrapper.find('select[aria-label="服务商预设"]')
    expect((after.element as HTMLSelectElement).value).toBe('custom')
    expect(wrapper.find('input[aria-label="对话模型"]').attributes('placeholder')).toBe(
      'gpt-4o-mini',
    )
    // 保存后表单值保持手动填的地址，不被预设覆盖。
    await wrapper.find('button.primary').trigger('click')
    await flushPromises()
    expect((await storedSettings()).apiUrl).toBe('https://my-proxy.example/v1')
  })

  it('内联对话测试：只发对话请求，就地报绿；不碰服务器与向量', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: {
        mode: 'local',
        apiUrl: 'https://chat.example/v1',
        model: 'm-1',
        apiKey: 'k-1',
      },
    })
    const calls = stubProbeFetch()

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.find('button[aria-label="测试对话端点"]').trigger('click')
    await flushPromises()

    expect(calls).toContain('https://chat.example/v1/chat/completions')
    expect(calls.some((url) => url.includes('/embeddings') || url.includes('/ai/health'))).toBe(false)
    const feedback = wrapper.findAll('.feedback')
    expect(feedback).toHaveLength(1)
    expect(feedback[0]?.classes()).toContain('ok')
    expect(feedback[0]?.text()).toContain('连接成功')
    expect(feedback[0]?.text()).toContain('m-1')
  })

  it('内联服务器测试：探 /ai/health，开关没开时按钮不存在', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: { mode: 'local', serverBaseUrl: 'https://srv.example', serverToken: 'tok' },
    })
    const calls = stubProbeFetch()

    const wrapper = mount(App)
    await flushPromises()
    expect(wrapper.find('button[aria-label="测试服务器连接"]').exists()).toBe(false)

    await wrapper.find('input[aria-label="使用自己的服务器"]').setValue(true)
    await wrapper.find('button[aria-label="测试服务器连接"]').trigger('click')
    await flushPromises()

    expect(calls).toEqual(['https://srv.example/ai/health'])
    expect(wrapper.find('.feedback.ok')?.text()).toContain('连接成功')
  })

  it('内联服务器测试：未提供体检接口报黄灯，不当成失败', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: { mode: 'server', serverBaseUrl: 'https://srv.example' },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.find('button[aria-label="测试服务器连接"]').trigger('click')
    await flushPromises()

    const feedback = wrapper.find('.feedback')
    expect(feedback.classes()).toContain('warn')
    expect(feedback.text()).toContain('未提供体检接口')
  })

  it('内联测试运行中按钮禁用；结果只反映最新一轮，不累积', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: {
        mode: 'local',
        apiUrl: 'https://chat.example/v1',
        model: 'm-1',
        apiKey: 'k',
      },
    })
    let releaseFirst: ((response: Response) => void) | undefined
    let invocation = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        invocation += 1
        // 第一轮挂住，验证按钮进入禁用态（防重入，也就防住了迟到结果覆盖新一轮）。
        if (invocation === 1) return new Promise<Response>((resolve) => { releaseFirst = resolve })
        return new Response('{"error":"nope"}', { status: 401 })
      }),
    )

    const wrapper = mount(App)
    await flushPromises()
    const button = wrapper.find('button[aria-label="测试对话端点"]')
    await button.trigger('click')
    expect(button.text()).toContain('测试中')
    expect((button.element as HTMLButtonElement).disabled).toBe(true)

    releaseFirst?.(new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), { status: 200 }))
    await flushPromises()
    expect(wrapper.findAll('.feedback')).toHaveLength(1)
    expect(wrapper.find('.feedback.ok')?.text()).toContain('连接成功')
    expect((wrapper.find('button[aria-label="测试对话端点"]').element as HTMLButtonElement).disabled).toBe(false)

    // 第二轮（401）：旧绿灯必须被替换，而不是两条并排堆着。
    await wrapper.find('button[aria-label="测试对话端点"]').trigger('click')
    await flushPromises()
    const feedback = wrapper.findAll('.feedback')
    expect(feedback).toHaveLength(1)
    expect(feedback[0]?.classes()).toContain('fail')
  })

  it('内联对话测试：红灯给出可执行原因，按钮从「测试中…」恢复', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: { mode: 'local', apiUrl: 'https://chat.example/v1', model: 'm-1', apiKey: 'bad' },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"nope"}', { status: 401 })))

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.find('button[aria-label="测试对话端点"]').trigger('click')
    await flushPromises()

    const feedback = wrapper.find('.feedback')
    expect(feedback.classes()).toContain('fail')
    expect(feedback.text()).toContain('未授权')
    const button = wrapper.find('button[aria-label="测试对话端点"]')
    expect(button.text()).toBe('测试连接')
    expect((button.element as HTMLButtonElement).disabled).toBe(false)
  })

  it('内联对话测试：没填 Base URL / 模型时直接提示，不发网络请求', async () => {
    const calls = stubProbeFetch()
    const wrapper = mount(App)
    await flushPromises()
    await wrapper.find('button[aria-label="测试对话端点"]').trigger('click')
    await flushPromises()

    expect(calls).toHaveLength(0)
    expect(wrapper.find('.feedback.fail')?.text()).toContain('请先填写 Base URL 和模型')
  })

  it('内联向量测试：继承对话端点配置就地探测，通过报绿', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: {
        mode: 'local',
        apiUrl: 'https://chat.example/v1',
        model: 'm-1',
        apiKey: 'k',
        embedBaseUrl: 'https://emb.example',
        embedModel: 'bge-m3',
      },
    })
    const calls = stubProbeFetch()

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.find('button[aria-controls="advanced-embed"]').trigger('click')
    await wrapper.find('button[aria-label="测试向量端点"]').trigger('click')
    await flushPromises()

    expect(calls).toContain('https://emb.example/embeddings')
    expect(wrapper.find('.feedback.ok')?.text()).toContain('bge-m3')
  })

  it('内联向量测试：失败报红并给出原因', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: {
        mode: 'local',
        apiUrl: 'https://chat.example/v1',
        model: 'm-1',
        apiKey: 'k',
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"boom"}', { status: 500 })),
    )

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.find('button[aria-controls="advanced-embed"]').trigger('click')
    await wrapper.find('button[aria-label="测试向量端点"]').trigger('click')
    await flushPromises()

    const feedback = wrapper.find('.feedback')
    expect(feedback.classes()).toContain('fail')
    expect(feedback.text()).toContain('连接失败')
  })

  it('内联服务器测试：红灯给出可执行原因', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: { mode: 'server', serverBaseUrl: 'https://srv.example', serverToken: 'bad' },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.find('button[aria-label="测试服务器连接"]').trigger('click')
    await flushPromises()

    const feedback = wrapper.find('.feedback')
    expect(feedback.classes()).toContain('fail')
    expect(feedback.text()).toContain('连接失败')
    expect(feedback.text()).toContain('Server Token')
  })

  it('内联测试用表单当前值：改了地址没保存也测新地址', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: { mode: 'local', apiUrl: 'https://old.example/v1', model: 'm-1', apiKey: 'k' },
    })
    const calls = stubProbeFetch()

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.find('input[type="url"]').setValue('https://new.example/v1')
    await wrapper.find('button[aria-label="测试对话端点"]').trigger('click')
    await flushPromises()

    expect(calls).toContain('https://new.example/v1/chat/completions')
    expect(calls.some((url) => url.includes('old.example'))).toBe(false)
  })

  it('AI 去广告总开关回填并写回 schema', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: { adSkipEnabled: true },
    })

    const wrapper = mount(App)
    await flushPromises()

    const checkbox = wrapper.find('input[aria-label="AI 去广告总开关"]')
    expect((checkbox.element as HTMLInputElement).checked).toBe(true)

    await checkbox.setValue(false)
    await wrapper.find('button.primary').trigger('click')
    await flushPromises()
    expect((await storedSettings()).adSkipEnabled).toBe(false)
  })

  it('AI 面板显示开关默认开、回填并写回 schema', async () => {
    const wrapper = mount(App)
    await flushPromises()

    const checkbox = wrapper.find('input[aria-label="AI 面板显示总开关"]')
    expect((checkbox.element as HTMLInputElement).checked).toBe(true)

    await checkbox.setValue(false)
    await wrapper.find('button.primary').trigger('click')
    await flushPromises()
    expect((await storedSettings()).panelEnabled).toBe(false)
  })

  it('存储的 panelEnabled=false 回填为关', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: { panelEnabled: false },
    })

    const wrapper = mount(App)
    await flushPromises()

    const checkbox = wrapper.find('input[aria-label="AI 面板显示总开关"]')
    expect((checkbox.element as HTMLInputElement).checked).toBe(false)
  })

  it('章节标记开关默认开、回填并写回 schema', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: { chapterMarksEnabled: false },
    })

    const wrapper = mount(App)
    await flushPromises()

    const checkbox = wrapper.find('input[aria-label="进度条章节标记总开关"]')
    expect((checkbox.element as HTMLInputElement).checked).toBe(false)

    await checkbox.setValue(true)
    await wrapper.find('button.primary').trigger('click')
    await flushPromises()
    expect((await storedSettings()).chapterMarksEnabled).toBe(true)
  })

  it('导出成功路径：写入剪贴板并报绿灯', async () => {
    await chrome.storage.local.set({
      biliHelperUserCorpus: [
        { text: '某新品牌', category: 'brands-digital', kind: 'brand', weight: 1, note: '', createdAt: 'x' },
      ],
    })
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    const wrapper = mount(App)
    await flushPromises()
    await findButton(wrapper, '导出入库 patch').trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(String(writeText.mock.calls[0]?.[0])).toContain('某新品牌')
    expect(wrapper.find('.feedback.ok')?.text()).toContain('已复制到剪贴板')
    expect(wrapper.find('textarea[aria-label="导出的词库 patch"]').exists()).toBe(true)
  })

  it('补录成功后已生成的 patch 立即失效（不能让用户复制走旧内容）', async () => {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => undefined) },
      configurable: true,
    })
    const wrapper = mount(App)
    await flushPromises()

    await wrapper.find('input[aria-label="补录词条"]').setValue('词A')
    await findButton(wrapper, '补录').trigger('click')
    await flushPromises()
    await findButton(wrapper, '导出入库 patch').trigger('click')
    await flushPromises()
    expect(wrapper.find('textarea[aria-label="导出的词库 patch"]').exists()).toBe(true)

    await wrapper.find('input[aria-label="补录词条"]').setValue('词B')
    await findButton(wrapper, '补录').trigger('click')
    await flushPromises()
    expect(wrapper.find('textarea[aria-label="导出的词库 patch"]').exists()).toBe(false)
  })

  it('删除/清空写失败：红灯报错且列表不假装变了', async () => {
    await chrome.storage.local.set({
      biliHelperUserCorpus: [
        { text: '词A', category: 'scripts', kind: 'script', weight: 2, note: '', createdAt: 'x' },
      ],
    })
    const wrapper = mount(App)
    await flushPromises()

    const setMock = chrome.storage.local.set as unknown as ReturnType<typeof vi.fn>
    setMock.mockRejectedValueOnce(new Error('quota exceeded'))
    await wrapper.find('button[aria-label="删除 词A"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.feedback.fail')?.text()).toContain('删除失败')
    expect(wrapper.findAll('.corpus-item')).toHaveLength(1)

    setMock.mockRejectedValueOnce(new Error('quota exceeded'))
    await findButton(wrapper, '清空补录').trigger('click')
    await flushPromises()
    expect(wrapper.find('.feedback.fail')?.text()).toContain('清空失败')
    expect(wrapper.findAll('.corpus-item')).toHaveLength(1)
  })

  it('server 模式：词库卡明说补录不参与服务器识别，补录成功只给黄灯', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: { mode: 'server', serverBaseUrl: 'https://srv.example' },
    })

    const wrapper = mount(App)
    await flushPromises()
    expect(wrapper.text()).toContain('当前识别在服务器上做')

    await wrapper.find('input[aria-label="补录词条"]').setValue('某新品牌')
    await findButton(wrapper, '补录').trigger('click')
    await flushPromises()

    const hint = wrapper.find('.feedback.warn')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('只在浏览器直连时生效')
    expect(hint.text()).toContain('导出入库 patch')
    // 词确实存下了（回退直连时要用），只是不承诺服务器侧生效。
    expect(await readUserCorpus()).toHaveLength(1)
  })

  it('诊断记录卡：展示存储中的失败（含原始响应摘录）并可清空', async () => {
    await chrome.storage.local.set({
      aiFailureLog: [
        {
          time: Date.UTC(2026, 0, 1, 12, 34, 56),
          feature: '总结',
          kind: 'parse',
          message: '响应不是合法 JSON，请确认端点是否 OpenAI 兼容',
          rawExcerpt: 'The model replied in plain text',
          endpoint: 'https://ark.example/api/coding',
          model: 'm-1',
        },
      ],
    })

    const wrapper = mount(App)
    await flushPromises()

    const item = wrapper.find('.diag-log-item')
    expect(item.exists()).toBe(true)
    expect(item.text()).toContain('总结')
    expect(item.text()).toContain('parse')
    expect(item.text()).toContain('响应不是合法 JSON')
    expect(wrapper.find('.diag-log-raw').text()).toContain('The model replied in plain text')
    expect(item.text()).toContain('https://ark.example/api/coding')
    expect(wrapper.text()).toContain('1/20 条')

    await findButton(wrapper, '清空').trigger('click')
    await flushPromises()
    expect(wrapper.find('.diag-log-item').exists()).toBe(false)
    expect(wrapper.text()).toContain('暂无失败记录')
    expect((await chrome.storage.local.get('aiFailureLog')).aiFailureLog).toEqual([])
  })

  it('拉取模型失败入档：诊断记录出现「模型列表」条目', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 404 })))
    const wrapper = mount(App)
    await flushPromises()

    await wrapper.find('input[type="url"]').setValue('https://ark.example/api/coding')
    await findButton(wrapper, '拉取模型').trigger('click')
    await flushPromises()

    const item = wrapper.find('.diag-log-item')
    expect(item.text()).toContain('模型列表')
    expect(item.text()).toContain('HTTP 404')
    expect(wrapper.text()).toContain('手动填写模型名')
  })


  it('批量粘贴补录：多行入库、重复跳过给原因、列表即时更新', async () => {
    await chrome.storage.local.set({
      biliHelperUserCorpus: [
        { text: '已有词', category: 'scripts', kind: 'script', weight: 2, note: '', createdAt: 'x', hitCount: 3, lastHitAt: '' },
      ],
    })
    const wrapper = mount(App)
    await flushPromises()

    // 命中次数徽标：存储里的 hitCount 直接展示
    expect(wrapper.find('.corpus-hits').text()).toBe('命中 3')

    await findButton(wrapper, '批量粘贴').trigger('click')
    await wrapper.find('textarea[aria-label="批量补录词条"]').setValue('词A\n词B\n已有词\n词A')
    await findButton(wrapper, '全部入库').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('已批量补录 2 条')
    expect(wrapper.text()).toContain('跳过 2 条')
    const words = wrapper.findAll('.corpus-word').map((item) => item.text())
    expect(words).toEqual(['已有词', '词A', '词B'])
    // 新词条命中数从 0 起
    expect(wrapper.findAll('.corpus-hits')[1]?.text()).toBe('命中 0')
  })

  it('批量粘贴：空文本拒绝并提示', async () => {
    const wrapper = mount(App)
    await flushPromises()
    await findButton(wrapper, '批量粘贴').trigger('click')
    await findButton(wrapper, '全部入库').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('先在文本框里贴词条')
  })

  it('API 协议选择：anthropic 回填与写回', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: { apiFormat: 'anthropic' },
    })
    const wrapper = mount(App)
    await flushPromises()
    const select = wrapper.find('select[aria-label="API 协议"]')
    expect((select.element as HTMLSelectElement).value).toBe('anthropic')

    await select.setValue('openai')
    await wrapper.find('button.primary').trigger('click')
    await flushPromises()
    expect((await storedSettings()).apiFormat).toBe('openai')
  })

  it('配置方案：存为方案 → 切换端点 → 应用还原（表单即时更新，无需再点保存）', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: { apiUrl: 'https://a.example/v1', model: 'm-a' },
    })
    const wrapper = mount(App)
    await flushPromises()

    // 当前连接存为方案。
    await wrapper.find('input[aria-label="方案名称"]').setValue('A 方案')
    await findButton(wrapper, '存为方案').trigger('click')
    await flushPromises()
    const select = wrapper.find('select[aria-label="选择方案"]')
    expect((select.element as HTMLSelectElement).value).not.toBe('')
    expect(wrapper.find('.feedback.ok').text()).toContain('已保存')

    // 换一套连接（模拟用户手动改了端点）。
    await wrapper.find('input[type="url"]').setValue('https://b.example/v1')

    // 应用方案：连接字段整体还原，方案卡的提示说明已写入存储。
    await findButton(wrapper, '应用').trigger('click')
    await flushPromises()
    expect(inputValue(wrapper.find('input[type="url"]').element)).toBe('https://a.example/v1')
    expect(inputValue(wrapper.find('input[aria-label="对话模型"]').element)).toBe('m-a')
    expect((await storedSettings()).apiUrl).toBe('https://a.example/v1')

    // 删除方案：下拉回到空态。
    await findButton(wrapper, '删除').trigger('click')
    await flushPromises()
    const selectAfter = wrapper.find('select[aria-label="选择方案"]')
    expect((selectAfter.element as HTMLSelectElement).disabled).toBe(true)
  })

  it('模型选择器：输入即过滤（startsWith 优先），点选写回表单', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: { apiUrl: 'https://a.example/v1' },
    })
    const wrapper = mount(App)
    await flushPromises()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [{ id: 'beta-model' }, { id: 'b-alpha-model' }, { id: 'gamma-model' }, { id: 'Alpha-model' }],
          }),
          { status: 200 },
        ),
      ),
    )
    await findButton(wrapper, '拉取模型').trigger('click')
    await flushPromises()

    const input = wrapper.find('input[aria-label="对话模型"]')
    // 聚焦展开全量（按字母序）：Alpha-model 排最前。
    await input.trigger('focus')
    let items = wrapper.findAll('.model-list li')
    expect(items.map((item) => item.text())).toEqual([
      'Alpha-model',
      'b-alpha-model',
      'beta-model',
      'gamma-model',
    ])

    // 输入 b：两条都以 b 开头（startsWith 组内按字母序），gamma 被过滤；
    // contains 组会排在 startsWith 组之后（见下一步用例：alpha 命中但不以输入开头）。
    await input.setValue('b')
    items = wrapper.findAll('.model-list li')
    expect(items.map((item) => item.text())).toEqual(['b-alpha-model', 'beta-model'])

    // 输入 a：'Alpha-model' 是 startsWith（大小写不敏感）排最前；其余三条只是 contains，
    // 组内按字母序——startsWith 组优先于 contains 组的规则得到验证。
    await input.setValue('a')
    items = wrapper.findAll('.model-list li')
    expect(items.map((item) => item.text())).toEqual([
      'Alpha-model',
      'b-alpha-model',
      'beta-model',
      'gamma-model',
    ])

    // 点选写回表单并收起列表（当前列表首项即上一步过滤后的 Alpha-model）。
    await items[0]!.trigger('mousedown')
    expect(inputValue(input.element)).toBe('Alpha-model')
    // v-show 收起 = display:none（DOM 保留，断言样式而不是节点数）。
    const list = wrapper.find('.model-list')
    expect((list.element as HTMLElement).style.display).toBe('none')
  })
})

describe('功能分组（Epic1-S1.4）', () => {
  async function openGroup(wrapper: ReturnType<typeof mount>, title: string): Promise<void> {
    const nav = wrapper.findAll('button.sidebar-item').find((item) => item.text() === title)
    if (!nav) throw new Error(`找不到分组：${title}`)
    await nav.trigger('click')
    await flushPromises()
  }

  it('侧栏只含 AI 助手 + 三个功能组（净化与占位组已移除）；功能行带标题/描述/适用范围', async () => {
    const wrapper = mount(App)
    await flushPromises()
    const navTexts = wrapper.findAll('button.sidebar-item').map((item) => item.text())
    expect(navTexts).toEqual(['AI 助手', '过滤视频', '功能增强'])

    await openGroup(wrapper, '过滤视频')
    const names = wrapper.findAll('.switch-name').map((item) => item.text())
    expect(names.some((t) => t.includes('视频筛选'))).toBe(true)
    expect(names.some((t) => t.includes('广告视频'))).toBe(true)
    expect(names.some((t) => t.includes('推广视频'))).toBe(true)
    expect(names.some((t) => t.includes('标签视频'))).toBe(true)
    // 适用范围标签在场；默认全部关闭。
    expect(wrapper.findAll('.applies-tag').length).toBe(4)
    for (const box of wrapper.findAll('input[type="checkbox"]')) {
      expect((box.element as HTMLInputElement).checked).toBe(false)
    }
  })

  it('切换开关即时持久化到 biliHelperFeatures 并回显成功反馈', async () => {
    const wrapper = mount(App)
    await flushPromises()
    await openGroup(wrapper, '功能增强')
    const rateSwitch = wrapper.find('input[aria-label="无级倍速开关"]')
    expect(rateSwitch.exists()).toBe(true)
    await rateSwitch.setValue(true)
    await flushPromises()
    const stored = (await chrome.storage.local.get('biliHelperFeatures')) as {
      biliHelperFeatures: Record<string, { enabled: boolean } | undefined>
    }
    expect(stored.biliHelperFeatures.steplessVideoRate?.enabled).toBe(true)
    expect(wrapper.text()).toContain('已开启无级倍速')
  })

  it('今日拦截徽标：统计 >0 才显示，未计数的功能不显示', async () => {
    const now = new Date()
    const pad = (value: number): string => String(value).padStart(2, '0')
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    await chrome.storage.local.set({
      biliHelperFeatureStats: {
        adVideoBlocker: { statsDate: today, totalBlocked: 5 },
        promotedVideoBlocker: { statsDate: today, totalBlocked: 2 },
      },
    })
    const wrapper = mount(App)
    await flushPromises()
    await openGroup(wrapper, '过滤视频')
    expect(wrapper.text()).toContain('今日拦截 5')
    expect(wrapper.text()).toContain('今日拦截 2')
    // 视频筛选不参与统计：无徽标（其行文本不含「今日拦截」）。
    const filterRow = wrapper.findAll('.switch-row').find((row) => row.text().includes('视频筛选'))
    expect(filterRow?.text()).not.toContain('今日拦截')
  })

  it('拦截明细面板：存储中的明细按规则聚合展示，可清空', async () => {
    await chrome.storage.local.set({
      biliHelperFilterLog: [
        { time: Date.now() - 1000, bvid: 'BV18vY969EHJ', title: '带货一号', reason: '标题关键词:带货', surface: '首页' },
        { time: Date.now() - 2000, bvid: 'BV2xx411c7mE', title: '广告卡', reason: '广告标识', surface: '首页' },
        { time: Date.now() - 3000, bvid: 'BV3xx411c7mF', title: '旧带货', reason: '标题关键词:带货', surface: '热门' },
      ],
    })
    const wrapper = mount(App)
    await flushPromises()
    await openGroup(wrapper, '过滤视频')

    // 折叠态给出条数提示；展开后按规则聚合 + 明细行（标题/BV 链接/注入面）。
    const toggle = wrapper.findAll('button').find((item) => item.text().includes('拦截明细'))
    expect(toggle?.text()).toContain('3/100')
    await toggle!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('标题关键词:带货 × 2')
    expect(wrapper.text()).toContain('广告标识 × 1')
    const items = wrapper.findAll('.log-item')
    expect(items.length).toBe(3)
    const link = wrapper.find('a.log-title')
    expect(link.attributes('href')).toBe('https://www.bilibili.com/video/BV18vY969EHJ')

    // 清空后回到空态提示。
    await wrapper.find('.log-actions button').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('还没有拦截记录')
    const raw = (await chrome.storage.local.get('biliHelperFilterLog')) as Record<string, unknown>
    expect(raw.biliHelperFilterLog).toBeUndefined()
  })
})

describe('筛选规则面板（Epic2-S2.6）', () => {
  async function openFilterGroupWithPanel(wrapper: ReturnType<typeof mount>): Promise<void> {
    const nav = wrapper.findAll('button.sidebar-item').find((item) => item.text() === '过滤视频')
    await nav!.trigger('click')
    await flushPromises()
    // 开启「视频筛选」让面板展开。
    const toggle = wrapper.find('input[aria-label="视频筛选开关"]')
    await toggle.setValue(true)
    await flushPromises()
  }

  it('视频筛选开启后展开面板；关键字编辑→保存→配置持久化（分钟↔秒换算）', async () => {
    const wrapper = mount(App)
    await flushPromises()
    await openFilterGroupWithPanel(wrapper)
    expect(wrapper.find('[aria-label="筛选规则"]').exists()).toBe(true)

    const keywords = wrapper.find('textarea[aria-label="标题关键字黑名单"]')
    await keywords.setValue('带货\n恰饭, 广告')
    const durationMin = wrapper.find('input[aria-label="视频时长最小值"]')
    await durationMin.setValue('2') // 分钟 → 存储为秒
    await wrapper.find('button.primary').trigger('click')
    await flushPromises()

    const stored = (await chrome.storage.local.get('biliHelperFeatures')) as {
      biliHelperFeatures: { videoFilter?: { config?: { titleKeywords?: string[]; durationMinSeconds?: number | null } } }
    }
    const config = stored.biliHelperFeatures.videoFilter?.config
    expect(config?.titleKeywords).toEqual(['带货', '恰饭', '广告'])
    expect(config?.durationMinSeconds).toBe(120)
    expect(wrapper.text()).toContain('已保存并应用')
  })

  it('非法值阻止保存：负数/非整数天数/min>max 按字段报错', async () => {
    const wrapper = mount(App)
    await flushPromises()
    await openFilterGroupWithPanel(wrapper)

    await wrapper.find('input[aria-label="浏览量最小值"]').setValue('-5')
    await flushPromises()
    expect(wrapper.text()).toContain('请输入大于或等于 0 的数字')
    const save = wrapper.findAll('button').find((b) => b.text().includes('保存并应用'))!
    expect((save.element as HTMLButtonElement).disabled).toBe(true)

    await wrapper.find('input[aria-label="浏览量最小值"]').setValue('100')
    await wrapper.find('input[aria-label="浏览量最大值"]').setValue('50')
    await flushPromises()
    expect(wrapper.text()).toContain('浏览量最小值不能大于最大值')
    expect((save.element as HTMLButtonElement).disabled).toBe(true)
  })

  it('导入账号黑名单：分页拉取并合入（去重）', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        const target = String(url)
        calls.push(target)
        const page = target.includes('pn=2') ? 2 : 1
        return new Response(
          JSON.stringify({
            data: {
              list:
                page === 1
                  ? [{ mid: 1001, uname: '黑名单甲' }, { mid: 1002, uname: '黑名单乙' }]
                  : [], // 第二页空 → 停止
            },
          }),
          { status: 200 },
        )
      }),
    )
    const wrapper = mount(App)
    await flushPromises()
    await openFilterGroupWithPanel(wrapper)

    const importBtn = wrapper.findAll('button').find((b) => b.text().includes('导入账号黑名单'))!
    await importBtn.trigger('click')
    await flushPromises()
    expect(calls[0]).toContain('/x/relation/blacks')
    expect(calls).toHaveLength(1) // 不足一页即停，不多拉
    const textarea = wrapper.find('textarea[aria-label="UP主黑名单"]')
    expect((textarea.element as HTMLTextAreaElement).value).toContain('1001')
    expect((textarea.element as HTMLTextAreaElement).value).toContain('黑名单甲')
    expect(wrapper.text()).toContain('已导入 4 个账号黑名单')
    vi.unstubAllGlobals()
  })
})

describe('配置备份（导出 / 导入）', () => {
  it('导出：默认不含密钥（文件里不出现 Key 明文），可选择包含密钥', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: {
        apiUrl: 'https://chat.example/v1',
        model: 'm-1',
        apiKey: 'sk-top-secret',
        serverToken: 'tok-top-secret',
      },
    })
    const written: string[] = []
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: vi.fn(async (text: string) => written.push(text)) },
      configurable: true,
    })

    const wrapper = mount(App)
    await flushPromises()
    await findButton(wrapper, '导出备份').trigger('click')
    await flushPromises()

    const textarea = wrapper.find('textarea[aria-label="备份内容"]')
    const text = (textarea.element as HTMLTextAreaElement).value
    expect(text).toContain('bili-helper-backup')
    expect(text).toContain('https://chat.example/v1')
    expect(text).not.toContain('sk-top-secret')
    expect(text).not.toContain('tok-top-secret')
    expect(written[0]).toBe(text) // 同时写入剪贴板

    // 勾选「包含密钥」再导出：明文出现 + 黄灯警示。
    await wrapper.find('input[aria-label="导出时包含密钥"]').setValue(true)
    await findButton(wrapper, '导出备份').trigger('click')
    await flushPromises()
    const withSecrets = (wrapper.find('textarea[aria-label="备份内容"]').element as HTMLTextAreaElement).value
    expect(withSecrets).toContain('sk-top-secret')
    expect(wrapper.findAll('.feedback.warn').length).toBeGreaterThan(0)
  })

  it('导入：坏 JSON 红灯；合法备份落库并回填表单、同步词库列表', async () => {
    const wrapper = mount(App)
    await flushPromises()
    const textarea = wrapper.find('textarea[aria-label="备份内容"]')

    await textarea.setValue('{ not json')
    await findButton(wrapper, '导入备份').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('不是合法的 JSON 文本')

    const payload = {
      format: 'bili-helper-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      withSecrets: false,
      ai: { apiUrl: 'https://imported.example/v1', model: 'm-imported', apiKey: '' },
      features: {
        videoFilter: {
          enabled: true,
          config: { titleKeywords: ['带货'], authorBlacklist: [], durationMinSeconds: 300 },
        },
      },
      corpus: [{ text: '限时国补', category: 'deals', kind: 'deal', weight: 2, note: '', createdAt: 'x', hitCount: 0, lastHitAt: '' }],
      adFeedback: {},
    }
    await textarea.setValue(JSON.stringify(payload))
    await findButton(wrapper, '导入备份').trigger('click')
    await flushPromises()

    // 表单回填导入后的端点；词库列表出现导入词条；存储落库。
    expect(inputValue(wrapper.find('input[type="url"]').element)).toBe('https://imported.example/v1')
    expect(inputValue(wrapper.find('input[aria-label="对话模型"]').element)).toBe('m-imported')
    expect(wrapper.text()).toContain('限时国补')
    const features = (await chrome.storage.local.get('biliHelperFeatures')) as {
      biliHelperFeatures: { videoFilter?: { enabled: boolean; config: { titleKeywords: string[] } } }
    }
    expect(features.biliHelperFeatures.videoFilter?.enabled).toBe(true)
    expect(features.biliHelperFeatures.videoFilter?.config.titleKeywords).toEqual(['带货'])
    expect(wrapper.text()).toContain('已导入')
  })
})
