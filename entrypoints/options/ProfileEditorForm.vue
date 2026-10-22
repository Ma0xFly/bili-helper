<script setup lang="ts">
// 新建配置方案用的独立表单：一张**空白**新表，与主工作表单（对话端点栏）完全隔离。
//
// 为什么独立成一张表：旧交互是「另存为方案」——先改脏正在用的端点配置，再命名存档。
// 建一个方案得先把工作配置改掉，改到一半又怕存错，两套意图挤在同一张表里。
// 现在建方案只填这张表：不动主表单，不影响正在用的配置。
//
// 字段与主表单的连接字段一一对应（profileSettingsOf 的 10 个字段），
// 留空即「继承/不设」——向量端点三项留空表示继承对话端点，服务器留空表示不用转发。
import { computed, reactive, ref } from 'vue'
import { listModels } from '../../modules/ai/llm/client'
import ModelCombo from './ModelCombo.vue'

/** 服务商预设：与主表单同源（一键填地址），模型名只作 placeholder 不自动写入。 */
const CHAT_PRESETS: { name: string; url: string; model?: string }[] = [
  { name: 'DeepSeek', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: '硅基流动 SiliconFlow', url: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  { name: 'Kimi（月之暗面）', url: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0711-preview' },
  { name: '通义千问（兼容模式）', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: '智谱 GLM', url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.5-air' },
  { name: '火山方舟（豆包）', url: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seed-1-6-flash' },
  { name: 'Ollama（本机）', url: 'http://localhost:11434/v1', model: 'qwen3:8b' },
  { name: 'LM Studio（本机）', url: 'http://localhost:1234/v1' },
]

/** 新表里的连接字段（与 AiProfileSettings 同构；这里不引 settings 模块，避免耦合到主设置类型）。 */
export interface ProfileDraft {
  apiUrl: string
  apiKey: string
  model: string
  apiFormat: 'openai' | 'anthropic'
  embedBaseUrl: string
  embedModel: string
  embedKey: string
  mode: 'local' | 'server' | 'auto'
  serverBaseUrl: string
  serverToken: string
}

const props = defineProps<{
  /** 已有方案名：同名时按钮改成「覆盖方案」——建方案时一眼看出会不会顶掉旧的。 */
  existingNames?: string[]
}>()

const emit = defineEmits<{
  /** 提交一份填好的新方案（字段形状与 AiProfileSettings 一致）。 */
  submit: [payload: { name: string; draft: ProfileDraft }]
}>()

const draft = reactive<ProfileDraft>({
  apiUrl: '',
  apiKey: '',
  model: '',
  apiFormat: 'openai',
  embedBaseUrl: '',
  embedModel: '',
  embedKey: '',
  mode: 'local',
  serverBaseUrl: '',
  serverToken: '',
})

const profileName = ref('')
const modelOptions = ref<string[]>([])
const modelsLoading = ref(false)
const modelsHint = ref('')
const formHint = ref('')

const presetName = computed(
  () => CHAT_PRESETS.find((preset) => preset.url === draft.apiUrl)?.name ?? 'custom',
)
const modelPlaceholder = computed(
  () => CHAT_PRESETS.find((preset) => preset.url === draft.apiUrl)?.model ?? 'gpt-4o-mini',
)

/** 同名覆盖预警：名字撞上已有方案时按钮与提示都改口，别让人以为建了个新的。 */
const overwritesExisting = computed(
  () => profileName.value.trim() !== '' && (props.existingNames ?? []).includes(profileName.value.trim()),
)

function onPresetChange(event: Event): void {
  const name = (event.target as HTMLSelectElement).value
  const preset = CHAT_PRESETS.find((item) => item.name === name)
  if (preset) draft.apiUrl = preset.url
}

async function fetchModels(): Promise<void> {
  modelsLoading.value = true
  modelsHint.value = ''
  try {
    modelOptions.value = await listModels({
      baseUrl: draft.apiUrl,
      apiKey: draft.apiKey,
      format: draft.apiFormat,
    })
  } catch {
    // 拉不到不阻塞：退回手动输入（组合框保持可输入）。
    modelsHint.value =
      '拉不到模型列表：该端点可能不提供列表接口（如火山方舟 Coding 这类专用网关），直接手动输入模型名即可'
  } finally {
    modelsLoading.value = false
  }
}

/**
 * 提交前的本地校验：方案会整体覆盖回主设置，空端点/空模型的方案一旦应用，
 * 等于把正在用的连接清空——所以这两项必填（向量端点与服务器留空仍然合法）。
 */
function onSubmit(): void {
  formHint.value = ''
  if (profileName.value.trim() === '') {
    formHint.value = '先给方案起个名字'
    return
  }
  if (draft.apiUrl.trim() === '') {
    formHint.value = '填一个 Base URL：方案应用后就是拿它去请求'
    return
  }
  if (draft.model.trim() === '') {
    formHint.value = '填一个模型名：端点有了还得指明用哪个模型'
    return
  }
  emit('submit', { name: profileName.value.trim(), draft: { ...draft } })
}

/** 保存成功后清空整张表（下次建方案仍从零填，不留半截旧值）。 */
function reset(): void {
  profileName.value = ''
  draft.apiUrl = ''
  draft.apiKey = ''
  draft.model = ''
  draft.apiFormat = 'openai'
  draft.embedBaseUrl = ''
  draft.embedModel = ''
  draft.embedKey = ''
  draft.mode = 'local'
  draft.serverBaseUrl = ''
  draft.serverToken = ''
  modelOptions.value = []
  modelsHint.value = ''
  formHint.value = ''
}

defineExpose({ reset })
</script>

<template>
  <div class="profile-editor">
    <div class="profile-editor-head">
      <h3 class="profile-editor-title">新建方案</h3>
      <p class="profile-editor-note">
        在这张新表里填一套连接配置，存成命名方案——不影响上方正在用的端点配置。
      </p>
    </div>

    <label class="field">
      <span class="field-label">方案名</span>
      <input
        v-model.trim="profileName"
        type="text"
        placeholder="如：硅基流动·本地直连"
        aria-label="新建方案名称"
      />
    </label>

    <div class="field">
      <span class="field-label">服务商预设</span>
      <select :value="presetName" aria-label="新建方案服务商预设" @change="onPresetChange">
        <option value="custom">自定义（手动填写）</option>
        <option v-for="preset in CHAT_PRESETS" :key="preset.name" :value="preset.name">
          {{ preset.name }}
        </option>
      </select>
    </div>

    <div class="field">
      <span class="field-label">API 协议</span>
      <select v-model="draft.apiFormat" aria-label="新建方案 API 协议">
        <option value="openai">OpenAI 兼容（chat/completions）</option>
        <option value="anthropic">Anthropic Messages（messages）</option>
      </select>
    </div>

    <label class="field">
      <span class="field-label">Base URL</span>
      <input
        v-model.trim="draft.apiUrl"
        type="url"
        placeholder="https://api.openai.com/v1"
        aria-label="新建方案 Base URL"
      />
    </label>

    <label class="field">
      <span class="field-label">API Key</span>
      <input
        v-model="draft.apiKey"
        type="password"
        placeholder="sk-…"
        aria-label="新建方案 API Key"
        autocomplete="off"
      />
    </label>

    <div class="field">
      <span class="field-label">模型</span>
      <div class="combo-row">
        <ModelCombo
          v-model="draft.model"
          :options="modelOptions"
          :loading="modelsLoading"
          :placeholder="modelPlaceholder"
          label="新建方案模型"
        />
        <button type="button" class="ghost" :disabled="modelsLoading" @click="fetchModels">
          {{ modelsLoading ? '拉取中…' : '拉取模型' }}
        </button>
      </div>
      <span v-if="modelsHint" class="field-hint">{{ modelsHint }}</span>
    </div>

    <details class="profile-advanced">
      <summary>向量端点与服务器（留空即不设）</summary>
      <label class="field">
        <span class="field-label">向量 Base URL</span>
        <input
          v-model.trim="draft.embedBaseUrl"
          type="url"
          placeholder="留空则继承本方案的对话端点"
        />
      </label>
      <label class="field">
        <span class="field-label">向量 API Key</span>
        <input
          v-model="draft.embedKey"
          type="password"
          placeholder="留空则继承本方案的对话 Key"
          autocomplete="off"
        />
      </label>
      <label class="field">
        <span class="field-label">向量模型</span>
        <input v-model.trim="draft.embedModel" type="text" placeholder="留空则继承本方案的对话模型" />
      </label>
      <div class="field">
        <span class="field-label">运行模式</span>
        <select v-model="draft.mode" aria-label="新建方案运行模式">
          <option value="local">浏览器直连</option>
          <option value="server">服务器转发</option>
          <option value="auto">服务器转发 · 失败回退</option>
        </select>
      </div>
      <template v-if="draft.mode !== 'local'">
        <label class="field">
          <span class="field-label">Server Base URL</span>
          <input
            v-model.trim="draft.serverBaseUrl"
            type="url"
            placeholder="https://your-service.example.com"
          />
        </label>
        <label class="field">
          <span class="field-label">Server Token</span>
          <input v-model="draft.serverToken" type="password" placeholder="可留空" autocomplete="off" />
        </label>
      </template>
    </details>

    <div class="profile-editor-actions">
      <button
        type="button"
        class="profile-editor-submit"
        :disabled="profileName.trim() === ''"
        @click="onSubmit"
      >
        {{ overwritesExisting ? '覆盖同名方案' : '新建方案' }}
      </button>
      <span class="field-hint">
        {{ overwritesExisting
          ? `已存在同名方案「${profileName.trim()}」，保存会覆盖它。`
          : '存好后可在「配置方案」里一键应用。' }}
      </span>
    </div>
    <span v-if="formHint" class="field-hint field-error" aria-live="polite">{{ formHint }}</span>
  </div>
</template>

<style scoped>
/* 样式自足：父组件 App.vue 的 style 是 scoped，子组件继承不到——
   .field/.primary/.ghost 这些通用类在父组件作用域里，这里必须自带一份同款视觉。 */
.profile-editor {
  margin-top: 14px;
  padding: 16px;
  border: 1px dashed var(--bh-border-strong);
  border-radius: 12px;
  background: var(--bh-surface-subtle);
}

.profile-editor-head {
  margin-bottom: 12px;
}

.profile-editor-title {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 700;
  color: var(--bh-text-primary);
}

.profile-editor-note {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--bh-text-secondary);
}

.field {
  display: block;
  margin-bottom: 12px;
}

.field-label {
  display: block;
  margin-bottom: 5px;
  font-size: 12px;
  font-weight: 600;
  color: var(--bh-text-secondary);
}

.field-hint {
  display: block;
  margin-top: 5px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--bh-text-muted);
}

.field-error {
  color: var(--bh-danger);
  margin-top: 8px;
}

.field input,
.field select {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 11px;
  border: 1px solid var(--bh-border-hairline);
  border-radius: 9px;
  background: var(--bh-surface-input);
  color: var(--bh-text-primary);
  font-size: 13px;
  font-family: inherit;
}

.field input:focus,
.field select:focus {
  border-color: var(--bh-primary);
  box-shadow: 0 0 0 3px var(--bh-shadow-focus);
  outline: none;
}

.combo-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.combo-row :deep(.model-combo) {
  flex: 1;
  min-width: 0;
}

.profile-editor-submit {
  border: none;
  background: linear-gradient(135deg, var(--bh-primary-deep), var(--bh-primary-bright));
  color: var(--bh-text-on-accent);
  border-radius: 10px;
  padding: 9px 20px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 4px 14px var(--bh-shadow-accent);
  font-family: inherit;
}

.profile-editor-submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ghost {
  border: 1px solid var(--bh-border-hairline);
  border-radius: 9px;
  background: var(--bh-surface-input);
  color: var(--bh-text-secondary);
  padding: 8px 13px;
  font-size: 12.5px;
  cursor: pointer;
  white-space: nowrap;
  font-family: inherit;
}

.ghost:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.profile-advanced {
  margin: 4px 0 14px;
  padding: 10px 12px;
  border: 1px solid var(--bh-border-hairline);
  border-radius: 10px;
  background: var(--bh-surface-input);
}

.profile-advanced summary {
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  color: var(--bh-text-secondary);
}

.profile-advanced .field {
  margin-top: 12px;
  margin-bottom: 0;
}

.profile-editor-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
</style>
