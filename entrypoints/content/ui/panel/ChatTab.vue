<script setup lang="ts">
// 提问 tab：欢迎语 + 推荐问题 chips（点击即发送）→ 流式回答（start/message{chunk} 逐块追加 +
// 打字光标、溯源 chip 点击跳播、上滚暂停自动滚底、end{error} 错误卡）+ 追问输入框。
// 多轮上下文装配复用 prompts.buildChatMessages 口径（上下文首条 + 轮次上限 20 裁剪最旧轮次）。
// 性能与可访问性：历史消息渲染结果按消息 id 记忆化（流式中不重解析历史，避免 O(n²)）；
// 流式期容器 aria-busy、aria-live 只宣告已完成消息；Enter 有中文 IME 组合守卫。
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { panel, panelActions, panelActivity } from '../../../../modules/content/panel-state'
import { errorInfoFrom } from '../../../../modules/shared/error'
import type { AiErrorInfo } from '../../../../modules/shared/error'
import type { AiChatEvent, ChatMessage } from '../../../../modules/ai/port'
import {
  buildContextUserMessage,
  CHAT_TURN_LIMIT,
  isNearBottom,
  panelErrorCopy,
  splitCitations,
  trimChatHistory,
} from '../../../../modules/ai/panel-logic'
import type { Citation } from '../../../../modules/ai/panel-logic'
import { renderMarkdown } from './render-markdown'

/** 预置推荐问题（EXPERIENCE 微文案表）。 */
const RECOMMENDED_QUESTIONS = ['内容是什么', '精华片段在哪', '重要结论', '怎么安利给朋友']

interface ChatRecord {
  id: number
  role: 'user' | 'assistant'
  /** assistant 为收束后的完整 Markdown；user 为问题原文。 */
  content: string
}

interface RenderedPart {
  kind: 'markdown' | 'citation'
  html: string
  citation: Citation | null
}

let nextId = 1

const messages = ref<ChatRecord[]>([])
const draft = ref('')
const partial = ref('')
const streamError = ref<AiErrorInfo | null>(null)
const answering = computed(() => panelActivity.chatAnswering)

// 多轮历史：首条 = 上下文 user 消息（buildChatMessages 同口径），随后为问答轮次。
// 组件按 session.bvid 键控重建（SPA 换视频复位），故装配放在 setup 期即可。
const history = ref<ChatMessage[]>(
  panel.session ? [buildContextUserMessage(panel.session.context)] : [],
)

let activeAbort: AbortController | null = null
/** 本实例是否持有「回答中」状态：只允许自己收束，避免换视频销毁实例时踩掉新实例的标志。 */
let ownsStreaming = false
/** 用户点「停止生成」：end{error} 与 reject 两条路径都按正常停止处理（不报错）。 */
let userStopped = false
/** 流代次：停止/新轮次后失效在途事件，防止旧流的 end/reject 串到新一轮。 */
let streamGeneration = 0

const sessionReady = computed(() => panel.session !== null)
const streamErrorCopy = computed(() =>
  streamError.value ? panelErrorCopy(streamError.value) : null,
)

// ---------- 自动滚底：用户上滚暂停，滚回底部恢复 ----------

const listEl = ref<HTMLElement | null>(null)
const stickToBottom = ref(true)

function onScroll(): void {
  const el = listEl.value
  if (!el) return
  stickToBottom.value = isNearBottom(el.scrollTop, el.clientHeight, el.scrollHeight)
}

