// @vitest-environment jsdom
// AI 面板组件回归（jsdom mount；jsdom 的 HTML 解析与真实浏览器一致，dompurify 安全路径
// 才能在测试里如实生效——happy-dom 的解析器会让 script/onerror 穿透清洗）：tab 切换 / 折叠 /
// 显隐三 gate / 空态 / 生成中 / 完成态（Markdown 清洗 + 分段打标 + 点击跳播 + 当前段高亮）/
// 错误态 / 流式提问（打字光标 + 溯源 chip 点击跳播 / end.error）/ 上滚暂停自动滚底（纯函数判定）。
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import PanelApp from './PanelApp.vue'
import SummaryTab from './SummaryTab.vue'
import ChatTab from './ChatTab.vue'
import { panel, panelActions, panelActivity } from '../../../../modules/content/panel-state'
import type { PanelSession } from '../../../../modules/content/panel-state'
import { ui } from '../../../../modules/content/ui-state'
import { AiError } from '../../../../modules/shared/error'
import type { AiContext, ChatHandlers, ChatInput, SummarizeInput, SummarizeResult } from '../../../../modules/ai/port'
import { isNearBottom, SCROLL_STICK_TOLERANCE_PX } from '../../../../modules/ai/panel-logic'

// 每个用例后自动卸载 wrapper：组件实例跨用例残留会让上一用例的实例继续响应 store
// 变化（v-show/生成态等断言互相污染）。
enableAutoUnmount(afterEach)

function makeSession(bvid = 'BV1test'): PanelSession {
  const context: AiContext = {
    video: { bvid, cid: 1, title: '测试视频', duration: 600 },
    subtitles: [{ start: 0, end: 10, text: '开场白' }],
    danmaku: [],
    comments: [],
  }
  return { bvid, title: '测试视频', context }
}

/** 面板两个 tabpanel 的 v-show 显示状态（inline display none 直查）。 */
function tabPanelStyles(wrapper: VueWrapper): string[] {
  return wrapper
    .findAll('.bh-panel-body [role="tabpanel"]')
    .map((panel) => panel.attributes('style') ?? '')
}

beforeEach(() => {
  panel.masterEnabled = true
  panel.pageEnabled = true
  panel.fullscreen = false
  panel.ready = true
  panel.session = null
  panel.collectError = false
  panelActivity.summaryStatus = 'idle'
  panelActivity.summaryDoneAt = null
  panelActivity.chatAnswering = false
  ui.ads = []
  ui.currentTime = 0
  ui.dark = false
  panelActions.seek = vi.fn()
  panelActions.openSettings = vi.fn()
  panelActions.summarize = vi.fn()
  panelActions.chat = vi.fn()
  panelActions.retryCollection = vi.fn()
})

