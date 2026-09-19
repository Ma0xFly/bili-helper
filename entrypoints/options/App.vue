<script setup lang="ts">
// AI 助手组真实表单：对话端点、服务器开关（含回退子开关）、功能开关，
// 向量端点折叠进「高级」（默认继承对话端点，绝大多数用户不需要展开）。
// 连通性测试内联在对应端点卡片里（测试按钮贴着字段，就地出结果），不设独立体检区。
// 运行模式不暴露 local/server/auto 术语：开关关=local，开关开=server，回退勾上=auto。
// 端点读写只经 modules/settings 助手。其余分组（服务器独立页签/过滤/净化/布局/增强）仍为占位。

import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { testChatEndpoint, testEmbeddingEndpoint } from '../../modules/ai/endpoint-test'
import type { EndpointTestResult } from '../../modules/ai/endpoint-test'
import { listModels } from '../../modules/ai/llm/client'
import { probeServerEndpoint } from '../../modules/ai/server-probe'
import { AD_SIGNAL_CORPUS } from '../../modules/ai/rag/corpus'
import {
  USER_CORPUS_CATEGORIES,
  addUserCorpusEntries,
  addUserCorpusEntry,
  clearUserCorpus,
  exportUserCorpusMarkdown,
  readUserCorpus,
  removeUserCorpusEntry,
} from '../../modules/ai/rag/user-corpus'
import type { UserCorpusEntry } from '../../modules/ai/rag/user-corpus'
import {
  readAiSettings,
  resolveDetectEndpoint,
  resolveEmbeddingEndpoint,
  writeAiSettings,
} from '../../modules/settings'
import type { AiMode, AiSettings } from '../../modules/settings'
import { AiError } from '../../modules/shared/error'
import {
  clearAiFailures,
  readAiFailures,
  readDetectCosts,
  recordAiFailure,
} from '../../modules/ai/diagnostics-log'
import type { AiFailureEntry, DetectCostEntry } from '../../modules/ai/diagnostics-log'
import {
  applyProfile,
  deleteProfile,
  readAiProfiles,
  saveProfileFromCurrent,
} from '../../modules/settings/profiles'
import type { AiProfile } from '../../modules/settings/profiles'
import {
  applyBackup,
  exportBackupText,
  parseBackup,
} from '../../modules/settings/backup'
import { FEATURE_GROUPS } from '../../modules/features/config'
import type { FeatureGroupId } from '../../modules/features/config'
import FeaturesSection from './FeaturesSection.vue'
import ModelCombo from './ModelCombo.vue'

// 侧栏分组：AI 助手 + 三个功能组（过滤视频/布局优化/功能增强）。
// 「净化」按 PRD 砍掉不再出现；旧占位组（服务器等）一并移除——服务器配置在 AI 助手内。
const groups = ['AI 助手', ...FEATURE_GROUPS.map((group) => group.title)]
const active = ref<string>(groups[0] ?? 'AI 助手')
const activeGroupId = computed<FeatureGroupId | null>(
  () => FEATURE_GROUPS.find((group) => group.title === active.value)?.id ?? null,
)

interface FormModel {
  apiUrl: string
  apiKey: string
  model: string
  apiFormat: 'openai' | 'anthropic'
  embedBaseUrl: string
  embedKey: string
  embedModel: string
  detectApiUrl: string
  detectApiKey: string
  detectModel: string
  detectApiFormat: 'inherit' | 'openai' | 'anthropic'
  mode: AiMode
  serverBaseUrl: string
  serverToken: string
  adSkipEnabled: boolean
  panelEnabled: boolean
  chapterMarksEnabled: boolean
}

const form = reactive<FormModel>({
  apiUrl: '',
  apiKey: '',
  model: '',
  apiFormat: 'openai',
  embedBaseUrl: '',
  embedKey: '',
  embedModel: '',
  detectApiUrl: '',
  detectApiKey: '',
  detectModel: '',
  detectApiFormat: 'inherit',
  mode: 'local',
  serverBaseUrl: '',
  serverToken: '',
  adSkipEnabled: false,
  panelEnabled: true,
  chapterMarksEnabled: true,
})

const loadError = ref('')

/** 存储值 → 表单（挂载回填与应用方案共用同一份搬运，避免两处漂移）。 */
function applyStoredToForm(settings: AiSettings): void {
  form.apiUrl = settings.apiUrl
  form.apiKey = settings.apiKey
  form.model = settings.model
  form.apiFormat = settings.apiFormat
  form.embedBaseUrl = settings.embedBaseUrl
  form.embedKey = settings.embedKey
  form.embedModel = settings.embedModel
  form.detectApiUrl = settings.detectApiUrl
  form.detectApiKey = settings.detectApiKey
  form.detectModel = settings.detectModel
  form.detectApiFormat = settings.detectApiFormat
  form.mode = settings.mode
  fallbackWanted.value = settings.mode === 'auto'
  form.serverBaseUrl = settings.serverBaseUrl
  form.serverToken = settings.serverToken
  form.adSkipEnabled = settings.adSkipEnabled
  form.panelEnabled = settings.panelEnabled
  form.chapterMarksEnabled = settings.chapterMarksEnabled
}

onMounted(async () => {
  try {
    applyStoredToForm(await readAiSettings())
  } catch {
    // 读取失败要给可见提示，而不是静默留下空表单。
    loadError.value = '设置加载失败，请刷新重试'
  }
  void loadProfiles()
})

// 运行模式的开关化表达：底层仍是 local/server/auto 三态，界面只问两个是非题。
// fallbackWanted 记住「要回退」的意愿，服务器开关来回切时不丢这个选择。
const fallbackWanted = ref(false)

const useServer = computed({
  get: () => form.mode !== 'local',
  set: (on: boolean) => {
    form.mode = on ? (fallbackWanted.value ? 'auto' : 'server') : 'local'
  },
})

const useFallback = computed({
  get: () => fallbackWanted.value,
  set: (on: boolean) => {
    fallbackWanted.value = on
    if (form.mode !== 'local') form.mode = on ? 'auto' : 'server'
  },
})

/** 本机直连端点在纯 server 模式下用不到，给一句说明而不是整块藏起来（切回即用）。 */
const localEndpointsInUse = computed(() => form.mode !== 'server')

// 向量端点默认折叠：留空即继承对话端点，展开才有输入框（高级用户才需要拆分）。
const advancedOpen = ref(false)

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

