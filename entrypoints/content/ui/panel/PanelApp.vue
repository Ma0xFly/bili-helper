<script setup lang="ts">
// 面板壳（面 A 骨架）：AI 助手标题行 + 总结/提问两 tab 等宽胶囊 + 折叠钮 + 显隐四 gate
// （设置读回 + 总开关 panelEnabled + popup 页内快开关 + 全屏）由接线层 drive；主标题行为态副标题
// （正在阅读视频字幕… / 正在回答… / 总结完成于 X 秒前 / bili-helper · ⟨标题⟩）。
// SPA 换视频按 session.bvid 键控子 tab 自复位（Vue 重建，状态回空态）。
// 折叠与隐藏都走 v-show：不卸载 tab 子树，跨折叠/隐藏保留各 tab 已生成内容与生成态。
// 视觉 token 全部来自 overlay.css 变量（零裸 hex），亮暗随 [data-dark]。
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import SummaryTab from './SummaryTab.vue'
import ChatTab from './ChatTab.vue'
import { panel, panelActivity, panelActions } from '../../../../modules/content/panel-state'
import { ui } from '../../../../modules/content/ui-state'
import { summaryAgoSeconds } from '../../../../modules/ai/panel-logic'
import './panel.css'

type PanelTab = 'summary' | 'chat'

const TABS: { key: PanelTab; label: string }[] = [
  { key: 'summary', label: '总结' },
  { key: 'chat', label: '提问' },
]

/** 面板显隐总 gate：设置读回（ready）+ 总开关 + popup 快开关 + 非全屏；读回前保持隐藏不闪现。 */
const visible = computed(
  () => panel.ready && panel.masterEnabled && panel.pageEnabled && !panel.fullscreen,
)

const activeTab = ref<PanelTab>('summary')
const collapsed = ref(false)

/** SPA 换视频键：bvid 变化 → 子 tab 重建（清空 tab 状态回空态）+ 面板头活动信号复位。 */
const sessionKey = computed(() => panel.session?.bvid ?? 'none')

watch(sessionKey, () => {
  // 换视频：面板头副标题活动信号复位（子 tab 组件按 key 重建自行清空自身状态）。
  panelActivity.summaryStatus = 'idle'
  panelActivity.summaryDoneAt = null
  panelActivity.chatAnswering = false
})

// 副标题相对时间需要逐秒刷新（「总结完成于 X 秒前」）；面板隐藏时停表。
const nowMs = ref(Date.now())
let ticker: number | undefined

function syncTicker(visibleNow: boolean): void {
  if (visibleNow) {
    if (ticker === undefined) {
      ticker = window.setInterval(() => {
        nowMs.value = Date.now()
      }, 1000)
    }
  } else if (ticker !== undefined) {
    window.clearInterval(ticker)
    ticker = undefined
  }
}

watch(visible, syncTicker, { immediate: true })
onBeforeUnmount(() => {
  if (ticker !== undefined) window.clearInterval(ticker)
})

const subtitle = computed(() => {
  if (panelActivity.summaryStatus === 'generating') return '正在阅读视频字幕…'
  if (panelActivity.chatAnswering) return '正在回答…'
  if (panelActivity.summaryStatus === 'done' && panelActivity.summaryDoneAt !== null) {
    return `总结完成于 ${summaryAgoSeconds(panelActivity.summaryDoneAt, nowMs.value)} 秒前`
  }
  const title = panel.session?.title.trim()
  return title ? `bili-helper · ${title}` : 'bili-helper'
})

const tabButtons: Array<HTMLButtonElement | null> = []

function setTabButton(el: unknown, index: number): void {
  tabButtons[index] = el instanceof HTMLButtonElement ? el : null
}

function selectTab(tab: PanelTab): void {
  activeTab.value = tab
}