describe('PanelApp（面板壳）', () => {
  it('面板壳 + 两 tab 等宽胶囊：点击切换内容、互不干扰', async () => {
    panel.session = makeSession()
    const wrapper = mount(PanelApp)

    expect(wrapper.find('.bh-panel').exists()).toBe(true)
    expect(wrapper.findAll('.bh-tab')).toHaveLength(2)
    expect(wrapper.find('.bh-tab').text()).toBe('总结')

    // 默认总结 tab；提问内容在场但隐藏（v-show 保留各 tab 已生成内容）。
    const panels = tabPanelStyles(wrapper)
    expect(panels[0]).not.toContain('display: none')
    expect(panels[1]).toContain('display: none')

    const tabs = wrapper.findAll('.bh-tab')
    await tabs[1]!.trigger('click')
    await nextTick()
    const panelsChat = tabPanelStyles(wrapper)
    expect(panelsChat[0]).toContain('display: none')
    expect(panelsChat[1]).not.toContain('display: none')

    await tabs[0]!.trigger('click')
    await nextTick()
    const panelsBack = tabPanelStyles(wrapper)
    expect(panelsBack[0]).not.toContain('display: none')
    expect(panelsBack[1]).toContain('display: none')
  })

  it('显隐 gate：设置读回前 / 设置总开关关 / popup 快开关关 / 全屏 → 面板隐藏（v-show 不卸载内容）', async () => {
    panel.session = makeSession()
    const wrapper = mount(PanelApp)
    // 可见时 v-show 不写内联 style（面板已无定位样式），attributes('style') 会是 undefined。
    const rootStyle = (): string => wrapper.find('.bh-panel-root').attributes('style') ?? ''
    expect(rootStyle()).not.toContain('display: none')

    panel.ready = false // 设置读回前：不闪现
    await nextTick()
    expect(rootStyle()).toContain('display: none')
    panel.ready = true
    await nextTick()
    expect(rootStyle()).not.toContain('display: none')

    panel.masterEnabled = false
    await nextTick()
    expect(rootStyle()).toContain('display: none')
    panel.masterEnabled = true
    await nextTick()
    expect(rootStyle()).not.toContain('display: none')

    panel.pageEnabled = false
    await nextTick()
    expect(rootStyle()).toContain('display: none')
    panel.pageEnabled = true

    panel.fullscreen = true
    await nextTick()
    expect(rootStyle()).toContain('display: none')
    panel.fullscreen = false
    await nextTick()
    expect(rootStyle()).not.toContain('display: none')

    // 隐藏全程 v-show：tab 内容节点始终在场（跨隐藏不卸载）。
    expect(wrapper.find('.bh-panel').exists()).toBe(true)
    expect(wrapper.find('.bh-panel-empty-title').exists()).toBe(true)
  })

  it('折叠：收起换玻璃胶囊（v-show 不卸载），展开恢复且内容保留', async () => {
    panel.session = makeSession()
    panelActions.summarize = vi.fn(async () => ({ summary: '折叠前的总结', segments: [] }))
    const wrapper = mount(PanelApp)
    await wrapper.find('.bh-btn-primary').trigger('click')
    await flushPromises()
    expect(wrapper.find('.bh-markdown').text()).toContain('折叠前的总结')
    expect(wrapper.find('.bh-markdown').attributes('style') ?? '').not.toContain('display: none')

    await wrapper.find('.bh-panel-collapse-btn').trigger('click')
    expect(wrapper.find('.bh-panel').attributes('style') ?? '').toContain('display: none')
    expect(wrapper.find('.bh-panel-collapsed').attributes('style') ?? '').not.toContain('display: none')

    await wrapper.find('.bh-panel-collapsed').trigger('click')
    expect(wrapper.find('.bh-panel').attributes('style') ?? '').not.toContain('display: none')
    expect(wrapper.find('.bh-panel-collapsed').attributes('style') ?? '').toContain('display: none')
    // 折叠往返不卸载 tab 子树：总结内容原样保留。
    expect(wrapper.find('.bh-markdown').text()).toContain('折叠前的总结')
  })

  it('副标题：默认标题行 / 生成中 / 总结完成相对时间 / 提问流式中', async () => {
    panel.session = makeSession()
    const wrapper = mount(PanelApp)
    expect(wrapper.find('.bh-panel-subtitle').text()).toBe('bili-helper · 测试视频')

    panelActivity.summaryStatus = 'generating'
    await nextTick()
    expect(wrapper.find('.bh-panel-subtitle').text()).toBe('正在阅读视频字幕…')

    panelActivity.summaryStatus = 'done'
    panelActivity.summaryDoneAt = Date.now() - 12_000
    await nextTick()
    expect(wrapper.find('.bh-panel-subtitle').text()).toMatch(/总结完成于 \d+ 秒前/)

    panelActivity.chatAnswering = true
    await nextTick()
    expect(wrapper.find('.bh-panel-subtitle').text()).toBe('正在回答…')
  })
it('SPA 换视频：session.bvid 变化 → 子 tab 键控重建回空态', async () => {
    panel.session = makeSession('BV1old')
    panelActions.summarize = vi.fn(async () => ({
      summary: '旧视频的总结',
      segments: [],
    }))
    const wrapper = mount(PanelApp)
    await wrapper.find('.bh-btn-primary').trigger('click')
    await flushPromises()
    expect(wrapper.find('.bh-markdown').text()).toContain('旧视频的总结')

    // 换视频：新 session → bvid 键变化 → SummaryTab 重建（总结态清零，回空态）。
    panel.session = makeSession('BV1new')
    await nextTick()
    expect(wrapper.find('.bh-markdown').exists()).toBe(false)
    expect(wrapper.find('.bh-panel-empty-title').text()).toBe('让 AI 给你总结一下？')
    expect(wrapper.find('.bh-panel-subtitle').text()).toBe('bili-helper · 测试视频')
    expect(panelActivity.summaryStatus).toBe('idle')
  })

  it('采集硬失败（collectError + 无会话）：错误态 + 重试按钮走 retryCollection 动作', async () => {
    panel.session = null
    panel.collectError = true
    const wrapper = mount(PanelApp)

    expect(wrapper.find('.bh-feedback.error').text()).toContain('视频资料拉取失败')
    expect(wrapper.find('.bh-feedback .bh-link').text()).toBe('重试')
    // 错误态占位时 tab 内容不展示（会话为 null）。
    expect(wrapper.find('.bh-panel-empty-title').exists()).toBe(false)

    await wrapper.find('.bh-feedback .bh-link').trigger('click')
    expect(panelActions.retryCollection).toHaveBeenCalledTimes(1)
  })
})