// 去广告专用端点（省 token）：默认折叠，留空继承对话端点。定界是约束很强的结构化任务，
// 便宜模型（flash 档）够用；这里只影响去广告，总结/提问仍走对话端点。
const detectOpen = ref(false)
const resolvedDetect = computed(() => resolveDetectEndpoint(form))
const detectBaseInherits = computed(() => form.detectApiUrl.trim() === '')
const detectKeyInherits = computed(() => form.detectApiKey.trim() === '')
const detectModelInherits = computed(() => form.detectModel.trim() === '')
const detectBaseHint = computed(() =>
  resolvedDetect.value.baseUrl && detectBaseInherits.value
    ? `继承：${resolvedDetect.value.baseUrl}`
    : detectBaseInherits.value
      ? '继承：尚未配置对话端点'
      : '',
)
const detectModelHint = computed(() =>
  resolvedDetect.value.model && detectModelInherits.value
    ? `继承：${resolvedDetect.value.model}`
    : detectModelInherits.value
      ? '继承：尚未配置对话端点'
      : '',
)
const detectKeyHint = computed(() =>
  detectKeyInherits.value && resolvedDetect.value.apiKey ? '继承：对话端点的 API Key' : '',
)

const FETCH_MODELS_HINT =
  '拉不到模型列表：该端点可能不提供列表接口（如火山方舟 Coding 这类专用网关），直接手动输入模型名即可'

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
    chatModelOptions.value = await listModels({
      baseUrl: form.apiUrl,
      apiKey: form.apiKey,
      format: form.apiFormat,
    })
  } catch (error) {
    chatModelsHint.value = FETCH_MODELS_HINT
    recordFetchFailure('模型列表', error)
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
  } catch (error) {
    embedModelsHint.value = FETCH_MODELS_HINT
    recordFetchFailure('模型列表', error)
  } finally {
    embedModelsLoading.value = false
  }
}

/** 拉取类失败落诊断日志（含原始响应摘录），设置页「诊断记录」直接可看。 */
function recordFetchFailure(feature: '模型列表', error: unknown): void {
  if (!(error instanceof AiError)) return
  void recordAiFailure({
    time: Date.now(),
    feature,
    kind: error.kind,
    message: error.message,
    ...(error.rawResponse === undefined ? {} : { rawExcerpt: error.rawResponse }),
    ...(form.apiUrl.trim() === '' ? {} : { endpoint: form.apiUrl }),
  }).then(loadFailures)
}

// ---------- 诊断控制台（终端形式） ----------
// 总结/提问/去广告/连通测试失败自动落档；这里以终端样式展示。
// 展开（或点击终端本体）即刷新，展开期间每 5 秒自动刷新——失败发生时打开就能看到。
const failures = ref<AiFailureEntry[]>([])
const costs = ref<DetectCostEntry[]>([])
const consoleOpen = ref(false)
let consoleTimer: number | undefined

async function loadFailures(): Promise<void> {
  try {
    failures.value = await readAiFailures()
  } catch {
    failures.value = []
  }
  try {
    costs.value = await readDetectCosts()
  } catch {
    costs.value = []
  }
}

function toggleConsole(): void {
  consoleOpen.value = !consoleOpen.value
  if (consoleTimer !== undefined) {
    window.clearInterval(consoleTimer)
    consoleTimer = undefined
  }
  if (consoleOpen.value) {
    void loadFailures()
    consoleTimer = window.setInterval(() => void loadFailures(), 5000)
  }
}

onUnmounted(() => {
  if (consoleTimer !== undefined) window.clearInterval(consoleTimer)
})

async function onClearFailures(): Promise<void> {
  await clearAiFailures()
  failures.value = []
}

function failureTimeText(entry: AiFailureEntry): string {
  const date = new Date(entry.time)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 开销行的路径译名：终端里看代码词比看中文标签更快对上日志。 */
function costPathText(path: string): string {
  const known: Record<string, string> = {
    cache: '缓存命中(0 token)',
    consensus: '双源强一致(免LLM)',
    llm: 'LLM定界',
    fulltext: '全文兜底',
    retrieval: '极速匹配',
    none: '无命中',
  }
  return known[path] ?? path
}

function costTimeText(entry: DetectCostEntry): string {
  return failureTimeText({ time: entry.time } as AiFailureEntry)
}

/** 开销合计：最近 N 次检测的 token 总量与零成本占比（缓存/双源/无命中）。 */
const costSummary = computed(() => {
  const total = costs.value.length
  if (total === 0) return null
  const input = costs.value.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0)
  const output = costs.value.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0)
  const free = costs.value.filter((item) => item.llmCalls === 0).length
  return `最近 ${total} 次：输入 ${input.toLocaleString()} / 输出 ${output.toLocaleString()} token，${free} 次零成本（${Math.round((free / total) * 100)}%）`
})

type Feedback = { kind: 'ok' | 'warn' | 'fail'; text: string }

// ---------- 服务商预设（开源客户端惯例）：一键填地址，模型输入给推荐占位 ----------
// 模型名只作 placeholder 提示（迭代快，不自动写入表单）；拉取模型按钮随时拿真实列表。
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

const chatPresetName = computed(
  () => CHAT_PRESETS.find((preset) => preset.url === form.apiUrl)?.name ?? 'custom',
)
const chatModelPlaceholder = computed(
  () => CHAT_PRESETS.find((preset) => preset.url === form.apiUrl)?.model ?? 'gpt-4o-mini',
)

function applyChatPreset(event: Event): void {
  const name = (event.target as HTMLSelectElement).value
  const preset = CHAT_PRESETS.find((item) => item.name === name)
  if (preset) form.apiUrl = preset.url
}

/** 自增运行号：内联测试共用一个计数器，迟到的旧结果不得覆盖新状态。 */
let diagnosticsRunId = 0

// ---------- 内联连通性测试（贴着对应端点配置，测的就是眼前这套表单值） ----------
// 每个目标一份独立状态：按钮就在字段后面，结果就地显示；测试用表单当前值而非已存值
// （改了地址没保存也测新地址）。运行号守卫：迟到结果不得覆盖新一轮的状态。
interface InlineTestState {
  running: boolean
  result: Feedback | null
}
function newTestState(): InlineTestState {
  return { running: false, result: null }
}
const chatTest = reactive(newTestState())
const embedTest = reactive(newTestState())
const detectTest = reactive(newTestState())
const serverTest = reactive(newTestState())

function asFeedback(result: EndpointTestResult): Feedback {
  if (result.ok) return { kind: 'ok', text: `连接成功 · ${result.model} 响应 ${result.ms}ms` }
  return { kind: 'fail', text: `连接失败 · ${result.reason}` }
}

async function runInlineTest(
  state: InlineTestState,
  probe: () => Promise<Feedback>,
): Promise<void> {
  const runId = (diagnosticsRunId += 1)
  state.running = true
  state.result = null
  try {
    const feedback = await probe()
    if (runId === diagnosticsRunId) state.result = feedback
  } finally {
    if (runId === diagnosticsRunId) state.running = false
  }
}

