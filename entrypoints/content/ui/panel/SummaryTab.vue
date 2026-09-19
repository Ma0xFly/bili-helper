<script setup lang="ts">
// 总结 tab：空态（声线文案「让 AI 给你总结一下？」）→ 生成中（gen-pill 呼吸光球 + 骨架流光 +
// 停止生成）→ Markdown 正文（marked + dompurify，v-html 前清洗）+ 分段时间线（与去广告区间合并
// 打「广告」标签、点击跳播、当前播放段高亮）。总结一律手动点击触发，运行模式不影响生成时机。
import { computed, onBeforeUnmount, ref } from 'vue'
import { panel, panelActions, panelActivity } from '../../../../modules/content/panel-state'
import { ui } from '../../../../modules/content/ui-state'
import { errorInfoFrom } from '../../../../modules/shared/error'
import type { AiErrorInfo } from '../../../../modules/shared/error'
import type { SummarizeResult } from '../../../../modules/ai/port'
import {
  adSegmentLabel,
  formatPanelTimestamp,
  mergeSegmentsWithAds,
  panelErrorCopy,
} from '../../../../modules/ai/panel-logic'
import type { PanelSegment } from '../../../../modules/ai/panel-logic'
import { extractCorpusCandidates } from '../../../../modules/ai/corpus-candidates'
import {
  addUserCorpusEntries,
  addUserCorpusEntry,
} from '../../../../modules/ai/rag/user-corpus'
import { renderMarkdown } from './render-markdown'

const result = ref<SummarizeResult | null>(null)
const error = ref<AiErrorInfo | null>(null)
let controller: AbortController | null = null
/** 本实例是否持有「生成中」状态：只允许自己收束，避免换视频销毁实例时踩掉新实例的标志。 */
let ownsGeneration = false

const generating = computed(() => panelActivity.summaryStatus === 'generating')

/** 会话未采集完成：展示骨架占位，生成按钮不可点。 */
const contextReady = computed(() => panel.session !== null)

/** 分段时间线 = 总结 segments × 去广告 ads 合并（ui.ads 由去广告链路维护，空 = 纯分段）。 */
const segments = computed<PanelSegment[]>(() =>
  result.value ? mergeSegmentsWithAds(result.value.segments, ui.ads) : [],
)

const errorCopy = computed(() => (error.value ? panelErrorCopy(error.value) : null))

const cleanedSummary = computed(() => (result.value ? renderMarkdown(result.value.summary) : ''))

function isCurrent(segment: PanelSegment): boolean {
  return ui.currentTime >= segment.start && ui.currentTime < segment.end
}

function seekSegment(segment: PanelSegment): void {
  panelActions.seek(segment.start)
}

async function generate(): Promise<void> {
  const session = panel.session
  if (!session || generating.value) return
  error.value = null
  result.value = null
  ownsGeneration = true
  panelActivity.summaryStatus = 'generating'
  controller = new AbortController()
  const signal = controller.signal
  try {
    const { video, subtitles, danmaku } = session.context
    const generated = await panelActions.summarize({ video, subtitles, danmaku, signal })
    if (signal.aborted) return
    result.value = generated
    // 时间线镜像进共享状态：章节接线层监听它 → 持久化缓存 + 与官方看点合并上进度条。
    ui.summarySegments = generated.segments
    ownsGeneration = false
    panelActivity.summaryDoneAt = Date.now()
    panelActivity.summaryStatus = 'done'
  } catch (caught) {
    // 用户点停止：abort 抛错回到空态（总结无部分产物可保留）。
    if (signal.aborted) return
    ownsGeneration = false
    error.value = errorInfoFrom(caught)
    panelActivity.summaryStatus = 'idle'
  } finally {
    if (controller === null || controller.signal === signal) controller = null
  }
}

function stop(): void {
  // 停止 = abort 端口调用的 signal，回到空态；端口保证以 end/异常收束。
  ownsGeneration = false
  panelActivity.summaryStatus = 'idle'
  controller?.abort()
}

