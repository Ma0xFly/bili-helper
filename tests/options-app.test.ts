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
    expect(inputValue(wrapper.find('input[list="chat-model-options"]').element)).toBe('gpt-4o-mini')

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
    // 默认开的 panelEnabled；服务器地址保留，便于再开回来）。
    await wrapper.find('button.primary').trigger('click')
    await flushPromises()
    expect(await storedSettings()).toEqual({
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
      panelEnabled: true,
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
    expect(wrapper.find('input[list="embed-model-options"]').exists()).toBe(true)

    const toggle = wrapper.find('button[aria-controls="advanced-embed"]')
    expect(toggle.text()).toContain('向量端点')
    await toggle.trigger('click')
    expect((advanced.element as HTMLElement).style.display).not.toBe('none')
    expect(toggle.text()).toContain('收起')

    const embedModel = wrapper.find('input[list="embed-model-options"]')
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

  it('一键体检（local）：只探对话+向量端点，不碰服务器；继承态不单独报绿', async () => {
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
    await findButton(wrapper, '开始体检').trigger('click')
    await flushPromises()

    expect(calls).toContain('https://chat.example/v1/chat/completions')
    expect(calls).toContain('https://chat.example/v1/embeddings')
    expect(calls.some((url) => url.includes('/ai/health'))).toBe(false)
    // 向量端点继承对话端点且探测通过 → 只报一条绿灯，不重复噪音。
    const feedback = wrapper.findAll('.feedback')
    expect(feedback).toHaveLength(1)
    expect(feedback[0]?.text()).toContain('对话端点连接成功')
  })

  it('一键体检（server）：只探服务器，不探本机端点', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: { mode: 'server', serverBaseUrl: 'https://srv.example', serverToken: 'tok' },
    })
    const calls = stubProbeFetch()

    const wrapper = mount(App)
    await flushPromises()
    await findButton(wrapper, '开始体检').trigger('click')
    await flushPromises()

    expect(calls).toEqual(['https://srv.example/ai/health'])
    expect(wrapper.findAll('.feedback')[0]?.text()).toContain('服务器连接成功')
  })

  it('一键体检（auto）：服务器与回退端点都探——回退路径必须真的可用', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: {
        mode: 'auto',
        apiUrl: 'https://chat.example/v1',
        model: 'm-1',
        apiKey: 'k-1',
        serverBaseUrl: 'https://srv.example',
      },
    })
    const calls = stubProbeFetch()

    const wrapper = mount(App)
    await flushPromises()
    await findButton(wrapper, '开始体检').trigger('click')
    await flushPromises()

    expect(calls).toContain('https://srv.example/ai/health')
    expect(calls).toContain('https://chat.example/v1/chat/completions')
    expect(calls).toContain('https://chat.example/v1/embeddings')
    expect(wrapper.findAll('.feedback')).toHaveLength(2)
  })

  it('一键体检：服务器未实现体检接口报黄灯，不当成失败', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: { mode: 'server', serverBaseUrl: 'https://srv.example' },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))

    const wrapper = mount(App)
    await flushPromises()
    await findButton(wrapper, '开始体检').trigger('click')
    await flushPromises()

    const feedback = wrapper.findAll('.feedback')
    expect(feedback[0]?.classes()).toContain('warn')
    expect(feedback[0]?.text()).toContain('未提供体检接口')
  })

  it('体检运行中按钮禁用；结果只反映最新一轮，不累积', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: { mode: 'server', serverBaseUrl: 'https://srv.example' },
    })
    let releaseFirst: ((response: Response) => void) | undefined
    let invocation = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        invocation += 1
        // 第一轮挂住，验证按钮进入禁用态（防重入，也就防住了迟到结果覆盖新一轮）。
        if (invocation === 1) return new Promise<Response>((resolve) => { releaseFirst = resolve })
        return new Response('', { status: 404 })
      }),
    )

    const wrapper = mount(App)
    await flushPromises()
    const button = findButton(wrapper, '开始体检')
    await button.trigger('click')
    expect(button.text()).toContain('体检中')
    expect((button.element as HTMLButtonElement).disabled).toBe(true)

    releaseFirst?.(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await flushPromises()
    expect(wrapper.findAll('.feedback')).toHaveLength(1)
    expect(wrapper.find('.feedback.ok')?.text()).toContain('服务器连接成功')
    expect((findButton(wrapper, '开始体检').element as HTMLButtonElement).disabled).toBe(false)

    // 第二轮（404 → 黄灯）：旧绿灯必须被替换，而不是两条并排堆着。
    await findButton(wrapper, '开始体检').trigger('click')
    await flushPromises()
    const feedback = wrapper.findAll('.feedback')
    expect(feedback).toHaveLength(1)
    expect(feedback[0]?.classes()).toContain('warn')
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

  it('一键体检：对话端点红灯 + 按钮从「体检中…」恢复', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: { mode: 'local', apiUrl: 'https://chat.example/v1', model: 'm-1', apiKey: 'bad' },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"nope"}', { status: 401 })))

    const wrapper = mount(App)
    await flushPromises()
    await findButton(wrapper, '开始体检').trigger('click')
    await flushPromises()

    const feedback = wrapper.findAll('.feedback')
    expect(feedback.some((item) => item.classes().includes('fail'))).toBe(true)
    expect(wrapper.text()).toContain('未授权')
    // 探测失败也必须解锁按钮，否则配置台卡在「体检中…」。
    expect(findButton(wrapper, '开始体检').text()).toBe('开始体检')
    expect((findButton(wrapper, '开始体检').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('一键体检：继承态向量端点失败要单独报红并自动展开高级区', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: { mode: 'local', apiUrl: 'https://chat.example/v1', model: 'm-1', apiKey: 'k' },
    })
    // 对话成功、向量失败：这正是「继承态不报绿」规则的反面——出问题必须报，还得指到该改的字段。
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) =>
        String(url).includes('/embeddings')
          ? new Response('{"error":"boom"}', { status: 500 })
          : new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), { status: 200 }),
      ),
    )

    const wrapper = mount(App)
    await flushPromises()
    expect((wrapper.find('#advanced-embed').element as HTMLElement).style.display).toBe('none')

    await findButton(wrapper, '开始体检').trigger('click')
    await flushPromises()

    const feedback = wrapper.findAll('.feedback')
    expect(feedback.some((item) => item.classes().includes('ok'))).toBe(true)
    const failure = feedback.find((item) => item.classes().includes('fail'))
    expect(failure?.text()).toContain('向量端点连接失败')
    expect((wrapper.find('#advanced-embed').element as HTMLElement).style.display).not.toBe('none')
  })

  it('一键体检：向量端点拆开配置且通过时报两条绿灯', async () => {
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
    await findButton(wrapper, '开始体检').trigger('click')
    await flushPromises()

    expect(calls).toContain('https://emb.example/embeddings')
    const feedback = wrapper.findAll('.feedback')
    expect(feedback).toHaveLength(2)
    expect(feedback.every((item) => item.classes().includes('ok'))).toBe(true)
    expect(feedback[1]?.text()).toContain('向量端点连接成功')
  })

  it('一键体检：服务器红灯给出可执行原因', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: { mode: 'server', serverBaseUrl: 'https://srv.example', serverToken: 'bad' },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))

    const wrapper = mount(App)
    await flushPromises()
    await findButton(wrapper, '开始体检').trigger('click')
    await flushPromises()

    const feedback = wrapper.findAll('.feedback')
    expect(feedback[0]?.classes()).toContain('fail')
    expect(feedback[0]?.text()).toContain('服务器连接失败')
    expect(feedback[0]?.text()).toContain('Server Token')
  })

  it('一键体检用表单当前值：改了地址没保存也测新地址', async () => {
    await chrome.storage.sync.set({
      aiAssistantSettings: { mode: 'local', apiUrl: 'https://old.example/v1', model: 'm-1', apiKey: 'k' },
    })
    const calls = stubProbeFetch()

    const wrapper = mount(App)
    await flushPromises()
    await wrapper.find('input[type="url"]').setValue('https://new.example/v1')
    await findButton(wrapper, '开始体检').trigger('click')
    await flushPromises()

    expect(calls).toContain('https://new.example/v1/chat/completions')
    expect(calls.some((url) => url.includes('old.example'))).toBe(false)
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
})