function scrollToBottomIfStuck(): void {
  if (!stickToBottom.value) return
  void nextTick(() => {
    const el = listEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

// ---------- SSE 消费铁律：message{chunk} 逐块追加、end（含 end.error）收束 ----------

/** 把收束的助手回答落账（消息 + 裁剪后的多轮历史）。 */
function commitAssistant(content: string): void {
  messages.value.push({ id: nextId, role: 'assistant', content })
  nextId += 1
  history.value = trimChatHistory(
    [...history.value, { role: 'assistant', content }],
    CHAT_TURN_LIMIT,
  )
}

function handleEvent(event: AiChatEvent, generation: number): void {
  if (generation !== streamGeneration) return // 已停止/新轮次：在途事件作废。
  if (event.type === 'start') {
    partial.value = ''
  } else if (event.type === 'message') {
    partial.value += event.chunk
    scrollToBottomIfStuck()
  } else {
    // end：端口保证以 end 收尾。用户点停止已提前落账并失效本代次，正常到不了这里；
    // 其余 end{error} 走错误卡文案。
    const content = partial.value
    if (event.error && !userStopped) {
      streamError.value = event.error
    } else if (content.trim() !== '') {
      commitAssistant(content)
    }
    partial.value = ''
    if (ownsStreaming) {
      ownsStreaming = false
      panelActivity.chatAnswering = false
    }
    activeAbort = null
    userStopped = false
    scrollToBottomIfStuck()
  }
}

async function send(question: string): Promise<void> {
  const session = panel.session
  const text = question.trim()
  if (!text || answering.value || !session) return

  const generation = ++streamGeneration
  userStopped = false

  messages.value.push({ id: nextId, role: 'user', content: text })
  nextId += 1
  draft.value = ''
  partial.value = ''
  streamError.value = null
  stickToBottom.value = true
  scrollToBottomIfStuck()

  panelActivity.chatAnswering = true
  ownsStreaming = true
  const controller = new AbortController()
  activeAbort = controller
  // 轮次上限裁剪：上下文首条保留、最旧轮次被裁；端口侧按 context 自行装配上下文首条。
  history.value = trimChatHistory(
    [...history.value, { role: 'user', content: text }],
    CHAT_TURN_LIMIT,
  )
  try {
    await panelActions.chat(
      { messages: history.value.slice(1), context: session.context, signal: controller.signal },
      { onEvent: (event) => handleEvent(event, generation) },
    )
  } catch (caught) {
    // reject 路径（流开始前失败，含 server/auto 的 abort reject）也必须恢复可输入态：
    // 用户停止已在 stopStreaming 收束；真实错误才展示错误卡。
    if (generation !== streamGeneration) return
    if (ownsStreaming) {
      ownsStreaming = false
      panelActivity.chatAnswering = false
      activeAbort = null
      if (!userStopped && !controller.signal.aborted) {
        streamError.value = errorInfoFrom(caught)
      }
    }
    userStopped = false
  }
}

function stopStreaming(): void {
  // 无条件解除 answering 锁并中止请求：即使首个 SSE 事件未到（server/auto 走 abort reject
  // 而非 end），也恢复可输入态；已出内容立刻落账，在途 end/reject 事件经代次判定作废。
  userStopped = true
  streamGeneration += 1
  activeAbort?.abort()
  activeAbort = null
  const content = partial.value
  if (content.trim() !== '') commitAssistant(content)
  partial.value = ''
  if (ownsStreaming) {
    ownsStreaming = false
    panelActivity.chatAnswering = false
  }
}

function submit(): void {
  void send(draft.value)
}

/** Enter 提交：中文输入法组合确认（isComposing / keyCode 229）不触发。 */
function onEnterKey(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  submit()
}

function askQuestion(question: string): void {
  void send(question)
}

function clickCite(seconds: number): void {
  panelActions.seek(seconds)
}

/** 回答内容切分渲染：markdown 段经 marked + dompurify，溯源记法渲染为可点击 chip。 */
function renderParts(content: string): RenderedPart[] {
  return splitCitations(content).map((part) => {
    if (part.type === 'markdown') {
      return { kind: 'markdown', html: renderMarkdown(part.markdown), citation: null }
    }
    return { kind: 'citation', html: '', citation: part.citation }
  })
}

// 历史消息渲染结果按消息 id 记忆化：流式期每个 chunk 只重渲染 partial 一答，不重解析历史。
const renderedCache = new Map<number, RenderedPart[]>()

function partsFor(record: ChatRecord): RenderedPart[] {
  const cached = renderedCache.get(record.id)
  if (cached) return cached
  const rendered = renderParts(record.content)
  renderedCache.set(record.id, rendered)
  return rendered
}

// partial 增量渲染：单一流式回答，每 chunk 只切分/清洗一次当前 partial。
const partialParts = computed(() => renderParts(partial.value))

onBeforeUnmount(() => {
  // 组件因换视频被销毁：中止挂起流；只收束自己持有的回答态，不踩新实例的标志。
  activeAbort?.abort()
  if (ownsStreaming) {
    ownsStreaming = false
    panelActivity.chatAnswering = false
  }
})
</script>

<template>
  <div class="bh-chat-tab">
    <!-- 上下文未就绪：骨架占位 -->
    <div v-if="!sessionReady" class="bh-card" aria-hidden="true">
      <div class="bh-skeleton w88"></div>
      <div class="bh-skeleton w64"></div>
      <div class="bh-skeleton w72"></div>
    </div>

    <template v-else>
      <!-- 生成中：gen-pill（呼吸光球 + 停止生成） -->
      <div v-if="answering" class="bh-gen-pill">
        <span class="bh-gen-status"><span class="bh-orb-live" aria-hidden="true" />AI 生成中</span>
        <button type="button" class="bh-btn-stop" @click="stopStreaming">停止生成</button>
      </div>

      <!-- 对话记录 + 流式回答区：流式期 aria-busy，aria-live 只宣告已完成消息（不刷屏） -->
      <div
        v-if="messages.length > 0 || answering || streamError"
        ref="listEl"
        class="bh-chat-scroll"
        :aria-busy="answering ? 'true' : undefined"
        @scroll="onScroll"
      >
        <div aria-live="polite">
          <div v-for="record in messages" :key="record.id" class="bh-chat-entry">
            <div v-if="record.role === 'user'" class="bh-user-row">
              <div class="bh-user-bubble">{{ record.content }}</div>
            </div>
            <div v-else class="bh-answer-card">
              <template v-for="(part, partIndex) in partsFor(record)" :key="partIndex">
                <span v-if="part.kind === 'markdown'" class="bh-answer-md" v-html="part.html"></span>
                <button
                  v-else
                  type="button"
                  class="bh-cite"
                  @click="clickCite(part.citation?.seconds ?? 0)"
                >
                  {{ part.citation?.label }}
                </button>
              </template>
            </div>
          </div>
        </div>

        <!-- 流式回答中：增量渲染 + 打字光标（对读屏静默，完成才会播报） -->
        <div v-if="answering" class="bh-chat-entry" aria-hidden="true">
          <div class="bh-answer-card">
            <template v-for="(part, partIndex) in partialParts" :key="partIndex">
              <span v-if="part.kind === 'markdown'" class="bh-answer-md" v-html="part.html"></span>
              <button
                v-else
                type="button"
                class="bh-cite"
                @click="clickCite(part.citation?.seconds ?? 0)"
              >
                {{ part.citation?.label }}
              </button>
            </template>
            <span class="bh-cursor" aria-hidden="true"></span>
          </div>
        </div>

        <!-- 错误卡：AiError kind → 文案 + 设置入口 -->
        <div v-if="streamError" class="bh-feedback error" role="alert">
          <div class="bh-feedback-body">
            <span class="bh-feedback-title">{{ streamErrorCopy?.title }}</span>
            <span class="bh-feedback-hint">{{ streamErrorCopy?.hint }}</span>
          </div>
          <button
            v-if="streamErrorCopy?.withSettingsLink"
            type="button"
            class="bh-link"
            @click="panelActions.openSettings"
          >
            去看看端点设置？
          </button>
        </div>
      </div>

      <!-- 空态：欢迎语 + 推荐问题 chips -->
      <div v-else class="bh-chat-empty">
        <p class="bh-ask-welcome">关于这期视频，<strong>想问点什么？</strong></p>
        <p class="bh-ask-hint">字幕我都读过了，点一个开始，或者直接问～</p>
        <div class="bh-chips-row">
          <button
            v-for="question in RECOMMENDED_QUESTIONS"
            :key="question"
            type="button"
            class="bh-chip"
            @click="askQuestion(question)"
          >
            {{ question }}
          </button>
        </div>
      </div>
    </template>

    <!-- 追问输入框（回答下方保留） -->
    <div class="bh-input-bar">
      <input
        v-model="draft"
        class="bh-ask-input"
        type="text"
        placeholder="问问这期视频…"
        :disabled="!sessionReady || answering"
        aria-label="提问输入框"
        @keydown.enter="onEnterKey"
      />
      <button
        type="button"
        class="bh-btn-send"
        :disabled="!sessionReady || answering || draft.trim() === ''"
        aria-label="发送"
        @click="submit"
      >
        ↑
      </button>
    </div>
  </div>
</template>