describe('SummaryTab（总结交互）', () => {
  it('空态：声线文案「让 AI 给你总结一下？」+ 生成按钮', () => {
    panel.session = makeSession()
    const wrapper = mount(SummaryTab)
    expect(wrapper.find('.bh-panel-empty-title').text()).toBe('让 AI 给你总结一下？')
    expect(wrapper.find('.bh-btn-primary').text()).toBe('生成总结')
  })

  it('生成中：gen-pill（AI 生成中/停止生成）+ 骨架；停止 abort 回到空态', async () => {
    panel.session = makeSession()
    let receivedSignal: AbortSignal | null = null
    panelActions.summarize = vi.fn(async (input: SummarizeInput) => {
      receivedSignal = input.signal ?? null
      // 永不结算：保持生成中供断言；点停止走 abort。
      return new Promise<SummarizeResult>(() => {})
    })
    const wrapper = mount(SummaryTab)

    await wrapper.find('.bh-btn-primary').trigger('click')
    await nextTick()
    expect(wrapper.find('.bh-gen-pill').exists()).toBe(true)
    expect(wrapper.text()).toContain('AI 生成中')
    expect(wrapper.find('.bh-skeleton').exists()).toBe(true)

    await wrapper.find('.bh-btn-stop').trigger('click')
    await nextTick()
    expect((receivedSignal as AbortSignal | null)?.aborted).toBe(true)
    expect(panelActivity.summaryStatus).toBe('idle')
    expect(wrapper.find('.bh-gen-pill').exists()).toBe(false)
    expect(wrapper.find('.bh-panel-empty-title').text()).toBe('让 AI 给你总结一下？')
  })

  it('完成态：Markdown 正文 + 分段时间线（广告标签/区间提示/当前段高亮/点击跳播）', async () => {
    panel.session = makeSession()
    ui.ads = [{ start: 20, end: 40, product_name: '某会员', ad_content: '', confidence: 0.9 }]
    panelActions.summarize = vi.fn(async () => ({
      summary: '## 总结\n\n一段话总结。\n\n- 要点一：**加粗**',
      segments: [
        { start: 0, end: 20, label: '开场' },
        { start: 20, end: 40, label: '恰饭段：某会员推广' },
        { start: 40, end: 100, label: '后半程' },
      ],
    }))
    const wrapper = mount(SummaryTab)

    await wrapper.find('.bh-btn-primary').trigger('click')
    await flushPromises()

    expect(panelActivity.summaryStatus).toBe('done')
    expect(wrapper.find('.bh-markdown').text()).toContain('一段话总结')

    const items = wrapper.findAll('.bh-seg-item')
    expect(items).toHaveLength(3)
    // 广告段：粉色「广告」标签 + 区间提示。
    expect(items[1]!.text()).toContain('广告')
    expect(items[1]!.text()).toContain('恰饭段：某会员推广（至 00:00:40）')
    expect(items[0]!.find('.bh-seg-ad').exists()).toBe(false)

    // 当前播放段高亮：currentTime 落在第二段。
    ui.currentTime = 30
    await nextTick()
    expect(items[1]!.classes()).toContain('current')
    expect(items[0]!.classes()).not.toContain('current')

    // 点击分段 → 跳到 start。
    await items[1]!.trigger('click')
    expect(panelActions.seek).toHaveBeenCalledWith(20)
  })

  it('AI 输出带危险 HTML：marked 渲染后经 dompurify 清洗', async () => {
    panel.session = makeSession()
    panelActions.summarize = vi.fn(async () => ({
      summary: '<img src=x onerror="alert(1)">危险内容 <script>alert(2)</script>正文',
      segments: [],
    }))
    const wrapper = mount(SummaryTab)

    await wrapper.find('.bh-btn-primary').trigger('click')
    await flushPromises()

    expect(wrapper.find('.bh-markdown img').exists()).toBe(false)
    expect(wrapper.find('.bh-markdown script').exists()).toBe(false)
    expect(wrapper.find('.bh-markdown').element.innerHTML).not.toContain('onerror')
    expect(wrapper.find('.bh-markdown').text()).toContain('正文')
  })

  it('错误态：AiError kind 文案 + 去看看端点设置？入口 + 重新生成', async () => {
    panel.session = makeSession()
    panelActions.summarize = vi.fn(async () => {
      throw new AiError('config', '还没配置端点')
    })
    const wrapper = mount(SummaryTab)

    await wrapper.find('.bh-btn-primary').trigger('click')
    await flushPromises()

    expect(wrapper.find('.bh-feedback.error').text()).toContain('还没配置端点，先去设置页填一下？')
    const link = wrapper.find('.bh-feedback .bh-link')
    expect(link.text()).toContain('去看看端点设置？')
    await link.trigger('click')
    expect(panelActions.openSettings).toHaveBeenCalled()

    expect(wrapper.find('.bh-btn-primary').text()).toBe('重新生成')
  })
})

