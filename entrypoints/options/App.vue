<script setup lang="ts">
// AI 助手组真实表单：对话/向量端点（继承态虚线提示）、运行模式单选（server 字段条件显示）、
// 双端点独立拉取模型、测试连接红绿反馈条、保存。端点读写只经 modules/settings 助手。
// 其余分组（服务器独立页签/过滤/净化/布局/增强）仍为占位，待后续故事落地。

import { computed, onMounted, reactive, ref } from 'vue'
import { testChatEndpoint, testEmbeddingEndpoint } from '../../modules/ai/endpoint-test'
import type { EndpointTestResult } from '../../modules/ai/endpoint-test'
import { listModels } from '../../modules/ai/llm/client'
import { readAiSettings, resolveEmbeddingEndpoint, writeAiSettings } from '../../modules/settings'
import type { AiMode } from '../../modules/settings'

const groups = ['AI 助手', '服务器', '过滤', '净化', '布局', '增强']
const active = ref<string>(groups[0] ?? 'AI 助手')

const MODES: { value: AiMode; name: string; description: string }[] = [
  { value: 'local', name: '本地直连', description: 'AI 流量从浏览器直发下面的自定义端点' },
  { value: 'server', name: '自建服务', description: '请求统一转发到你的服务器端点' },
  { value: 'auto', name: '智能首选', description: '先走服务器，失败自动回退本地直连' },
]

interface FormModel {
  apiUrl: string
  apiKey: string
  model: string
  embedBaseUrl: string
  embedKey: string
  embedModel: string
  mode: AiMode
  serverBaseUrl: string
  serverToken: string
  adSkipEnabled: boolean
  panelEnabled: boolean
}

const form = reactive<FormModel>({
  apiUrl: '',
  apiKey: '',
  model: '',
  embedBaseUrl: '',
  embedKey: '',
  embedModel: '',
  mode: 'local',
  serverBaseUrl: '',
  serverToken: '',
  adSkipEnabled: false,
  panelEnabled: true,
})

const loadError = ref('')

onMounted(async () => {
  try {
    const settings = await readAiSettings()
    form.apiUrl = settings.apiUrl
    form.apiKey = settings.apiKey
    form.model = settings.model
    form.embedBaseUrl = settings.embedBaseUrl
    form.embedKey = settings.embedKey
    form.embedModel = settings.embedModel
    form.mode = settings.mode
    form.serverBaseUrl = settings.serverBaseUrl
    form.serverToken = settings.serverToken
    form.adSkipEnabled = settings.adSkipEnabled
    form.panelEnabled = settings.panelEnabled
  } catch {
    // 读取失败要给可见提示，而不是静默留下空表单。
    loadError.value = '设置加载失败，请刷新重试'
  }
})

// server 字段只在 mode=server/auto 时展示，local 整块隐藏。
const showServerFields = computed(() => form.mode === 'server' || form.mode === 'auto')

// 向量端点读侧解析：空字段继承对话端点（与 settings 模块同语义，仅展示、不回写）。
const resolvedEmbed = computed(() => resolveEmbeddingEndpoint(form))

const embedBaseInherits = computed(() => form.embedBaseUrl.trim() === '')
const embedKeyInherits = computed(() => form.embedKey.trim() === '')
const embedModelInherits = computed(() => form.embedModel.trim() === '')

const embedBaseHint = computed(() =>
  resolvedEmbed.value.baseUrl ? `继承：${resolvedEmbed.value.baseUrl}` : '继承：尚未配置对话端点',
)
const embedKeyHint = computed(() =>
  resolvedEmbed.value.apiKey ? '继承：对话端点的 API Key' : '继承：尚未配置对话端点',
)
const embedModelHint = computed(() =>
  resolvedEmbed.value.model ? `继承：${resolvedEmbed.value.model}` : '继承：尚未配置对话端点',
)

const FETCH_MODELS_HINT = '拉不到模型列表，直接手动输入模型名也行'

