<script setup lang="ts">
// popup：极简弹窗——当前页「AI 去广告」「总结面板」两条快开关（页内开关，经 background 转发给
// 内容脚本，不跨页持久化）+ 成就行（今日累计节省）+ 打开设置页。无官方入口、无每日一言。
import { onMounted, ref } from 'vue'
import { browser } from 'wxt/browser'
import {
  MSG_AD_SKIP_PAGE_STATE,
  MSG_AD_SKIP_PAGE_TOGGLE,
  MSG_PANEL_PAGE_STATE,
  MSG_PANEL_PAGE_TOGGLE,
  UNAVAILABLE_PANEL_STATE,
  UNAVAILABLE_STATE,
  isPageState,
  isPanelPageState,
  isPanelToggleResponse,
  isToggleResponse,
} from '../../modules/content/protocol'
import type { AdSkipPageState, PanelPageState } from '../../modules/content/protocol'
import { readDailyStats } from '../../modules/content/stats'
import { savedChipText, todayString } from '../../modules/content/logic'
import { readFeatureStats } from '../../modules/features/config'

const pageState = ref<AdSkipPageState | null>(null)
const panelPageState = ref<PanelPageState | null>(null)
const savedText = ref('')
const blockedText = ref('')
const busy = ref(false)

function refreshStateFrom(response: unknown, panelMessage: boolean): void {
  if (panelMessage) {
    panelPageState.value = isPanelPageState(response)
      ? response
      : UNAVAILABLE_PANEL_STATE
    return
  }
  pageState.value = isPageState(response) ? response : UNAVAILABLE_STATE
}

function unavailableNow(panelMessage: boolean): void {
  if (panelMessage) panelPageState.value = UNAVAILABLE_PANEL_STATE
  else pageState.value = UNAVAILABLE_STATE
}

async function refreshPageState(): Promise<void> {
  try {
    const response: unknown = await browser.runtime.sendMessage({ type: MSG_AD_SKIP_PAGE_STATE })
    refreshStateFrom(response, false)
  } catch {
    unavailableNow(false)
  }
}

async function refreshPanelState(): Promise<void> {
  try {
    const response: unknown = await browser.runtime.sendMessage({ type: MSG_PANEL_PAGE_STATE })
    refreshStateFrom(response, true)
  } catch {
    unavailableNow(true)
  }
}

async function togglePageSkip(enabled: boolean): Promise<void> {
  busy.value = true
  try {
    const response: unknown = await browser.runtime.sendMessage({
      type: MSG_AD_SKIP_PAGE_TOGGLE,
      enabled,
    })
    if (isToggleResponse(response)) pageState.value = response.state
    else pageState.value = UNAVAILABLE_STATE
  } catch {
    pageState.value = UNAVAILABLE_STATE
  } finally {
    busy.value = false
  }
}

async function togglePagePanel(enabled: boolean): Promise<void> {
  busy.value = true
  try {
    const response: unknown = await browser.runtime.sendMessage({
      type: MSG_PANEL_PAGE_TOGGLE,
      enabled,
    })
    if (isPanelToggleResponse(response)) panelPageState.value = response.state
    else panelPageState.value = UNAVAILABLE_PANEL_STATE
  } catch {
    panelPageState.value = UNAVAILABLE_PANEL_STATE
  } finally {
    busy.value = false
  }
}

const skipSwitchDisabled = () => {
  if (busy.value || !pageState.value) return true
  return !pageState.value.available || !pageState.value.masterEnabled
}

const panelSwitchDisabled = () => {
  if (busy.value || !panelPageState.value) return true
  return !panelPageState.value.available || !panelPageState.value.masterEnabled
}

async function openOptions() {
  await browser.runtime.openOptionsPage().catch(() => {
    // 设置页不可打开时静默。
  })
}

onMounted(async () => {
  await refreshPageState()
  await refreshPanelState()
  const retryDue =
    !pageState.value?.available || !panelPageState.value?.available
  if (retryDue) {
    // 内容脚本可能还没注入完：不可用时稍候重试一次，避免永久卡在「不是视频页」。
    window.setTimeout(() => {
      void refreshPageState()
      void refreshPanelState()
    }, 800)
  }
  const stats = await readDailyStats()
  if (stats && stats.date === todayString() && stats.savedSeconds > 0) {
    savedText.value = savedChipText(stats.savedSeconds)
  }
  // 「今日拦截」：广告 + 推广两个 DOM 拦截器的日统计；拦截到才显示（0 条不占行）。
  try {
    const featureStats = await readFeatureStats()
    const ad = featureStats.adVideoBlocker?.totalBlocked ?? 0
    const promoted = featureStats.promotedVideoBlocker?.totalBlocked ?? 0
    const total = ad + promoted
    if (total > 0) {
      blockedText.value = `今日拦截推广 ${total} 条${ad > 0 ? `（广告 ${ad}` : ''}${ad > 0 && promoted > 0 ? ' · ' : ''}${promoted > 0 ? `小火箭 ${promoted}` : ''}${ad > 0 || promoted > 0 ? '）' : ''}`
    }
  } catch {
    // 统计读失败不显示该行（弹窗其余功能不受影响）。
  }
})
</script>