// ---------- 漏检补录（面板内直达词库） ----------
// 「这段是广告但没被认出来」：取当前播放位置 ±30 秒字幕切出候选信号词，
// 用户点选后批量入库（scripts 品类）——把「猜词」变成「选词」。
const corpusToolOpen = ref(false)
const corpusCandidates = ref<string[]>([])
const corpusSelected = ref<string[]>([])
const corpusBusy = ref(false)
const corpusHint = ref('')
/** 打开工具时的播放位置（入库备注用，避免确认后时间已漂走）。 */
let corpusCenterSeconds = 0

function openCorpusTool(): void {
  const session = panel.session
  if (!session) return
  corpusCenterSeconds = ui.currentTime
  const candidates = extractCorpusCandidates(
    session.context.subtitles,
    corpusCenterSeconds - 30,
    corpusCenterSeconds + 30,
  )
  corpusCandidates.value = candidates
  corpusSelected.value = []
  corpusHint.value = candidates.length === 0 ? '这一段没有可用字幕，无法提取候选词' : ''
  corpusToolOpen.value = true
}

function toggleCorpusCandidate(text: string): void {
  const index = corpusSelected.value.indexOf(text)
  if (index === -1) corpusSelected.value.push(text)
  else corpusSelected.value.splice(index, 1)
}

async function confirmCorpusEntries(): Promise<void> {
  if (corpusBusy.value || corpusSelected.value.length === 0) return
  corpusBusy.value = true
  try {
    const result = await addUserCorpusEntries({
      texts: corpusSelected.value,
      category: 'scripts',
      note: `面板漏检补录 ${panel.session?.bvid ?? ''} ${formatPanelTimestamp(corpusCenterSeconds)}`,
    })
    corpusHint.value = result.ok
      ? `已补录 ${result.added} 条，下次识别即生效${result.skipped.length > 0 ? `（跳过 ${result.skipped.length} 条）` : ''}`
      : result.reason ?? '补录失败'
    if (result.ok) corpusSelected.value = []
  } finally {
    corpusBusy.value = false
  }
}

/** 广告段对应的产品名（从去广告链路的 ui.ads 按时间重叠找）。 */
function brandWordFor(segment: PanelSegment): string {
  const ad = ui.ads.find((item) => item.start < segment.end && item.end > segment.start)
  return ad?.product_name.trim() || ''
}

async function saveBrandWord(segment: PanelSegment): Promise<void> {
  const text = brandWordFor(segment)
  if (text === '') return
  const result = await addUserCorpusEntry({
    text,
    category: 'brands-user',
    note: `面板广告段 ${panel.session?.bvid ?? ''} ${formatPanelTimestamp(segment.start)}`,
  })
  corpusHint.value = result.ok
    ? `品牌词「${text}」已入库，下次识别即生效`
    : `「${text}」入库失败：${result.reason}`
  corpusToolOpen.value = true
}

onBeforeUnmount(() => {
  // 组件因换视频被销毁：中止挂起请求；只收束自己持有的生成态，不踩新实例的标志。
  controller?.abort()
  if (ownsGeneration) {
    ownsGeneration = false
    panelActivity.summaryStatus = 'idle'
  }
})
</script>