async function testChatInline(): Promise<void> {
  if (form.apiUrl.trim() === '' || form.model.trim() === '') {
    chatTest.result = { kind: 'fail', text: '请先填写 Base URL 和模型，再测试连接' }
    return
  }
  await runInlineTest(chatTest, async () => {
    const result = await testChatEndpoint({
      baseUrl: form.apiUrl,
      model: form.model,
      apiKey: form.apiKey,
      format: form.apiFormat,
    })
    recordTestFailure(result, form.apiUrl, form.model)
    return asFeedback(result)
  })
}

/** 连通测试失败落诊断日志（终端控制台直接可看）；成功不记，避免噪音。 */
function recordTestFailure(
  result: EndpointTestResult,
  endpoint: string,
  model: string,
): void {
  if (result.ok || result.failure === undefined) return
  void recordAiFailure({
    time: Date.now(),
    feature: '连通测试',
    kind: result.failure.kind,
    message: result.failure.message,
    ...(result.failure.rawResponse === undefined ? {} : { rawExcerpt: result.failure.rawResponse }),
    ...(endpoint.trim() === '' ? {} : { endpoint }),
    ...(model.trim() === '' ? {} : { model }),
  }).then(loadFailures)
}

async function testEmbedInline(): Promise<void> {
  const endpoint = resolveEmbeddingEndpoint(form)
  if (endpoint.baseUrl.trim() === '' || endpoint.model.trim() === '') {
    embedTest.result = { kind: 'fail', text: '请先填写（或继承对话端点的）Base URL 与嵌入模型' }
    return
  }
  await runInlineTest(embedTest, async () => {
    const result = await testEmbeddingEndpoint({
      baseUrl: endpoint.baseUrl,
      model: endpoint.model,
      apiKey: endpoint.apiKey,
    })
    recordTestFailure(result, endpoint.baseUrl, endpoint.model)
    return asFeedback(result)
  })
}

async function testDetectInline(): Promise<void> {
  const endpoint = resolveDetectEndpoint(form)
  if (endpoint.baseUrl.trim() === '' || endpoint.model.trim() === '') {
    detectTest.result = { kind: 'fail', text: '请先填写（或继承对话端点的）Base URL 与模型' }
    return
  }
  await runInlineTest(detectTest, async () => {
    const result = await testChatEndpoint(endpoint)
    recordTestFailure(result, endpoint.baseUrl, endpoint.model)
    return asFeedback(result)
  })
}