const chatModelOptions = ref<string[]>([])
const embedModelOptions = ref<string[]>([])
const chatModelsLoading = ref(false)
const embedModelsLoading = ref(false)
const chatModelsHint = ref('')
const embedModelsHint = ref('')

async function fetchChatModels(): Promise<void> {
  chatModelsLoading.value = true
  chatModelsHint.value = ''
  try {
    // 拉取失败不阻塞：退回手动输入（组合框保持可输入）。
    chatModelOptions.value = await listModels({ baseUrl: form.apiUrl, apiKey: form.apiKey })
  } catch {
    chatModelsHint.value = FETCH_MODELS_HINT
  } finally {
    chatModelsLoading.value = false
  }
}

async function fetchEmbedModels(): Promise<void> {
  embedModelsLoading.value = true
  embedModelsHint.value = ''
  try {
    const endpoint = resolveEmbeddingEndpoint(form)
    embedModelOptions.value = await listModels({ baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey })
  } catch {
    embedModelsHint.value = FETCH_MODELS_HINT
  } finally {
    embedModelsLoading.value = false
  }
}

type Feedback = { kind: 'ok' | 'fail'; text: string }

const testing = ref(false)
const chatFeedback = ref<Feedback | null>(null)
const embedFeedback = ref<Feedback | null>(null)

function renderFeedback(label: string, result: EndpointTestResult): Feedback {
  if (result.ok) return { kind: 'ok', text: `${label}连接成功 · ${result.model} 响应 ${result.ms}ms` }
  return { kind: 'fail', text: `${label}连接失败 · ${result.reason}` }
}

async function runTests(): Promise<void> {
  testing.value = true
  chatFeedback.value = null
  embedFeedback.value = null
  try {
    // 向量端点按继承解析后的值探测；对话端点用表单原值——两端点独立出结果。
    const embed = resolveEmbeddingEndpoint(form)
    const [chatResult, embedResult] = await Promise.all([
      testChatEndpoint({ baseUrl: form.apiUrl, model: form.model, apiKey: form.apiKey }),
      testEmbeddingEndpoint({ baseUrl: embed.baseUrl, model: embed.model, apiKey: embed.apiKey }),
    ])
    chatFeedback.value = renderFeedback('对话端点', chatResult)
    embedFeedback.value = renderFeedback('向量端点', embedResult)
  } finally {
    // 无论探测结果如何，按钮都要从「测试中…」恢复。
    testing.value = false
  }
}

let saveTimer: number | undefined
const saveHint = ref('')

async function save(): Promise<void> {
  try {
    await writeAiSettings({ ...form })
    saveHint.value = '已保存'
  } catch {
    // 写入失败要有明确提示而不是静默吞掉。
    saveHint.value = '保存失败，请重试'
  }
  if (saveTimer !== undefined) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveHint.value = ''
    saveTimer = undefined
  }, 2000)
}
</script>