<template>
  <div class="bh-summary-tab">
    <!-- 生成中：gen-pill（呼吸光球 + 停止生成）+ 骨架流光 -->
    <div v-if="generating" class="bh-gen-pill">
      <span class="bh-gen-status"><span class="bh-orb-live" aria-hidden="true" />AI 生成中</span>
      <button type="button" class="bh-btn-stop" @click="stop">停止生成</button>
    </div>
    <div v-if="generating" class="bh-card" aria-hidden="true">
      <div class="bh-skeleton w92"></div>
      <div class="bh-skeleton w70"></div>
      <div class="bh-skeleton w82"></div>
      <div class="bh-skeleton w55"></div>
    </div>

    <!-- 上下文未就绪：骨架占位（资料准备中） -->
    <div v-else-if="!contextReady" class="bh-card" aria-hidden="true">
      <div class="bh-skeleton w88"></div>
      <div class="bh-skeleton w64"></div>
      <div class="bh-skeleton w72"></div>
    </div>

    <!-- 错误态：AiError kind 映射文案 + 设置入口 + 重新生成主 CTA -->
    <template v-else-if="error">
      <div class="bh-feedback error" role="alert">
        <div class="bh-feedback-body">
          <span class="bh-feedback-title">{{ errorCopy?.title }}</span>
          <span class="bh-feedback-hint">{{ errorCopy?.hint }}</span>
        </div>
        <button v-if="errorCopy?.withSettingsLink" type="button" class="bh-link" @click="panelActions.openSettings">
          去看看端点设置？
        </button>
      </div>
      <div class="bh-panel-empty">
        <button type="button" class="bh-btn-primary" @click="generate">重新生成</button>
      </div>
    </template>

    <!-- 完成态：Markdown 正文 + 分段时间线 -->
    <template v-else-if="result">
      <div class="bh-card">
        <!-- eslint-disable-next-line vue/no-v-html -- AI 输出经 marked + dompurify 清洗后注入 -->
        <div class="bh-markdown" v-html="cleanedSummary"></div>
      </div>
      <template v-if="segments.length > 0">
        <h3 class="bh-sum-h">视频分段</h3>
        <ol class="bh-seg-list">
          <li v-for="(segment, index) in segments" :key="`${segment.start}-${index}`">
            <button
              type="button"
              class="bh-seg-item"
              :class="{ current: isCurrent(segment) }"
              :style="{ animationDelay: `${Math.min(index * 40, 480)}ms` }"
              :aria-label="`跳到 ${formatPanelTimestamp(segment.start)}：${segment.label}`"
              @click="seekSegment(segment)"
            >
              <span class="bh-seg-time">{{ formatPanelTimestamp(segment.start) }}</span>
              <span class="bh-seg-label">
                {{ segment.isAd ? adSegmentLabel(segment.label, segment.end) : segment.label }}
              </span>
              <span v-if="segment.isAd" class="bh-seg-ad">广告</span>
            </button>
            <button
              v-if="segment.isAd && brandWordFor(segment) !== ''"
              type="button"
              class="bh-seg-brand"
              :aria-label="`把 ${brandWordFor(segment)} 补录进广告词库`"
              @click="saveBrandWord(segment)"
            >
              品牌词入库
            </button>
          </li>
        </ol>
      </template>
    </template>

    <!-- 空态：声线文案 + 生成按钮 -->
    <template v-else>
      <div class="bh-panel-empty">
        <span class="bh-panel-empty-glyph" aria-hidden="true" />
        <span class="bh-panel-empty-title">让 AI 给你总结一下？</span>
        <button type="button" class="bh-btn-primary" @click="generate">生成总结</button>
      </div>
    </template>

    <!-- 漏检补录工具：广告没被认出来时，从当前位置 ±30s 字幕里选词入库 -->
    <div v-if="contextReady && !generating" class="bh-corpus-tool">
      <button type="button" class="bh-link" @click="corpusToolOpen ? (corpusToolOpen = false) : openCorpusTool()">
        {{ corpusToolOpen ? '收起漏检补录' : '有广告没被认出来？漏检补录' }}
      </button>
      <template v-if="corpusToolOpen">
        <p v-if="corpusCandidates.length > 0" class="bh-corpus-tip">
          点选下方候选词（来自当前位置 ±30 秒字幕），选中后入库：
        </p>
        <div v-if="corpusCandidates.length > 0" class="bh-corpus-chips" role="group" aria-label="候选补录词">
          <button
            v-for="candidate in corpusCandidates"
            :key="candidate"
            type="button"
            class="bh-chip"
            :class="{ on: corpusSelected.includes(candidate) }"
            :aria-pressed="corpusSelected.includes(candidate) ? 'true' : 'false'"
            @click="toggleCorpusCandidate(candidate)"
          >
            {{ candidate }}
          </button>
        </div>
        <div v-if="corpusCandidates.length > 0" class="bh-corpus-actions">
          <button
            type="button"
            class="bh-btn-primary"
            :disabled="corpusSelected.length === 0 || corpusBusy"
            @click="confirmCorpusEntries"
          >
            {{ corpusBusy ? '入库中…' : `补录入库（${corpusSelected.length}）` }}
          </button>
        </div>
        <p v-if="corpusHint !== ''" class="bh-corpus-hint" role="status">{{ corpusHint }}</p>
      </template>
    </div>
  </div>
</template>