<template>
  <div class="popup-shell">
    <div class="popup-row">
      <span class="row-label">AI 去广告</span>
      <label class="switch" :class="{ disabled: skipSwitchDisabled() }">
        <input
          type="checkbox"
          :checked="pageState?.pageEnabled === true"
          :disabled="skipSwitchDisabled()"
          @change="togglePageSkip(($event.target as HTMLInputElement).checked)"
        />
        <span class="switch-track" aria-hidden="true" />
        <span class="switch-knob" aria-hidden="true" />
      </label>
    </div>
    <p class="hint">
      {{
        !pageState
          ? '正在读取当前页状态…'
          : !pageState.available
            ? '当前页不是 B 站视频页'
            : !pageState.masterEnabled
              ? '未在设置页开启 AI 去广告'
              : pageState.pageEnabled
                ? '本页自动跳过恰饭段'
                : '本页已关闭 · 仅对当前页生效'
      }}
    </p>

    <div class="popup-row">
      <span class="row-label">总结面板</span>
      <label class="switch" :class="{ disabled: panelSwitchDisabled() }">
        <input
          type="checkbox"
          :checked="panelPageState?.pageEnabled === true"
          :disabled="panelSwitchDisabled()"
          @change="togglePagePanel(($event.target as HTMLInputElement).checked)"
        />
        <span class="switch-track" aria-hidden="true" />
        <span class="switch-knob" aria-hidden="true" />
      </label>
    </div>
    <p class="hint">
      {{
        !panelPageState
          ? '正在读取当前页状态…'
          : !panelPageState.available
            ? '当前页不是 B 站视频页'
            : !panelPageState.masterEnabled
              ? '未在设置页开启 AI 面板'
              : panelPageState.pageEnabled
                ? '本页显示总结 / 提问面板'
                : '本页已隐藏 · 仅对当前页生效'
      }}
    </p>

    <div v-if="savedText" class="achievement-row">
      <span class="ach-orb" aria-hidden="true" />
      <span>{{ savedText }}</span>
    </div>
    <div v-if="blockedText" class="achievement-row">
      <span class="ach-orb" aria-hidden="true" />
      <span>{{ blockedText }}</span>
    </div>
    <button type="button" class="open-options" @click="openOptions">打开设置页</button>
  </div>
</template>

<style scoped>
.popup-shell {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 240px;
  padding: 16px;
  color: var(--bh-text-primary);
}

.popup-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.popup-row + .hint {
  margin-top: -8px;
}

.row-label {
  font-size: 13.5px;
  font-weight: 600;
}

.hint {
  margin: 0;
  font-size: 11.5px;
  color: var(--bh-text-muted);
  line-height: 1.6;
}

.achievement-row {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  font-weight: 500;
  color: var(--bh-text-primary);
  padding: 6px 10px;
  border-radius: 999px;
  background: var(--bh-surface-warm);
}

.ach-orb {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--bh-primary), var(--bh-accent-pink));
  flex-shrink: 0;
}

/* 快开关：track 36×20 胶囊 + 16px 白圆 knob，开态渐变（popup 快开关视觉基准）。 */
.switch {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  flex-shrink: 0;
}

.switch input {
  position: absolute;
  inset: 0;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.switch-track {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: var(--bh-border-hairline);
  transition: background 180ms ease;
}

.switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--bh-surface-knob);
  box-shadow: 0 1px 3px var(--bh-shadow-knob);
  transition: transform 180ms ease;
}

.switch input:checked ~ .switch-track {
  background: linear-gradient(135deg, var(--bh-primary), var(--bh-accent-pink));
}

.switch input:checked ~ .switch-knob {
  transform: translateX(16px);
}

.switch.disabled {
  opacity: 0.55;
}

.switch input:focus-visible ~ .switch-track {
  outline: 2px solid var(--bh-primary);
  outline-offset: 2px;
}

.switch input:disabled {
  cursor: default;
}

.open-options {
  padding: 8px 12px;
  border: none;
  border-radius: 9999px;
  background: var(--bh-primary);
  color: var(--bh-text-on-accent);
  cursor: pointer;
  font-size: 13px;
}

.open-options:hover {
  background: var(--bh-primary-deep);
}
</style>