async function testServerInline(): Promise<void> {
  if (form.serverBaseUrl.trim() === '') {
    serverTest.result = { kind: 'fail', text: '请先填写 Server Base URL' }
    return
  }
  await runInlineTest(serverTest, async () => {
    const probe = await probeServerEndpoint({ baseUrl: form.serverBaseUrl, token: form.serverToken })
    if (probe.ok && probe.healthSupported) {
      return { kind: 'ok', text: `连接成功 · 响应 ${probe.ms}ms` }
    }
    if (probe.ok) return { kind: 'warn', text: '服务器可达，但未提供体检接口（不影响转发）' }
    return { kind: 'fail', text: `连接失败 · ${probe.reason}` }
  })
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

// ---------- 配置方案（多套连接快照，一键换家）----------
const profiles = ref<AiProfile[]>([])
const selectedProfileId = ref('')
const profileName = ref('')
const profileHint = ref<Feedback | null>(null)

async function loadProfiles(): Promise<void> {
  profiles.value = await readAiProfiles()
}

async function onSaveProfile(): Promise<void> {
  const name = profileName.value.trim()
  try {
    profiles.value = await saveProfileFromCurrent(name)
    const saved = profiles.value.find((profile) => profile.name === name)
    if (saved) selectedProfileId.value = saved.id
    profileHint.value = { kind: 'ok', text: `方案「${name}」已保存（当前连接设置）` }
    profileName.value = ''
  } catch (error) {
    profileHint.value = {
      kind: 'fail',
      text: error instanceof Error ? error.message : '保存失败，请重试',
    }
  }
}

async function onApplyProfile(): Promise<void> {
  if (selectedProfileId.value === '') return
  try {
    // 应用即写入存储（主设置已更新），表单同步搬运，无需再点保存。
    applyStoredToForm(await applyProfile(selectedProfileId.value))
    profileHint.value = { kind: 'ok', text: '方案已应用并保存' }
  } catch (error) {
    profileHint.value = {
      kind: 'fail',
      text: error instanceof Error ? error.message : '应用失败，请重试',
    }
  }
}

async function onDeleteProfile(): Promise<void> {
  if (selectedProfileId.value === '') return
  try {
    profiles.value = await deleteProfile(selectedProfileId.value)
    selectedProfileId.value = profiles.value[0]?.id ?? ''
    profileHint.value = { kind: 'ok', text: '方案已删除' }
  } catch {
    profileHint.value = { kind: 'fail', text: '删除失败，请重试' }
  }
}

// ---------- 广告词库（用户层补录）----------
// 低频功能，收在设置页而不是播放器：漏检时用户自己最清楚关键词是什么，手动补一条即可。
// 补录即时生效——词条进入生效语料 → 语料哈希变 → 向量缓存自动重算，无需手动清缓存。
const builtinCorpusCount = AD_SIGNAL_CORPUS.length
const userEntries = ref<UserCorpusEntry[]>([])
const corpusText = ref('')
const corpusCategory = ref<string>(USER_CORPUS_CATEGORIES[0] ?? 'scripts')
const corpusNote = ref('')
const corpusAdding = ref(false)
const corpusHint = ref<Feedback | null>(null)
const corpusPatch = ref('')
const corpusCategories = USER_CORPUS_CATEGORIES

async function loadUserCorpus(): Promise<void> {
  userEntries.value = await readUserCorpus()
}

/**
 * 补录词条是否真的会参与识别：识别跑在端上（local）才生效。
 * server/auto 模式下检索发生在服务端，用的是服务端自己的词库——这时候不能承诺「即生效」，
 * 得说清楚补录只在浏览器直连时管用，并指向「导出 patch 交服务端合入」这条路。
 */
const corpusTakesEffect = computed(() => form.mode === 'local')

async function addCorpusEntry(): Promise<void> {
  // Enter 连按不受按钮 disabled 约束：这里再挡一道，避免同一 tick 触发两次写入。
  if (corpusAdding.value) return
  const text = corpusText.value.trim()
  corpusAdding.value = true
  corpusHint.value = null
  try {
    const result = await addUserCorpusEntry({
      text,
      category: corpusCategory.value,
      note: corpusNote.value,
    })
    if (!result.ok) {
      corpusHint.value = { kind: 'fail', text: result.reason }
      return
    }
    // 回读真实存储态而不是用返回值渲染：并发写入下返回值可能只是当次快照。
    await loadUserCorpus()
    corpusText.value = ''
    corpusNote.value = ''
    // 词条变了，已生成的导出 patch 立即过期（避免用户复制走旧内容）。
    corpusPatch.value = ''
    corpusHint.value = {
      kind: corpusTakesEffect.value ? 'ok' : 'warn',
      text: corpusTakesEffect.value
        ? `已补录「${text}」，下次识别即生效`
        : `已补录「${text}」，但当前识别走服务器：只在浏览器直连时生效，要交给服务器请用「导出入库 patch」`,
    }
  } finally {
    corpusAdding.value = false
  }
}

// ---------- 批量粘贴补录 ----------
const corpusBatchOpen = ref(false)
const corpusBatchText = ref('')
const corpusBatchBusy = ref(false)

async function addCorpusBatch(): Promise<void> {
  if (corpusBatchBusy.value) return
  const texts = corpusBatchText.value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (texts.length === 0) {
    corpusHint.value = { kind: 'fail', text: '先在文本框里贴词条（一行一个）' }
    return
  }
  corpusBatchBusy.value = true
  corpusHint.value = null
  try {
    const result = await addUserCorpusEntries({
      texts,
      category: corpusCategory.value,
      note: corpusNote.value,
    })
    if (!result.ok) {
      corpusHint.value = { kind: 'fail', text: result.reason ?? '批量补录失败' }
      return
    }
    await loadUserCorpus()
    const skippedNote =
      result.skipped.length > 0
        ? `，跳过 ${result.skipped.length} 条（${result.skipped.slice(0, 2).map((item) => `${item.text}：${item.reason}`).join('；')}${result.skipped.length > 2 ? ' 等' : ''}）`
        : ''
    corpusHint.value = {
      kind: corpusTakesEffect.value ? 'ok' : 'warn',
      text: `已批量补录 ${result.added} 条${skippedNote}`,
    }
    corpusBatchText.value = ''
    corpusPatch.value = ''
  } finally {
    corpusBatchBusy.value = false
  }
}

async function removeCorpusEntry(text: string): Promise<void> {
  corpusHint.value = null
  try {
    userEntries.value = await removeUserCorpusEntry(text)
    corpusPatch.value = ''
    corpusHint.value = { kind: 'ok', text: `已删除「${text}」` }
  } catch {
    // 写失败必须露出来：列表没变却说「已删除」会让用户以为生效了。
    corpusHint.value = { kind: 'fail', text: '删除失败，请重试' }
  }
}

async function clearCorpusEntries(): Promise<void> {
  corpusHint.value = null
  try {
    userEntries.value = await clearUserCorpus()
    corpusPatch.value = ''
    corpusHint.value = { kind: 'ok', text: '已清空你补录的词条' }
  } catch {
    corpusHint.value = { kind: 'fail', text: '清空失败，请重试' }
  }
}

async function exportCorpus(): Promise<void> {
  corpusHint.value = null
  const patch = exportUserCorpusMarkdown(userEntries.value)
  if (patch === '') {
    corpusHint.value = { kind: 'fail', text: '还没有补录的词条可导出' }
    return
  }
  corpusPatch.value = patch
  try {
    await navigator.clipboard.writeText(patch)
    corpusHint.value = { kind: 'ok', text: '已复制到剪贴板（也可在下方文本框手动全选复制）' }
  } catch {
    // 剪贴板不可用不是错误：文本框已经摆在那里，手动复制同样能完成入库。
    corpusHint.value = { kind: 'warn', text: '已生成 patch，请在下方文本框手动全选复制' }
  }
}

// ---------- 配置备份（导出 / 导入）----------
// 一键带走：AI 端点与方案、功能开关与八维规则、补录词库、误判反馈。
// 密钥默认打码（空串 = 导入时保留本机现有 Key），勾选后才随文件明文导出。
const backupIncludeSecrets = ref(false)
const backupText = ref('')
const backupBusy = ref(false)
const backupHint = ref<Feedback | null>(null)

async function onExportBackup(): Promise<void> {
  backupBusy.value = true
  backupHint.value = null
  try {
    const text = await exportBackupText({ withSecrets: backupIncludeSecrets.value })
    backupText.value = text
    try {
      await navigator.clipboard.writeText(text)
      backupHint.value = {
        kind: backupIncludeSecrets.value ? 'warn' : 'ok',
        text: backupIncludeSecrets.value
          ? '已导出并复制：文件含明文密钥，请妥善保管'
          : '已导出并复制到剪贴板（密钥已打码，可放心共享）',
      }
    } catch {
      backupHint.value = { kind: 'warn', text: '已生成备份，请在下方文本框手动复制保存' }
    }
  } catch (error) {
    backupHint.value = {
      kind: 'fail',
      text: `导出失败：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    backupBusy.value = false
  }
}

async function onImportBackup(): Promise<void> {
  const text = backupText.value.trim()
  if (text === '') {
    backupHint.value = { kind: 'fail', text: '先把备份内容粘贴到文本框（或选择一个备份文件）' }
    return
  }
  backupBusy.value = true
  backupHint.value = null
  try {
    const summary = await applyBackup(parseBackup(text))
    applyStoredToForm(await readAiSettings())
    await Promise.all([loadUserCorpus(), loadProfiles()])
    const skippedNote =
      summary.skipped.length > 0 ? `；跳过 ${summary.skipped.length} 项（${summary.skipped.join('；')}）` : ''
    backupHint.value =
      summary.applied.length > 0
        ? { kind: 'ok', text: `已导入：${summary.applied.join('、')}${skippedNote}` }
        : { kind: 'warn', text: `备份里没有可导入的内容${skippedNote}` }
  } catch (error) {
    backupHint.value = {
      kind: 'fail',
      text: `导入失败：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    backupBusy.value = false
  }
}

/** 选择备份文件 → 读进文本框（同一文件可重复选择：读完即清 input 值）。 */
function onBackupFile(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    backupText.value = String(reader.result ?? '')
    backupHint.value = { kind: 'ok', text: `已读取「${file.name}」，点「导入」应用` }
  }
  reader.onerror = () => {
    backupHint.value = { kind: 'fail', text: '文件读取失败' }
  }
  reader.readAsText(file)
  input.value = ''
}

onMounted(loadUserCorpus)
onMounted(loadFailures)
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
          <p class="content-sub">直连 OpenAI 兼容端点，或转发到你自己的服务器</p>
        </header>

        <p v-if="loadError" class="load-error" role="alert">{{ loadError }}</p>

        <section class="card" aria-labelledby="profiles-title">
          <h2 id="profiles-title" class="card-title">配置方案</h2>
          <p class="card-note">
            把整套连接配置（端点 / Key / 模型 / 协议 / 服务器）存成命名方案，一键换家；功能开关不属于方案。
          </p>
          <div class="profile-row">
            <select v-model="selectedProfileId" aria-label="选择方案" :disabled="profiles.length === 0">
              <option value="" disabled>暂无方案，先在下面保存一个</option>
              <option v-for="profile in profiles" :key="profile.id" :value="profile.id">
                {{ profile.name }}
              </option>
            </select>
            <button type="button" class="ghost" :disabled="selectedProfileId === ''" @click="onApplyProfile">
              应用
            </button>
            <button type="button" class="ghost" :disabled="selectedProfileId === ''" @click="onDeleteProfile">
              删除
            </button>
          </div>
          <div class="profile-row">
            <input
              v-model="profileName"
              type="text"
              placeholder="方案名，如：硅基流动·本地直连"
              aria-label="方案名称"
              class="grow"
            />
            <button type="button" class="ghost" :disabled="profileName.trim() === ''" @click="onSaveProfile">
              存为方案
            </button>
          </div>
          <div v-if="profileHint" class="feedback" :class="profileHint.kind" aria-live="polite">
            <span class="badge" aria-hidden="true">
              {{ profileHint.kind === 'ok' ? '✓' : profileHint.kind === 'warn' ? '!' : '✕' }}
            </span>
            <span>{{ profileHint.text }}</span>
          </div>
        </section>

        <section class="card" aria-labelledby="chat-endpoint-title">
          <h2 id="chat-endpoint-title" class="card-title">对话端点（总结 / 提问）</h2>
          <p class="card-note">
            总结 / 提问必须有对话端点；只配向量端点时去广告自动走「极速匹配」（纯检索定界，精度略低、零对话开销）。
          </p>
          <p v-if="!localEndpointsInUse" class="card-note">
            当前全部请求走服务器转发，这里的端点不会被使用；开启「失败时回退」或关掉服务器开关即恢复直连。
          </p>
          <div class="field">
            <span class="field-label">服务商预设</span>
            <select :value="chatPresetName" aria-label="服务商预设" @change="applyChatPreset">
              <option value="custom">自定义（手动填写）</option>
              <option v-for="preset in CHAT_PRESETS" :key="preset.name" :value="preset.name">
                {{ preset.name }}
              </option>
            </select>
            <span class="field-hint">
              选中即填入对应地址，模型可点「拉取模型」取真实列表。请求经扩展后台发起，
              不受页面跨域（CORS）限制；但会走系统代理——本地代理工具（如 Clash）
              需放行端点域名，被拦时可在代理里配直连规则或改走「服务器转发」。
            </span>
          </div>
          <div class="field">
            <span class="field-label">API 协议</span>
            <select v-model="form.apiFormat" aria-label="API 协议">
              <option value="openai">OpenAI 兼容（chat/completions）</option>
              <option value="anthropic">Anthropic Messages（messages）</option>
            </select>
            <span class="field-hint">
              Claude 官方 API 与部分中转/网关（如火山方舟 Coding 端点
              https://ark.cn-beijing.volces.com/api/coding）走 Anthropic 协议。地址带不带 /v1
              都可以，两种拼法会自动尝试。只影响浏览器直连；服务器转发由服务端自身配置决定。
            </span>
          </div>
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
              <ModelCombo
                v-model="form.model"
                :options="chatModelOptions"
                :loading="chatModelsLoading"
                :placeholder="chatModelPlaceholder"
                label="对话模型"
              />
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
          <div class="field">
            <button
              type="button"
              class="ghost"
              :disabled="chatTest.running"
              aria-label="测试对话端点"
              @click="testChatInline"
            >
              {{ chatTest.running ? '测试中…' : '测试连接' }}
            </button>
            <div
              v-if="chatTest.result"
              class="feedback"
              :class="chatTest.result.kind"
              aria-live="polite"
            >
              <span class="badge" aria-hidden="true">
                {{ chatTest.result.kind === 'ok' ? '✓' : chatTest.result.kind === 'warn' ? '!' : '✕' }}
              </span>
              <span>{{ chatTest.result.text }}</span>
            </div>
          </div>
        </section>

        <section class="card" aria-labelledby="server-title">
          <h2 id="server-title" class="card-title">服务器转发</h2>
          <label class="switch-row">
            <span class="switch-info">
              <span class="switch-name">我有自己的服务器</span>
              <span class="field-hint">
                开启后，AI 请求统一发到你的服务器，由服务端做检索与模型调用；关闭则由浏览器直连上方端点。
              </span>
            </span>
            <span class="switch">
              <input v-model="useServer" type="checkbox" aria-label="使用自己的服务器" />
              <span class="switch-track" aria-hidden="true" />
              <span class="switch-knob" aria-hidden="true" />
            </span>
          </label>

          <template v-if="useServer">
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
              <input
                v-model="form.serverToken"
                type="password"
                placeholder="可留空"
                autocomplete="off"
              />
              <span class="field-hint">非空时所有转发请求统一携带 Authorization: Bearer ⟨token⟩。</span>
            </label>
            <label class="switch-row">
              <span class="switch-info">
                <span class="switch-name">服务器失败时回退浏览器直连</span>
                <span class="field-hint">
                  服务器不可用时自动改用上方端点继续工作（需要上方端点也配好）。
                  回退只发生在请求还没出结果时——已经开始输出的回答不会中途换源。
                </span>
              </span>
              <span class="switch">
                <input v-model="useFallback" type="checkbox" aria-label="服务器失败时回退直连" />
                <span class="switch-track" aria-hidden="true" />
                <span class="switch-knob" aria-hidden="true" />
              </span>
            </label>
            <div class="field">
              <button
                type="button"
                class="ghost"
                :disabled="serverTest.running"
                aria-label="测试服务器连接"
                @click="testServerInline"
              >
                {{ serverTest.running ? '测试中…' : '测试连接' }}
              </button>
              <div
                v-if="serverTest.result"
                class="feedback"
                :class="serverTest.result.kind"
                aria-live="polite"
              >
                <span class="badge" aria-hidden="true">
                  {{ serverTest.result.kind === 'ok' ? '✓' : serverTest.result.kind === 'warn' ? '!' : '✕' }}
                </span>
                <span>{{ serverTest.result.text }}</span>
              </div>
            </div>
          </template>
        </section>

        <section class="card" aria-labelledby="diag-log-title">
          <h2 id="diag-log-title" class="card-title">诊断控制台</h2>
          <p class="card-note">
            AI 失败的终端视图（最近 {{ failures.length }}/20 条：总结 / 提问 / 去广告 / 连通测试 / 模型列表），
            含模型原始响应摘录；下方「去广告开销」逐次记录检测走了哪条路、花了多少 token。
            点开即刷新、展开期间每 5 秒自动刷新；点击终端本体也可手动刷新。不含任何密钥。
          </p>
          <div class="diag-log-actions">
            <button
              type="button"
              class="ghost"
              :aria-expanded="consoleOpen ? 'true' : 'false'"
              @click="toggleConsole"
            >
              {{ consoleOpen ? '收起控制台' : '打开控制台' }}
            </button>
            <button
              type="button"
              class="ghost danger"
              :disabled="failures.length === 0"
              @click="onClearFailures"
            >
              清空
            </button>
          </div>
          <div v-show="consoleOpen" class="bh-terminal" role="log" @click="loadFailures">
            <div class="terminal-head" aria-hidden="true">
              <span class="terminal-dot"></span><span class="terminal-dot"></span><span class="terminal-dot"></span>
              <span class="terminal-title">ai-diagnostics</span>
              <span class="terminal-count">{{ failures.length }}/20</span>
            </div>
            <div class="terminal-body">
              <template v-if="failures.length > 0">
                <div v-for="(entry, index) in failures" :key="index" class="diag-log-item">
                  <div class="diag-log-line">
                    <span class="terminal-prompt">[{{ failureTimeText(entry) }}]</span>
                    <span class="diag-log-feature">{{ entry.feature }}</span>
                    <span class="diag-log-kind" :class="entry.kind">{{ entry.kind }}</span>
                    <span class="diag-log-msg">{{ entry.message }}</span>
                  </div>
                  <pre v-if="entry.rawExcerpt" class="diag-log-raw">  ↳ {{ entry.rawExcerpt }}</pre>
                  <div v-if="entry.endpoint || entry.model" class="diag-log-meta">
                    ↳ {{ entry.endpoint }}{{ entry.endpoint && entry.model ? ' · ' : '' }}{{ entry.model }}
                  </div>
                </div>
              </template>
              <div v-else class="terminal-empty">$ 暂无失败记录<span class="terminal-cursor">▊</span></div>
              <template v-if="costs.length > 0">
                <div class="terminal-divider">$ 去广告开销 {{ costSummary }}</div>
                <div v-for="(entry, index) in costs" :key="`cost-${index}`" class="diag-log-item">
                  <div class="diag-log-line">
                    <span class="terminal-prompt">[{{ costTimeText(entry) }}]</span>
                    <span class="diag-log-feature">{{ costPathText(entry.path) }}</span>
                    <span class="diag-log-msg">
                      {{ entry.bvid || '未知视频' }} · 广告段 {{ entry.ads }}（可跳 {{ entry.skippable }}） ·
                      {{ entry.elapsedMs >= 1000 ? `${(entry.elapsedMs / 1000).toFixed(1)}s` : `${entry.elapsedMs}ms` }} ·
                      {{ entry.llmCalls === 0 ? '0 token' : `入${(entry.inputTokens ?? 0).toLocaleString()}/出${(entry.outputTokens ?? 0).toLocaleString()}` }}
                    </span>
                  </div>
                </div>
              </template>
            </div>
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
          <label class="switch-row">
            <span class="switch-info">
              <span class="switch-name">进度条章节标记</span>
              <span class="field-hint">
                在进度条上显示可点击的章节刻度：B 站官方看点免费提供；生成过总结的视频再叠加
                AI 分段时间线（按视频缓存，刷新不丢）。点击刻度直达章节，零 token 开销。
              </span>
            </span>
            <span class="switch">
              <input
                v-model="form.chapterMarksEnabled"
                type="checkbox"
                aria-label="进度条章节标记总开关"
              />
              <span class="switch-track" aria-hidden="true" />
              <span class="switch-knob" aria-hidden="true" />
            </span>
          </label>
        </section>

        <section class="card" aria-labelledby="corpus-title">
          <h2 id="corpus-title" class="card-title">广告词库</h2>
          <p class="card-note">
            内置 {{ builtinCorpusCount }} 条（随版本更新，不可改）+ 你补录的
            {{ userEntries.length }} 条。
            <template v-if="corpusTakesEffect">
              遇到没识别出来的广告，把它的关键词补在这里：保存即生效，下次识别自动重算语料向量。
            </template>
            <template v-else>
              当前识别在服务器上做，补录的词条只在浏览器直连时生效（关掉服务器开关，或服务器失败回退时）；
              要让服务器也认识它，请用下面的「导出入库 patch」交给服务端词库合入。
            </template>
          </p>

          <div class="corpus-add">
            <input
              v-model.trim="corpusText"
              class="grow"
              placeholder="漏掉的广告关键词，如「某某品牌」"
              aria-label="补录词条"
              @keydown.enter.prevent="addCorpusEntry"
            />
            <select v-model="corpusCategory" aria-label="词条品类">
              <option v-for="category in corpusCategories" :key="category" :value="category">
                {{ category }}
              </option>
            </select>
            <button type="button" class="ghost" :disabled="corpusAdding" @click="addCorpusEntry">
              {{ corpusAdding ? '添加中…' : '补录' }}
            </button>
          </div>
          <input
            v-model.trim="corpusNote"
            class="corpus-note-input"
            placeholder="来源备注（可选），如 BV1xx 03:20 漏检"
            aria-label="词条来源备注"
          />

          <div class="corpus-actions">
            <button
              type="button"
              class="ghost"
              :aria-expanded="corpusBatchOpen ? 'true' : 'false'"
              @click="corpusBatchOpen = !corpusBatchOpen"
            >
              {{ corpusBatchOpen ? '收起批量粘贴' : '批量粘贴' }}
            </button>
          </div>
          <div v-show="corpusBatchOpen" class="corpus-batch">
            <textarea
              v-model="corpusBatchText"
              class="corpus-batch-input"
              rows="4"
              placeholder="一行一个词条，如：&#10;某某品牌&#10;限时国补&#10;以换代修"
              aria-label="批量补录词条"
            />
            <button
              type="button"
              class="ghost"
              :disabled="corpusBatchBusy"
              @click="addCorpusBatch"
            >
              {{ corpusBatchBusy ? '入库中…' : '全部入库（用上方品类与备注）' }}
            </button>
          </div>

          <ul v-if="userEntries.length > 0" class="corpus-list">
            <li v-for="entry in userEntries" :key="entry.text" class="corpus-item">
              <span class="corpus-word">{{ entry.text }}</span>
              <span class="corpus-tag">{{ entry.category }}</span>
              <span
                class="corpus-hits"
                :class="{ zero: entry.hitCount === 0 }"
                :title="entry.lastHitAt ? `最近命中：${entry.lastHitAt}` : '尚未在检测中命中过'"
              >
                命中 {{ entry.hitCount }}
              </span>
              <span v-if="entry.note !== ''" class="corpus-note">{{ entry.note }}</span>
              <button
                type="button"
                class="corpus-del"
                :aria-label="`删除 ${entry.text}`"
                @click="removeCorpusEntry(entry.text)"
              >
                删除
              </button>
            </li>
          </ul>
          <p v-else class="field-hint">你还没有补录词条。</p>

          <div class="corpus-actions">
            <button type="button" class="ghost" @click="exportCorpus">导出入库 patch</button>
            <button
              v-if="userEntries.length > 0"
              type="button"
              class="ghost danger"
              @click="clearCorpusEntries"
            >
              清空补录
            </button>
          </div>
          <textarea
            v-if="corpusPatch !== ''"
            v-model="corpusPatch"
            class="corpus-patch"
            rows="8"
            readonly
            aria-label="导出的词库 patch"
          />

          <div v-if="corpusHint" class="feedback" :class="corpusHint.kind" aria-live="polite">
            <span class="badge" aria-hidden="true">
              {{ corpusHint.kind === 'ok' ? '✓' : corpusHint.kind === 'warn' ? '!' : '✕' }}
            </span>
            <span>{{ corpusHint.text }}</span>
          </div>
        </section>

        <section class="card" aria-labelledby="backup-title">
          <h2 id="backup-title" class="card-title">配置备份（导出 / 导入）</h2>
          <p class="card-note">
            一键带走：AI 端点与配置方案、功能开关与筛选规则、补录的广告词库、广告误判反馈。
            换浏览器、重装、多设备同步都用得上。默认<b>不含密钥</b>（导入时保留本机已有的
            Key），可放心共享；要连密钥一起搬再勾选下方选项。
          </p>
          <label class="switch-row">
            <span class="switch-info">
              <span class="switch-name">导出时包含密钥</span>
              <span class="field-hint">
                勾选后 API Key / Server Token 会以<b>明文</b>写入备份文件，请只在自己的设备间传递。
              </span>
            </span>
            <span class="switch">
              <input
                v-model="backupIncludeSecrets"
                type="checkbox"
                aria-label="导出时包含密钥"
              />
              <span class="switch-track" aria-hidden="true" />
              <span class="switch-knob" aria-hidden="true" />
            </span>
          </label>
          <div class="corpus-actions">
            <button type="button" class="ghost" :disabled="backupBusy" @click="onExportBackup">
              {{ backupBusy ? '处理中…' : '导出备份' }}
            </button>
            <button type="button" class="ghost" :disabled="backupBusy" @click="onImportBackup">
              导入备份
            </button>
            <label class="ghost backup-file">
              选择备份文件
              <input
                type="file"
                accept="application/json,.json"
                aria-label="选择备份文件"
                @change="onBackupFile"
              />
            </label>
          </div>
          <textarea
            v-model="backupText"
            class="corpus-patch"
            rows="6"
            placeholder="导出后在此显示备份内容（可直接复制保存）；导入时把备份粘贴到这里再点「导入备份」"
            aria-label="备份内容"
          />
          <div v-if="backupHint" class="feedback" :class="backupHint.kind" aria-live="polite">
            <span class="badge" aria-hidden="true">
              {{ backupHint.kind === 'ok' ? '✓' : backupHint.kind === 'warn' ? '!' : '✕' }}
            </span>
            <span>{{ backupHint.text }}</span>
          </div>
        </section>

        <section class="card" aria-labelledby="advanced-title">
          <h2 id="advanced-title" class="card-title">高级</h2>
          <button
            type="button"
            class="ghost"
            :aria-expanded="advancedOpen ? 'true' : 'false'"
            aria-controls="advanced-embed"
            @click="advancedOpen = !advancedOpen"
          >
            {{ advancedOpen ? '收起向量端点' : '向量端点（语义分段检索）' }}
          </button>
          <p class="card-note">
            三项全留空即继承上方对话端点——多数人不需要展开。只有对话与向量走不同服务商时才拆。
            向量端点只需要 embed（/embeddings）；rerank 用不上，无需配置。
            <template v-if="form.apiFormat === 'anthropic'">
              注意：Anthropic 协议没有向量接口——对话走 Anthropic 时，这里必须单独配一个 OpenAI
              兼容的向量服务（如硅基流动的 bge-m3），否则去广告识别退化为纯词表检索。
            </template>
          </p>
          <div v-show="advancedOpen" id="advanced-embed">
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
                <ModelCombo
                  v-model="form.embedModel"
                  :options="embedModelOptions"
                  :loading="embedModelsLoading"
                  placeholder="留空则继承对话端点"
                  label="嵌入模型"
                />
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
            <div class="field">
              <button
                type="button"
                class="ghost"
                :disabled="embedTest.running"
                aria-label="测试向量端点"
                @click="testEmbedInline"
              >
                {{ embedTest.running ? '测试中…' : '测试连接' }}
              </button>
              <div
                v-if="embedTest.result"
                class="feedback"
                :class="embedTest.result.kind"
                aria-live="polite"
              >
                <span class="badge" aria-hidden="true">
                  {{ embedTest.result.kind === 'ok' ? '✓' : embedTest.result.kind === 'warn' ? '!' : '✕' }}
                </span>
                <span>{{ embedTest.result.text }}</span>
              </div>
            </div>
          </div>

          <button
            type="button"
            class="ghost"
            :aria-expanded="detectOpen ? 'true' : 'false'"
            aria-controls="advanced-detect"
            @click="detectOpen = !detectOpen"
          >
            {{ detectOpen ? '收起去广告端点' : '去广告端点（可选 · 省 token）' }}
          </button>
          <p class="card-note">
            留空即继承对话端点。广告定界是约束很强的结构化任务，flash 档的便宜模型就够用——
            高频的去广告走这里，总结/提问仍走对话端点，token 成本能降一个量级。
            另有免 token 通道：词表与弹幕双源强一致时直接出结果，不调模型。
          </p>
          <div v-show="detectOpen" id="advanced-detect">
            <label class="field">
              <span class="field-label">Base URL</span>
              <input
                v-model.trim="form.detectApiUrl"
                type="url"
                placeholder="留空则继承对话端点"
                :class="{ inheriting: detectBaseInherits }"
              />
              <span v-if="detectBaseInherits" class="field-hint">{{ detectBaseHint }}</span>
            </label>
            <label class="field">
              <span class="field-label">API Key</span>
              <input
                v-model="form.detectApiKey"
                type="password"
                placeholder="留空则继承对话端点"
                :class="{ inheriting: detectKeyInherits }"
                autocomplete="off"
              />
              <span v-if="detectKeyInherits" class="field-hint">{{ detectKeyHint }}</span>
            </label>
            <label class="field">
              <span class="field-label">模型</span>
              <input
                v-model.trim="form.detectModel"
                placeholder="留空则继承对话端点"
                :class="{ inheriting: detectModelInherits }"
              />
              <span v-if="detectModelInherits" class="field-hint">{{ detectModelHint }}</span>
            </label>
            <label class="field">
              <span class="field-label">协议</span>
              <select v-model="form.detectApiFormat">
                <option value="inherit">继承对话端点的协议</option>
                <option value="openai">OpenAI 兼容</option>
                <option value="anthropic">Anthropic Messages</option>
              </select>
            </label>
            <div class="field">
              <button
                type="button"
                class="ghost"
                :disabled="detectTest.running"
                aria-label="测试去广告端点"
                @click="testDetectInline"
              >
                {{ detectTest.running ? '测试中…' : '测试连接' }}
              </button>
              <div
                v-if="detectTest.result"
                class="feedback"
                :class="detectTest.result.kind"
                aria-live="polite"
              >
                <span class="badge" aria-hidden="true">
                  {{ detectTest.result.kind === 'ok' ? '✓' : detectTest.result.kind === 'warn' ? '!' : '✕' }}
                </span>
                <span>{{ detectTest.result.text }}</span>
              </div>
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
          <p class="content-sub">按开关启停，改动即时保存并持久化（默认全部关闭）。</p>
        </header>
        <FeaturesSection v-if="activeGroupId" :group-id="activeGroupId" />
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

/* 广告词库：一行「词条 + 品类 + 补录」，下面挂可选备注与已补录列表。 */
select {
  box-sizing: border-box;
  padding: 9px 10px;
  border-radius: 10px;
  border: 1px solid #e3def0;
  background: #ffffff;
  font-size: 12.5px;
  font-family: inherit;
  color: #2e2a3b;
  cursor: pointer;
}

select:focus {
  border-color: #7c5cfc;
  box-shadow: 0 0 0 3px rgba(124, 92, 252, 0.12);
}

.corpus-add {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 560px;
}

.corpus-add .grow {
  flex: 1;
  max-width: none;
}

.corpus-note-input {
  margin-top: 10px;
  max-width: 560px;
}

.corpus-list {
  list-style: none;
  margin: 14px 0 0;
  padding: 0;
  max-height: 220px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.corpus-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid #ece7f7;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.6);
  font-size: 13px;
}

.corpus-word {
  font-weight: 600;
}

.corpus-tag {
  font-size: 11px;
  color: #7c5cfc;
  background: #f1edff;
  border-radius: 999px;
  padding: 2px 8px;
  white-space: nowrap;
}

.corpus-note {
  font-size: 11.5px;
  color: #8b84a0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.corpus-batch {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
  max-width: 560px;
}

.corpus-batch-input {
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid #e3def0;
  background: #fbfaff;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.6;
  color: #2e2a3b;
  resize: vertical;
}

.corpus-batch .ghost {
  align-self: flex-start;
}

.corpus-hits {
  font-size: 11px;
  color: #2fa96b;
  background: #e9f6ee;
  border-radius: 999px;
  padding: 2px 8px;
  white-space: nowrap;
}

.corpus-hits.zero {
  color: #a49cb8;
  background: #f1eef9;
}

.corpus-del {
  margin-left: auto;
  border: none;
  background: transparent;
  color: #a49cb8;
  font-size: 12px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 6px;
  flex-shrink: 0;
}

.corpus-del:hover {
  color: #e5484d;
  background: #fdecee;
}

.corpus-actions {
  display: flex;
  gap: 10px;
  margin-top: 14px;
}

.ghost.danger {
  color: #e5484d;
  border-color: rgba(255, 143, 163, 0.45);
}

.ghost.danger:hover:not(:disabled) {
  background: #fdecee;
}

.corpus-patch {
  width: 100%;
  max-width: 560px;
  box-sizing: border-box;
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid #e3def0;
  background: #fbfaff;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
  font-size: 12px;
  line-height: 1.6;
  color: #4a4460;
  resize: vertical;
}

/* 备份卡片：文件选择伪装成 ghost 按钮（原生 input 不参与视觉）。 */
.backup-file {
  position: relative;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
}

.backup-file input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
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

/* ---------- 配置方案 ---------- */
.profile-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.profile-row select {
  flex: 1;
  min-width: 0;
}

/* ---------- 反馈行（内联测试 / 方案 / 词库共用：徽标 + 文案） ---------- */
.feedback {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  padding: 10px 14px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.6;
}

.feedback .badge {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  border: 1px solid currentColor;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
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

/* 黄灯：可达但没体检到底（第三方服务未提供体检接口），不是错误，别用红色吓人。 */
.feedback.warn {
  background: #fdf5e6;
  color: #b5822a;
  border: 1px solid rgba(240, 196, 120, 0.4);
}

/* ---------- 诊断控制台：终端样式（黑底等宽、绿提示符、点击刷新） ---------- */
.diag-log-actions {
  display: flex;
  gap: 10px;
  margin-bottom: 12px;
}

.bh-terminal {
  border-radius: 12px;
  border: 1px solid #2d2b3a;
  background: #0f1117;
  overflow: hidden;
  cursor: pointer;
  box-shadow: 0 8px 24px rgba(15, 17, 23, 0.35);
}

.terminal-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 14px;
  background: #161922;
  border-bottom: 1px solid #2d2b3a;
}

.terminal-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #3a3d47;
}

