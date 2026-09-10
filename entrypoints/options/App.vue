<script setup lang="ts">
// AI 助手组真实表单：对话端点、服务器开关（含回退子开关）、一键体检、功能开关，
// 向量端点折叠进「高级」（默认继承对话端点，绝大多数用户不需要展开）。
// 运行模式不暴露 local/server/auto 术语：开关关=local，开关开=server，回退勾上=auto。
// 端点读写只经 modules/settings 助手。其余分组（服务器独立页签/过滤/净化/布局/增强）仍为占位。

import { computed, onMounted, reactive, ref } from 'vue'
import { testChatEndpoint, testEmbeddingEndpoint } from '../../modules/ai/endpoint-test'
import type { EndpointTestResult } from '../../modules/ai/endpoint-test'
import { listModels } from '../../modules/ai/llm/client'
import { probeServerEndpoint } from '../../modules/ai/server-probe'
import { AD_SIGNAL_CORPUS } from '../../modules/ai/rag/corpus'
import {
  USER_CORPUS_CATEGORIES,
  addUserCorpusEntry,
  clearUserCorpus,
  exportUserCorpusMarkdown,
  readUserCorpus,
  removeUserCorpusEntry,
} from '../../modules/ai/rag/user-corpus'
import type { UserCorpusEntry } from '../../modules/ai/rag/user-corpus'
import { readAiSettings, resolveEmbeddingEndpoint, writeAiSettings } from '../../modules/settings'
import type { AiMode } from '../../modules/settings'

const groups = ['AI 助手', '服务器', '过滤', '净化', '布局', '增强']
const active = ref<string>(groups[0] ?? 'AI 助手')

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
    fallbackWanted.value = settings.mode === 'auto'
    form.serverBaseUrl = settings.serverBaseUrl
    form.serverToken = settings.serverToken
    form.adSkipEnabled = settings.adSkipEnabled
    form.panelEnabled = settings.panelEnabled
  } catch {
    // 读取失败要给可见提示，而不是静默留下空表单。
    loadError.value = '设置加载失败，请刷新重试'
  }
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

type Feedback = { kind: 'ok' | 'warn' | 'fail'; text: string }

const testing = ref(false)
const diagResults = ref<Feedback[]>([])
/** 自增运行号：只有最后一次体检的结果允许写回界面（迟到结果不得覆盖新状态）。 */
let diagnosticsRunId = 0

function renderFeedback(label: string, result: EndpointTestResult): Feedback {
  if (result.ok) return { kind: 'ok', text: `${label}连接成功 · ${result.model} 响应 ${result.ms}ms` }
  return { kind: 'fail', text: `${label}连接失败 · ${result.reason}` }
}

/**
 * 一键体检：按当前模式只测真正会被用到的通道，不测用不上的（纯 server 模式不测本机端点，
 * 纯 local 模式不测服务器）。auto 两边都测——回退路径必须真的可用，否则「智能回退」是空话。
 */
async function runDiagnostics(): Promise<void> {
  // 迟到结果守卫：体检要几秒，期间用户可能切走侧栏分组或再点一次体检；
  // 只有最后一次运行的结果才允许写回界面，否则上一轮的结果会突然盖到新页面上。
  const runId = (diagnosticsRunId += 1)
  testing.value = true
  diagResults.value = []
  try {
    const results: Feedback[] = []
    if (form.mode !== 'local') {
      const probe = await probeServerEndpoint({
        baseUrl: form.serverBaseUrl,
        token: form.serverToken,
      })
      if (!probe.ok) results.push({ kind: 'fail', text: `服务器连接失败 · ${probe.reason}` })
      else if (probe.healthSupported) results.push({ kind: 'ok', text: `服务器连接成功 · 响应 ${probe.ms}ms` })
      else results.push({ kind: 'warn', text: '服务器可达，但未提供体检接口（不影响转发）' })
    }
    if (form.mode !== 'server') {
      const embed = resolveEmbeddingEndpoint(form)
      const [chatResult, embedResult] = await Promise.all([
        testChatEndpoint({ baseUrl: form.apiUrl, model: form.model, apiKey: form.apiKey }),
        testEmbeddingEndpoint({ baseUrl: embed.baseUrl, model: embed.model, apiKey: embed.apiKey }),
      ])
      results.push(renderFeedback('对话端点', chatResult))
      // 向量端点继承对话端点时不单独报绿（同一条链路，避免噪音）；拆开了或出问题才报，
      // 出问题顺带展开高级区，让用户直接看到该改哪三个字段。
      const embedConfiguredSeparately =
        form.embedBaseUrl.trim() !== '' || form.embedModel.trim() !== '' || form.embedKey.trim() !== ''
      if (!embedResult.ok) advancedOpen.value = true
      if (embedConfiguredSeparately || !embedResult.ok) {
        results.push(renderFeedback('向量端点', embedResult))
      }
    }
    if (runId === diagnosticsRunId) diagResults.value = results
  } finally {
    // 无论探测结果如何，按钮都要从「体检中…」恢复（且只由最后一次运行恢复）。
    if (runId === diagnosticsRunId) testing.value = false
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

onMounted(loadUserCorpus)
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

        <section class="card" aria-labelledby="chat-endpoint-title">
          <h2 id="chat-endpoint-title" class="card-title">对话端点（总结 / 提问）</h2>
          <p v-if="!localEndpointsInUse" class="card-note">
            当前全部请求走服务器转发，这里的端点不会被使用；开启「失败时回退」或关掉服务器开关即恢复直连。
          </p>
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
                </span>
              </span>
              <span class="switch">
                <input v-model="useFallback" type="checkbox" aria-label="服务器失败时回退直连" />
                <span class="switch-track" aria-hidden="true" />
                <span class="switch-knob" aria-hidden="true" />
              </span>
            </label>
          </template>
        </section>

        <section class="card" aria-labelledby="test-title">
          <h2 id="test-title" class="card-title">一键体检</h2>
          <p class="card-note">
            按当前配置实际探测会被用到的通道：{{
              useServer
                ? useFallback
                  ? '服务器 + 浏览器直连的两个端点（回退路径也要可用）'
                  : '只探服务器'
                : '只探浏览器直连的端点'
            }}。
          </p>
          <button type="button" class="ghost" :disabled="testing" @click="runDiagnostics">
            {{ testing ? '体检中…' : '开始体检' }}
          </button>
          <div aria-live="polite">
            <div
              v-for="(item, index) in diagResults"
              :key="index"
              class="feedback"
              :class="item.kind"
            >
              <span class="dot" aria-hidden="true" />
              <span>{{ item.text }}</span>
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

          <ul v-if="userEntries.length > 0" class="corpus-list">
            <li v-for="entry in userEntries" :key="entry.text" class="corpus-item">
              <span class="corpus-word">{{ entry.text }}</span>
              <span class="corpus-tag">{{ entry.category }}</span>
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
            <span class="dot" aria-hidden="true" />
            <span>{{ corpusHint.text }}</span>
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

/* 黄灯：可达但没体检到底（第三方服务未提供体检接口），不是错误，别用红色吓人。 */
.feedback.warn {
  background: #fdf5e6;
  color: #b5822a;
  border: 1px solid rgba(240, 196, 120, 0.4);
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