// 键盘 ←/→ 在 tab 间循环（Tab 聚焦 + Enter/Space 切换由原生 button 承担）。
function onTabKeydown(event: KeyboardEvent): void {
  let next: PanelTab | null = null
  if (event.key === 'ArrowRight') next = 'chat'
  else if (event.key === 'ArrowLeft') next = 'summary'
  else return
  if (next === activeTab.value) return
  event.preventDefault()
  selectTab(next)
  const index = TABS.findIndex((tab) => tab.key === next)
  if (index >= 0) {
    void nextTick(() => tabButtons[index]?.focus())
  }
}
</script>

<template>
  <!-- 文档流内联（原版同款）：面板是右栏里的一个 tab——tab 条 + 面板本体插在 up 卡之后，
       随页面滚动、把原生内容往下推，不覆盖弹幕/合集/推荐任何原生模块。
       .bh-root 承载 --bh-* token 与字体，data-dark 随 B 站夜间模式。 -->
  <div class="bh-root" :data-dark="ui.dark ? '' : undefined">
    <div v-show="visible" class="bh-panel-root">
      <div class="bh-tab-strip" role="tablist" aria-label="右栏面板">
        <button
          type="button"
          role="tab"
          class="bh-strip-tab"
          :class="{ active: !collapsed }"
          :aria-selected="!collapsed ? 'true' : 'false'"
          :aria-expanded="!collapsed ? 'true' : 'false'"
          @click="collapsed = false"
        >
          <span class="bh-ai-orb" aria-hidden="true">AI</span>
          <span>AI 助手</span>
        </button>
        <button
          type="button"
          class="bh-strip-toggle"
          :aria-label="collapsed ? '展开 AI 面板' : '收起 AI 面板'"
          @click="collapsed = !collapsed"
        >
          {{ collapsed ? '展开' : '收起' }}
        </button>
      </div>

      <section
        v-show="!collapsed"
        class="bh-panel"
        role="region"
        aria-label="AI 助手面板"
      >
        <header class="bh-panel-head">
          <div class="bh-panel-title-row">
            <span class="bh-ai-orb" aria-hidden="true">AI</span>
            <div class="bh-panel-title-wrap">
              <span class="bh-panel-title">AI 助手</span>
              <span class="bh-panel-subtitle">{{ subtitle }}</span>
            </div>
            <button
              type="button"
              class="bh-panel-collapse-btn"
              aria-label="收起面板"
              @click="collapsed = true"
            >
              −
            </button>
          </div>
          <div class="bh-tab-bar" role="tablist" aria-label="面板功能" @keydown="onTabKeydown">
            <button
              v-for="(tab, index) in TABS"
              :key="tab.key"
              :ref="(el) => setTabButton(el, index)"
              :id="`bh-tab-${tab.key}`"
              type="button"
              role="tab"
              class="bh-tab"
              :class="{ active: activeTab === tab.key }"
              :aria-selected="activeTab === tab.key"
              :aria-controls="`bh-tabpanel-${tab.key}`"
              :tabindex="activeTab === tab.key ? 0 : -1"
              @click="selectTab(tab.key)"
            >
              {{ tab.label }}
            </button>
          </div>
        </header>
        <div class="bh-panel-body">
          <!-- 采集硬失败（视频元数据取不到）：错误态 + 重试按钮（单源失败已拼部分上下文不算失败） -->
          <div v-if="panel.collectError && !panel.session" class="bh-feedback error" role="alert">
            <div class="bh-feedback-body">
              <span class="bh-feedback-title">视频资料拉取失败</span>
              <span class="bh-feedback-hint">网络或页面状态异常，稍后重试</span>
            </div>
            <button type="button" class="bh-link" @click="panelActions.retryCollection()">
              重试
            </button>
          </div>
          <template v-else>
            <div
              v-show="activeTab === 'summary'"
              id="bh-tabpanel-summary"
              role="tabpanel"
              aria-labelledby="bh-tab-summary"
            >
              <SummaryTab :key="sessionKey" />
            </div>
            <div
              v-show="activeTab === 'chat'"
              id="bh-tabpanel-chat"
              role="tabpanel"
              aria-labelledby="bh-tab-chat"
            >
              <ChatTab :key="sessionKey" />
            </div>
          </template>
        </div>
      </section>
    </div>
  </div>
</template>