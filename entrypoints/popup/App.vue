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

const pageState = ref<AdSkipPageState | null>(null)
const panelPageState = ref<PanelPageState | null>(null)
const savedText = ref('')
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
  font-family: 'PingFang SC', 'HarmonyOS Sans SC', 'Microsoft YaHei', system-ui, sans-serif;
  color: #2e2a3b;
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
  color: #736b8a;
  line-height: 1.6;
}

.achievement-row {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  font-weight: 500;
  color: #2e2a3b;
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(255, 243, 232, 0.9);
}

.ach-orb {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: linear-gradient(135deg, #7c5cfc, #ff8fb1);
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
  background: #e3def0;
  transition: background 180ms ease;
}

.switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  transition: transform 180ms ease;
}

.switch input:checked ~ .switch-track {
  background: linear-gradient(135deg, #7c5cfc, #ff8fb1);
}

.switch input:checked ~ .switch-knob {
  transform: translateX(16px);
}

.switch.disabled {
  opacity: 0.55;
}

.switch input:focus-visible ~ .switch-track {
  outline: 2px solid #7c5cfc;
  outline-offset: 2px;
}

.switch input:disabled {
  cursor: default;
}

.open-options {
  padding: 8px 12px;
  border: none;
  border-radius: 9999px;
  background: #7c5cfc;
  color: #fff;
  cursor: pointer;
  font-size: 13px;
}

.open-options:hover {
  background: #7452f4;
}
</style>