<template>
  <div class="options-shell">
    <nav class="sidebar" aria-label="设置分组">
      <span class="sidebar-title">设置</span>
      <button
        v-for="group in groups"
        :key="group"
        type="button"
        class="sidebar-item"
        :class="{ active: group === active }"
        :aria-current="group === active ? 'page' : undefined"
        @click="active = group"
      >
        {{ group }}
      </button>
    </nav>

    <main class="content">
      <template v-if="active === 'AI 助手'">
        <header class="content-head">
          <h1>AI 助手</h1>
          <p class="content-sub">模型端点与运行模式 · 直连 OpenAI 兼容端点</p>
        </header>

        <p v-if="loadError" class="load-error" role="alert">{{ loadError }}</p>

        <section class="card" aria-labelledby="chat-endpoint-title">
          <h2 id="chat-endpoint-title" class="card-title">对话端点（总结 / 提问）</h2>
          <label class="field">
            <span class="field-label">Base URL</span>
            <input v-model.trim="form.apiUrl" type="url" placeholder="https://api.openai.com/v1" />
          </label>
          <label class="field">
            <span class="field-label">API Key</span>
            <input v-model="form.apiKey" type="password" placeholder="sk-…" autocomplete="off" />
          </label>
          <div class="field">
            <span class="field-label">模型</span>
            <div class="combo-row">
              <input
                v-model.trim="form.model"
                list="chat-model-options"
                placeholder="gpt-4o-mini"
                class="grow"
              />
              <datalist id="chat-model-options">
                <option v-for="id in chatModelOptions" :key="id" :value="id" />
              </datalist>
              <button
                type="button"
                class="ghost"
                :disabled="chatModelsLoading"
                @click="fetchChatModels"
              >
                {{ chatModelsLoading ? '拉取中…' : '拉取模型' }}
              </button>
            </div>
            <span v-if="chatModelsHint" class="field-hint">{{ chatModelsHint }}</span>
          </div>
        </section>

        <section class="card" aria-labelledby="embed-endpoint-title">
          <h2 id="embed-endpoint-title" class="card-title">向量端点（语义分段检索）</h2>
          <label class="field">
            <span class="field-label">Base URL</span>
            <input
              v-model.trim="form.embedBaseUrl"
              type="url"
              placeholder="留空则继承对话端点"
              :class="{ inheriting: embedBaseInherits }"
            />
            <span v-if="embedBaseInherits" class="field-hint">{{ embedBaseHint }}</span>
          </label>
          <label class="field">
            <span class="field-label">API Key</span>
            <input
              v-model="form.embedKey"
              type="password"
              placeholder="留空则继承对话端点"
              :class="{ inheriting: embedKeyInherits }"
              autocomplete="off"
            />
            <span v-if="embedKeyInherits" class="field-hint">{{ embedKeyHint }}</span>
          </label>
          <div class="field">
            <span class="field-label">嵌入模型</span>
            <div class="combo-row">
              <input
                v-model.trim="form.embedModel"
                list="embed-model-options"
                placeholder="留空则继承对话端点"
                class="grow"
                :class="{ inheriting: embedModelInherits }"
              />
              <datalist id="embed-model-options">
                <option v-for="id in embedModelOptions" :key="id" :value="id" />
              </datalist>
              <button
                type="button"
                class="ghost"
                :disabled="embedModelsLoading"
                @click="fetchEmbedModels"
              >
                {{ embedModelsLoading ? '拉取中…' : '拉取模型' }}
              </button>
            </div>
            <span v-if="embedModelInherits && !embedModelsHint" class="field-hint">
              {{ embedModelHint }}
            </span>
            <span v-if="embedModelsHint" class="field-hint">{{ embedModelsHint }}</span>
          </div>
        </section>

        <section class="card" aria-labelledby="mode-title">
          <h2 id="mode-title" class="card-title">运行模式</h2>
          <p class="card-note">决定 AI 请求走哪条通道，不影响总结的触发时机（一律手动触发）。</p>
          <div class="mode-cards" role="radiogroup" aria-label="运行模式">
            <label
              v-for="mode in MODES"
              :key="mode.value"
              class="mode-card"
              :class="{ active: form.mode === mode.value }"
            >
              <input v-model="form.mode" type="radio" name="mode" :value="mode.value" />
              <span class="mode-name">{{ mode.name }}</span>
              <span class="mode-desc">{{ mode.description }}</span>
            </label>
          </div>
        </section>

        <section class="card" aria-labelledby="features-title">
          <h2 id="features-title" class="card-title">功能开关</h2>
          <label class="switch-row">
            <span class="switch-info">
              <span class="switch-name">AI 去广告</span>
              <span class="field-hint">
                识别并自动跳过恰饭段。默认关闭，请先配好上方端点再开启；popup 里的「AI
                去广告」开关只对当前页临时生效，这里的总开关控制所有页。
              </span>
            </span>
            <span class="switch">
              <input v-model="form.adSkipEnabled" type="checkbox" aria-label="AI 去广告总开关" />
              <span class="switch-track" aria-hidden="true" />
              <span class="switch-knob" aria-hidden="true" />
            </span>
          </label>
          <label class="switch-row">
            <span class="switch-info">
              <span class="switch-name">AI 面板显示</span>
              <span class="field-hint">
                在视频页右侧显示「总结 / 提问」面板（被动 UI，默认开启）。popup
                里的「总结面板」开关只对当前页临时生效，这里的总开关控制所有页。
              </span>
            </span>
            <span class="switch">
              <input v-model="form.panelEnabled" type="checkbox" aria-label="AI 面板显示总开关" />
              <span class="switch-track" aria-hidden="true" />
              <span class="switch-knob" aria-hidden="true" />
            </span>
          </label>
        </section>

        <section v-if="showServerFields" class="card" aria-labelledby="server-fields-title">
          <h2 id="server-fields-title" class="card-title">服务器转发</h2>
          <p class="card-note">
            server 模式全部请求经此端点转发；auto 模式服务器失败时自动回退本地直连。
          </p>
          <label class="field">
            <span class="field-label">Server Base URL</span>
            <input
              v-model.trim="form.serverBaseUrl"
              type="url"
              placeholder="https://your-service.example.com"
            />
          </label>
          <label class="field">
            <span class="field-label">Server Token</span>
            <input v-model="form.serverToken" type="password" placeholder="可留空" autocomplete="off" />
            <span class="field-hint">非空时所有转发请求统一携带 Authorization: Bearer ⟨token⟩。</span>
          </label>
        </section>

        <section class="card" aria-labelledby="test-title">
          <h2 id="test-title" class="card-title">连接测试</h2>
          <p class="card-note">用最小请求分别探测对话与向量端点，向量端点按继承后的值测试。</p>
          <button type="button" class="ghost" :disabled="testing" @click="runTests">
            {{ testing ? '测试中…' : '测试连接' }}
          </button>
          <div aria-live="polite">
            <div v-if="chatFeedback" class="feedback" :class="chatFeedback.kind">
              <span class="dot" aria-hidden="true" />
              <span>{{ chatFeedback.text }}</span>
            </div>
            <div v-if="embedFeedback" class="feedback" :class="embedFeedback.kind">
              <span class="dot" aria-hidden="true" />
              <span>{{ embedFeedback.text }}</span>
            </div>
          </div>
        </section>

        <div class="actions">
          <button type="button" class="primary" @click="save">保存设置</button>
          <span v-if="saveHint" class="field-hint" aria-live="polite">{{ saveHint }}</span>
        </div>
      </template>

      <template v-else>
        <header class="content-head">
          <h1>{{ active }}</h1>
          <p class="content-sub">该分组的配置将在后续实现。</p>
        </header>
      </template>
    </main>
  </div>