.terminal-dot:first-child {
  background: #e5565c;
}

.terminal-dot:nth-child(2) {
  background: #d9a94e;
}

.terminal-dot:nth-child(3) {
  background: #43b661;
}

.terminal-title {
  margin-left: 8px;
  font-size: 12px;
  color: #8b93a7;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
}

.terminal-count {
  margin-left: auto;
  font-size: 11px;
  color: #6b7280;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
}

.terminal-body {
  max-height: 360px;
  overflow-y: auto;
  padding: 12px 14px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
  font-size: 12px;
  line-height: 1.7;
  color: #c9d1d9;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.terminal-prompt {
  color: #43b661;
  margin-right: 6px;
}

.terminal-empty {
  color: #8b93a7;
}

.terminal-divider {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed #2a2e3d;
  color: #8b93a7;
  font-size: 11px;
}

.terminal-cursor {
  margin-left: 4px;
  color: #43b661;
  animation: terminal-blink 1.1s step-end infinite;
}

@keyframes terminal-blink {
  50% {
    opacity: 0;
  }
}

.diag-log-item {
  word-break: break-all;
}

.diag-log-line {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
}

.diag-log-feature {
  color: #79c0ff;
  font-weight: 700;
}

.diag-log-kind {
  font-size: 10.5px;
  border-radius: 4px;
  padding: 0 6px;
  background: rgba(248, 81, 73, 0.18);
  color: #f85149;
}

.diag-log-kind.parse,
.diag-log-kind.config {
  background: rgba(210, 153, 34, 0.18);
  color: #d29914;
}

.diag-log-msg {
  color: #c9d1d9;
}

.diag-log-raw {
  margin: 2px 0 0;
  padding: 6px 10px;
  border-radius: 6px;
  background: #161b27;
  border-left: 2px solid #30364a;
  color: #9aa4b8;
  font-family: inherit;
  font-size: 11.5px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 140px;
  overflow-y: auto;
}

.diag-log-meta {
  color: #6b7280;
  font-size: 11px;
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