describe('ChatTab（提问交互）', () => {
  function mountWithCapturedChat(): {
    wrapper: VueWrapper
    state: { captured: { input: ChatInput; handlers: ChatHandlers } | null }
  } {
    const state: { captured: { input: ChatInput; handlers: ChatHandlers } | null } = {
      captured: null,
    }
    panelActions.chat = vi.fn(
      async (input: ChatInput, handlers: ChatHandlers) => {
        state.captured = { input, handlers }
      },
    )
    const wrapper = mount(ChatTab)
    return { wrapper, state }
  }

  function mustCaptured(state: {
    captured: { input: ChatInput; handlers: ChatHandlers } | null
  }): { input: ChatInput; handlers: ChatHandlers } {
    if (!state.captured) throw new Error('chat 未被调用')
    return state.captured
  }

  it('空态：欢迎语 + 4 枚预置推荐 chips（EXPERIENCE 微文案）', () => {
    panel.session = makeSession()
    const wrapper = mount(ChatTab)
    expect(wrapper.text()).toContain('关于这期视频，想问点什么？')
    expect(wrapper.findAll('.bh-chip').map((chip) => chip.text())).toEqual([
      '内容是什么',
      '精华片段在哪',
      '重要结论',
      '怎么安利给朋友',
    ])
    expect(wrapper.find('.bh-ask-input').attributes('placeholder')).toBe('问问这期视频…')
  })

  it('chip 点击发送 → start/message{chunk} 逐块渲染 + 打字光标 → end 收束并保留回答 + 溯源 chip 跳播', async () => {
    panel.session = makeSession()
    const { wrapper, state } = mountWithCapturedChat()

    await wrapper.findAll('.bh-chip')[1]!.trigger('click')
    await flushPromises()
    const captured = mustCaptured(state)

    expect(panelActions.chat).toHaveBeenCalledTimes(1)
    expect(captured.input.messages.map((m) => m.content)).toEqual(['精华片段在哪'])
    expect(captured.input.context.video.bvid).toBe('BV1test')
    // chips 发送后收起（回答态），用户气泡出现。
    expect(wrapper.find('.bh-chip').exists()).toBe(false)
    expect(wrapper.find('.bh-user-bubble').text()).toBe('精华片段在哪')

    captured.handlers.onEvent({ type: 'start' })
    await nextTick()
    expect(wrapper.find('.bh-cursor').exists()).toBe(true)

    captured.handlers.onEvent({ type: 'message', chunk: '值得看的是 ' })
    captured.handlers.onEvent({ type: 'message', chunk: '〔字幕 12:30〕 的投票揭晓。' })
    await nextTick()
    expect(wrapper.find('.bh-answer-card').text()).toContain('值得看的是')

    captured.handlers.onEvent({ type: 'end' })
    await nextTick()
    expect(wrapper.find('.bh-cursor').exists()).toBe(false)
    expect(panelActivity.chatAnswering).toBe(false)
    expect(wrapper.find('.bh-answer-card').text()).toContain('的投票揭晓')

    // 溯源 chip：〔字幕 12:30〕 → 点击跳 750 秒。
    const cite = wrapper.find('.bh-cite')
    expect(cite.exists()).toBe(true)
    expect(cite.text()).toContain('字幕 12:30')
    await cite.trigger('click')
    expect(panelActions.seek).toHaveBeenCalledWith(750)
  })

  it('end.error → 错误卡文案 + 设置入口；回答不被计入', async () => {
    panel.session = makeSession()
    const { wrapper, state } = mountWithCapturedChat()

    await wrapper.findAll('.bh-chip')[0]!.trigger('click')
    await flushPromises()
    const captured = mustCaptured(state)

    captured.handlers.onEvent({ type: 'start' })
    captured.handlers.onEvent({ type: 'message', chunk: '部分回答' })
    captured.handlers.onEvent({ type: 'end', error: { kind: 'network', message: 'x' } })
    await nextTick()

    expect(wrapper.find('.bh-feedback.error').text()).toContain('AI 掉线了，去看看端点设置？')
    await wrapper.find('.bh-feedback .bh-link').trigger('click')
    expect(panelActions.openSettings).toHaveBeenCalled()
    expect(panelActivity.chatAnswering).toBe(false)
  })

  it('停止生成：abort 且端口以 end 收束（保留已出内容，不报错）', async () => {
    panel.session = makeSession()
    const { wrapper, state } = mountWithCapturedChat()

    await wrapper.findAll('.bh-chip')[2]!.trigger('click')
    await flushPromises()
    const captured = mustCaptured(state)

    captured.handlers.onEvent({ type: 'start' })
    captured.handlers.onEvent({ type: 'message', chunk: '已生成的部分' })
    await nextTick()
    expect(wrapper.find('.bh-gen-pill').exists()).toBe(true)

    await wrapper.find('.bh-btn-stop').trigger('click')
    await nextTick()
    expect(captured.input.signal?.aborted).toBe(true)

    // 端口保证以 end 收尾（中止态 end{error}）：视为正常停止、保留部分内容。
    captured.handlers.onEvent({ type: 'end', error: { kind: 'network', message: '请求已中止' } })
    await nextTick()
    expect(wrapper.find('.bh-answer-card').text()).toContain('已生成的部分')
    expect(wrapper.find('.bh-feedback.error').exists()).toBe(false)
  })

  it('首个 SSE 事件前停止（server/auto 走 abort reject）：answering 立即解锁、可再次提问', async () => {
    panel.session = makeSession()
    // 流未开始即被 abort：模拟 server/auto 后端的 reject 路径（连 start 事件都没有）。
    panelActions.chat = vi.fn(
      (input: ChatInput) =>
        new Promise<void>((_, reject) => {
          input.signal?.addEventListener('abort', () => reject(new Error('请求已中止')))
        }),
    )
    const wrapper = mount(ChatTab)
    await wrapper.findAll('.bh-chip')[0]!.trigger('click')
    await flushPromises()
    expect(panelActivity.chatAnswering).toBe(true)

    // 无任何事件时点停止：不得锁死 answering。
    await wrapper.find('.bh-btn-stop').trigger('click')
    await nextTick()
    expect(panelActivity.chatAnswering).toBe(false)

    // reject 到账后依旧可输入、无错误卡（用户停止不当错误）。
    await flushPromises()
    expect(panelActivity.chatAnswering).toBe(false)
    expect(wrapper.find('.bh-feedback.error').exists()).toBe(false)
    expect((wrapper.find('.bh-ask-input').element as HTMLInputElement).disabled).toBe(false)
  })
})

describe('流式自动滚底判定（上滚暂停 / 滚回底部恢复）', () => {
  it('距底 24px 内视为近底（自动滚底）；超出即用户上滚（暂停）', () => {
    expect(isNearBottom(0, 100, 124)).toBe(true)
    expect(isNearBottom(10, 100, 134)).toBe(true)
    expect(isNearBottom(100, 100, 180)).toBe(true)
    expect(isNearBottom(0, 100, 150)).toBe(false)
    expect(isNearBottom(0, 100, 300)).toBe(false)
  })

  it('容差常量与判定一致', () => {
    expect(SCROLL_STICK_TOLERANCE_PX).toBe(24)
  })
})