</template>

<style scoped>
.options-shell {
  display: flex;
  min-height: 100vh;
  background: linear-gradient(135deg, #eeeaf7 0%, #fbeff2 55%, #fff3e8 100%);
  font-family:
    'PingFang SC',
    'HarmonyOS Sans SC',
    'Microsoft YaHei',
    system-ui,
    sans-serif;
  color: #2e2a3b;
}

.sidebar {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 200px;
  padding: 16px;
  flex-shrink: 0;
}

.sidebar-title {
  font-weight: 700;
  padding: 4px 8px 12px;
  color: #2e2a3b;
}

.sidebar-item {
  text-align: left;
  padding: 8px 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  font-size: 14px;
  color: #6f6a80;
}

.sidebar-item:hover {
  background: #f1edff;
}

.sidebar-item.active {
  background: #f1edff;
  color: #7c5cfc;
  font-weight: 600;
}

.content {
  flex: 1;
  padding: 32px 40px;
  max-width: 840px;
}

.content-head {
  margin-bottom: 16px;
}

.content-head h1 {
  margin: 0 0 4px;
  font-size: 20px;
}

.content-sub {
  margin: 0;
  color: #6f6a80;
  font-size: 13px;
}

.load-error {
  color: #e5484d;
  font-size: 13px;
  margin: 0 0 16px;
}

.card {
  background: rgba(255, 255, 255, 0.62);
  border: 1px solid rgba(255, 255, 255, 0.8);
  border-radius: 16px;
  padding: 20px 24px;
  margin-bottom: 16px;
  box-shadow: 0 8px 24px rgba(124, 92, 252, 0.06);
  backdrop-filter: blur(12px);
}

.card-title {
  font-size: 13px;
  font-weight: 700;
  margin: 0 0 4px;
}

.card-note {
  font-size: 12.5px;
  color: #736b8a;
  margin: 0 0 14px;
  line-height: 1.7;
}

.field {
  display: block;
  margin-bottom: 14px;
}

.field:last-child {
  margin-bottom: 0;
}

.field-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: #6f6a80;
  margin-bottom: 6px;
}

input {
  width: 100%;
  max-width: 420px;
  box-sizing: border-box;
  padding: 9px 12px;
  border-radius: 10px;
  border: 1px solid #e3def0;
  background: #ffffff;
  font-size: 13.5px;
  font-family: inherit;
  color: #2e2a3b;
  outline: none;
}

input:focus {
  border-color: #7c5cfc;
  box-shadow: 0 0 0 3px rgba(124, 92, 252, 0.12);
}

input.inheriting {
  border-style: dashed;
  background: rgba(255, 255, 255, 0.55);
  color: #736b8a;
}

.combo-row {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 420px;
}

.combo-row .grow {
  flex: 1;
}

.field-hint {
  display: block;
  font-size: 12px;
  color: #736b8a;
  margin-top: 6px;
}

button {
  font-family: inherit;
}

button:focus-visible,
input:focus-visible {
  outline: 2px solid #7c5cfc;
  outline-offset: 2px;
}

.ghost {
  border: 1px solid #e3def0;
  background: rgba(255, 255, 255, 0.7);
  border-radius: 10px;
  padding: 9px 14px;
  font-size: 12.5px;
  color: #7c5cfc;
  cursor: pointer;
  white-space: nowrap;
}

.ghost:hover:not(:disabled) {
  background: #f1edff;
}

.ghost:disabled {
  opacity: 0.6;
  cursor: default;
}

.mode-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.mode-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px;
  border: 1px solid #e3def0;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.55);
  cursor: pointer;
}

.mode-card:hover {
  border-color: #b47cf5;
}

.mode-card.active {
  border-color: #7c5cfc;
  background: #f1edff;
  box-shadow: 0 4px 14px rgba(124, 92, 252, 0.16);
}

.mode-card:focus-within {
  outline: 2px solid #7c5cfc;
  outline-offset: 2px;
}

.mode-card input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.mode-name {
  font-weight: 700;
  font-size: 13.5px;
}

.mode-desc {
  font-size: 12px;
  color: #736b8a;
  line-height: 1.6;
}

/* 总开关：track 36×20 胶囊 + 16px 白圆 knob，开态渐变（与 popup 快开关同源视觉）。 */
.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  cursor: pointer;
}

.switch-row + .switch-row {
  margin-top: 14px;
}

.switch-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.switch-name {
  font-size: 13.5px;
  font-weight: 600;
  color: #2e2a3b;
}

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

.switch input:focus-visible ~ .switch-track {
  outline: 2px solid #7c5cfc;
  outline-offset: 2px;
}

.feedback {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding: 10px 14px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.6;
}

.feedback.ok {
  background: #e9f6ee;
  color: #2fa96b;
  border: 1px solid rgba(85, 212, 143, 0.35);
}

.feedback.fail {
  background: #fdecee;
  color: #e5484d;
  border: 1px solid rgba(255, 143, 163, 0.35);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentcolor;
  box-shadow: 0 0 6px currentcolor;
  flex-shrink: 0;
}

.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 0 24px;
}

.primary {
  border: none;
  background: linear-gradient(135deg, #7452f4, #b47cf5);
  color: #ffffff;
  border-radius: 10px;
  padding: 10px 22px;
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(124, 92, 252, 0.35);
}

.primary:hover {
  filter: brightness(1.05);
}
</style>