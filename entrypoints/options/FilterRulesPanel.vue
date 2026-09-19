<script setup lang="ts">
// 设置页「筛选规则」面板（Epic2-S2.6）：只在「视频筛选」开关开启时展开（由 FeaturesSection 决定）。
// 八维度编辑 + 校验阻止保存 + 账号黑名单导入 + 保存/撤销/重置。文案沿旧产物口径。
// 时长以分钟编辑（step 0.1）、存储为秒；点赞率为百分比；发布时间为距今天数（整数）。
import { computed, onMounted, reactive, ref } from 'vue'
import { readFeatureConfig, writeFeatureConfig } from '../../modules/features/config'
import type { VideoFilterConfig } from '../../modules/features/config'
import { validateFilterConfig } from '../../modules/features/filter/rules'

/** 区间字段表（标签 + 存储键 + 单位与步进）。 */
const RANGES = [
  { label: '视频时长', unit: '（分钟）', step: '0.1', min: 'durationMinSeconds', max: 'durationMaxSeconds', toUi: (v: number | null) => (v === null ? '' : String(Math.round(v / 60 * 10) / 10)), fromUi: (v: string) => (v.trim() === '' ? null : Math.round(Number(v) * 60)) },
  { label: '发布距今天数', unit: '（天）', step: '1', min: 'pubdateMinDays', max: 'pubdateMaxDays', toUi: (v: number | null) => (v === null ? '' : String(v)), fromUi: (v: string) => (v.trim() === '' ? null : Math.round(Number(v))) },
  { label: '浏览量', unit: '', step: '1', min: 'viewMin', max: 'viewMax', toUi: (v: number | null) => (v === null ? '' : String(v)), fromUi: (v: string) => (v.trim() === '' ? null : Math.round(Number(v))) },
  { label: '点赞数', unit: '', step: '1', min: 'likeMin', max: 'likeMax', toUi: (v: number | null) => (v === null ? '' : String(v)), fromUi: (v: string) => (v.trim() === '' ? null : Math.round(Number(v))) },
  { label: '点赞率', unit: '（%）', step: '0.1', min: 'likeRateMin', max: 'likeRateMax', toUi: (v: number | null) => (v === null ? '' : String(v)), fromUi: (v: string) => (v.trim() === '' ? null : Math.round(Number(v) * 10) / 10) },
  { label: '弹幕数', unit: '', step: '1', min: 'danmakuMin', max: 'danmakuMax', toUi: (v: number | null) => (v === null ? '' : String(v)), fromUi: (v: string) => (v.trim() === '' ? null : Math.round(Number(v))) },
] as const

const form = reactive({
  titleKeywords: '',
  authorBlacklist: '',
  ranges: Object.fromEntries(RANGES.map((r) => [r.min, { min: '', max: '' }])) as Record<string, { min: string; max: string }>,
})
const hint = ref('')
const dirty = ref(false)
const saving = ref(false)
const importing = ref(false)

/** 把文本域解析成词条列表：行/英文或中文逗号分割，trim、去空、去重、保序。 */
function parseList(text: string): string[] {
  const out: string[] = []
  for (const part of text.split(/[\n,，]/u)) {
    const value = part.trim()
    if (value !== '' && !out.includes(value)) out.push(value)
  }
  return out
}

function applyConfigToForm(config: VideoFilterConfig): void {
  form.titleKeywords = config.titleKeywords.join('\n')
  form.authorBlacklist = config.authorBlacklist.join('\n')
  for (const range of RANGES) {
    const key = range.min as keyof VideoFilterConfig
    form.ranges[range.min] = {
      min: range.toUi(config[key] as number | null),
      max: range.toUi(config[(range.max as keyof VideoFilterConfig)] as number | null),
    }
  }
  dirty.value = false
}

/** 从表单构造待保存配置（含字段级数值校验错误收集）。 */
const numberErrors = computed(() => {
  const errors: string[] = []
  for (const range of RANGES) {
    for (const side of ['min', 'max'] as const) {
      const raw = form.ranges[range.min]?.[side] ?? ''
      if (raw.trim() === '') continue
      const value = Number(raw)
      if (!Number.isFinite(value) || value < 0) {
        errors.push('请输入大于或等于 0 的数字')
        return errors
      }
      if (range.label === '发布距今天数' && !Number.isInteger(value)) {
        errors.push('发布时间请输入大于或等于 0 的整数天数')
        return errors
      }
    }
  }
  return errors
})

const builtConfig = computed<VideoFilterConfig>(() => {
  const config = {
    titleKeywords: parseList(form.titleKeywords),
    authorBlacklist: parseList(form.authorBlacklist),
  } as unknown as Record<string, unknown>
  for (const range of RANGES) {
    config[range.min] = range.fromUi(form.ranges[range.min]?.min ?? '')
    config[range.max] = range.fromUi(form.ranges[range.min]?.max ?? '')
  }
  return config as unknown as VideoFilterConfig
})

/** 区间级校验（min>max 等）复用引擎的校验函数——UI 与拦截器同一份口径。 */
const rangeErrors = computed(() => validateFilterConfig(builtConfig.value))

const configuredCount = computed(() => {
  const config = builtConfig.value
  let count = config.titleKeywords.length + config.authorBlacklist.length
  for (const key of Object.keys(config)) {
    if (key.endsWith('Min') || key.endsWith('Max') || key.endsWith('Days') || key.endsWith('Seconds')) {
      if ((config[key as keyof VideoFilterConfig] as number | null) !== null) count += 1
    }
  }
  // 区间成对算一条太细：粗略按已配置字段数即可，头部展示「N 项条件已配置」。
  return Math.min(count, 99)
})

const canSave = computed(
  () => numberErrors.value.length === 0 && rangeErrors.value.length === 0 && dirty.value,
)

function markDirty(): void {
  dirty.value = true
  hint.value = ''
}

/** 区间输入统一入口：key=存储最小值键名，side=min/max。 */
function setRange(key: string, side: 'min' | 'max', event: Event): void {
  const value = (event.target as HTMLInputElement).value
  const slot = form.ranges[key] ?? (form.ranges[key] = { min: '', max: '' })
  slot[side] = value
  markDirty()
}

async function save(): Promise<void> {
  if (!canSave.value || saving.value) return
  saving.value = true
  try {
    await writeFeatureConfig('videoFilter', builtConfig.value)
    applyConfigToForm(builtConfig.value)
    hint.value = '已保存并应用'
  } catch {
    hint.value = '保存失败，请稍后重试'
  } finally {
    saving.value = false
  }
}

async function undo(): Promise<void> {
  const entry = await readFeatureConfig('videoFilter')
  applyConfigToForm(entry.config)
  hint.value = ''
}

function resetToUnlimited(): void {
  form.titleKeywords = ''
  form.authorBlacklist = ''
  for (const range of RANGES) form.ranges[range.min] = { min: '', max: '' }
  markDirty()
  hint.value = '已重置为不限（尚未保存）'
}

/** 导入账号黑名单：分页拉 /x/relation/blacks（登录态），mid 与昵称都合入。 */
async function importBlacklist(): Promise<void> {
  if (importing.value) return
  importing.value = true
  hint.value = ''
  try {
    const collected: string[] = []
    for (let page = 1; page <= 50; page += 1) {
      const response = await fetch(
        `https://api.bilibili.com/x/relation/blacks?re_version=0&pn=${page}&ps=50`,
        { credentials: 'include' },
      )
      const data = (await response.json()) as { data?: { list?: { mid?: number; uname?: string }[] } }
      const list = data.data?.list ?? []
      for (const item of list) {
        if (typeof item.mid === 'number') collected.push(String(item.mid))
        if (typeof item.uname === 'string' && item.uname.trim() !== '') collected.push(item.uname.trim())
      }
      if (list.length < 50) break
    }
    if (collected.length === 0) {
      hint.value = '当前没有可导入的账号黑名单'
    } else {
      const before = parseList(form.authorBlacklist).length
      const merged = parseList(`${form.authorBlacklist}\n${collected.join('\n')}`)
      form.authorBlacklist = merged.join('\n')
      markDirty()
      hint.value = `已导入 ${merged.length - before} 个账号黑名单（共 ${merged.length} 条）`
    }
  } catch {
    hint.value = '导入失败，请稍后重试'
  } finally {
    importing.value = false
  }
}

onMounted(async () => {
  const entry = await readFeatureConfig('videoFilter')
  applyConfigToForm(entry.config)
})
</script>

<template>
  <div class="video-filter-editor" aria-label="筛选规则">
    <div class="vf-head">
      <strong>筛选规则</strong>
      <span class="vf-count">{{ configuredCount }} 项条件已配置</span>
      <span class="vf-apply">保存后应用于首页推荐</span>
    </div>
    <p class="vf-risk">
      请勿将筛选范围设置得过窄。连续 3 批推荐均无符合项时，插件会暂停过滤后续推荐，避免页面频繁请求接口并降低触发账号风控的风险。
    </p>

    <div class="vf-group">内容</div>
    <label class="field">
      <span class="field-label">标题关键字黑名单</span>
      <textarea v-model="form.titleKeywords" rows="2" placeholder="每行一个关键字" aria-label="标题关键字黑名单" @input="markDirty" />
    </label>
    <label class="field">
      <span class="field-label">UP主黑名单</span>
      <textarea v-model="form.authorBlacklist" rows="2" placeholder="UP主名称或 mid，每行一个" aria-label="UP主黑名单" @input="markDirty" />
      <button type="button" class="ghost" :disabled="importing" @click="importBlacklist">
        {{ importing ? '导入中...' : '导入账号黑名单' }}
      </button>
    </label>

    <div class="vf-group">时长与发布时间</div>
    <div v-for="range in RANGES.slice(0, 2)" :key="range.min" class="field">
      <span class="field-label">{{ range.label }} {{ range.unit }}</span>
      <div class="range-row">
        <input
          type="number" min="0" :step="range.step" placeholder="不限"
          :aria-label="`${range.label}最小值`"
          :value="form.ranges[range.min]?.min ?? ''"
          @input="setRange(range.min, 'min', $event)"
        />
        <span class="range-sep">-</span>
        <input
          type="number" min="0" :step="range.step" placeholder="不限"
          :aria-label="`${range.label}最大值`"
          :value="form.ranges[range.min]?.max ?? ''"
          @input="setRange(range.min, 'max', $event)"
        />
      </div>
    </div>

    <div class="vf-group">视频数据</div>
    <div v-for="range in RANGES.slice(2)" :key="range.min" class="field">
      <span class="field-label">{{ range.label }} {{ range.unit }}</span>
      <div class="range-row">
        <input
          type="number" min="0" :step="range.step" placeholder="不限"
          :aria-label="`${range.label}最小值`"
          :value="form.ranges[range.min]?.min ?? ''"
          @input="setRange(range.min, 'min', $event)"
        />
        <span class="range-sep">-</span>
        <input
          type="number" min="0" :step="range.step" placeholder="不限"
          :aria-label="`${range.label}最大值`"
          :value="form.ranges[range.min]?.max ?? ''"
          @input="setRange(range.min, 'max', $event)"
        />
      </div>
    </div>
    <p class="vf-help">点赞率 = 点赞数 / 浏览量 * 100（百分比，例：5 表示 5%）</p>

    <div v-if="numberErrors.length > 0 || rangeErrors.length > 0" class="vf-errors" role="alert">
      <p v-for="error in [...numberErrors, ...rangeErrors]" :key="error">{{ error }}</p>
    </div>

    <div class="vf-actions">
      <button type="button" class="ghost" @click="resetToUnlimited">重置为不限</button>
      <button type="button" class="ghost" :disabled="!dirty" @click="undo">撤销修改</button>
      <button type="button" class="primary" :disabled="!canSave || saving" @click="save">
        {{ saving ? '保存中...' : '保存并应用' }}
      </button>
      <!-- 有操作反馈先显反馈（导入/重置的提示不能被「未保存」挤掉），无反馈再显同步状态。 -->
      <span v-if="hint !== ''" class="vf-status" :class="{ ok: hint.includes('已') }">{{ hint }}</span>
      <span v-else-if="dirty" class="vf-status">有未保存的修改</span>
      <span v-else class="vf-status synced">配置已同步</span>
    </div>
  </div>
</template>

<style scoped>
.video-filter-editor {
  margin-top: 14px;
  padding: 14px 16px;
  border: 1px solid var(--bh-border-primary);
  border-radius: 12px;
  background: var(--bh-purple-tint-weak);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.vf-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
  color: var(--bh-text-primary);
}

.vf-count { color: var(--bh-primary); font-size: 12px; }
.vf-apply { color: var(--bh-text-faint); font-size: 11.5px; margin-left: auto; }

.vf-risk {
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--bh-warn-deep);
  background: var(--bh-warn-soft);
  border-radius: 8px;
  padding: 6px 10px;
  margin: 0;
}

.vf-group { font-size: 12px; font-weight: 600; color: var(--bh-text-secondary); margin-top: 4px; }

.field { display: flex; flex-direction: column; gap: 4px; }
.field-label { font-size: 12px; color: var(--bh-text-strong); }

textarea {
  font: inherit;
  font-size: 12.5px;
  border: 1px solid var(--bh-border-strong);
  border-radius: 8px;
  padding: 6px 10px;
  resize: vertical;
}

.range-row { display: flex; align-items: center; gap: 8px; }
.range-row input {
  width: 110px;
  font: inherit;
  font-size: 12.5px;
  border: 1px solid var(--bh-border-strong);
  border-radius: 8px;
  padding: 6px 10px;
}
.range-sep { color: var(--bh-text-faint); }

.vf-help { font-size: 11px; color: var(--bh-text-faint); margin: -6px 0 0; }

.vf-errors { color: var(--bh-danger-deep); font-size: 12px; }
.vf-errors p { margin: 0; }

.vf-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.vf-status { font-size: 12px; color: var(--bh-warn); }
.vf-status.ok { color: var(--bh-success-deep); }
.vf-status.synced { color: var(--bh-text-faint); }

button.ghost {
  font: inherit;
  font-size: 12.5px;
  border: 1px solid var(--bh-border-strong);
  background: var(--bh-surface-input);
  color: var(--bh-text-strong);
  border-radius: 8px;
  padding: 5px 12px;
  cursor: pointer;
}
button.ghost:disabled { opacity: 0.5; cursor: default; }
button.primary {
  font: inherit;
  font-size: 12.5px;
  border: none;
  /* 与「保存设置」用同一支渐变（primary 端偏浅，白字对比不足；深端起步才读得清）。 */
  background: linear-gradient(135deg, var(--bh-primary-deep), var(--bh-primary-bright));
  color: var(--bh-text-on-accent);
  border-radius: 8px;
  padding: 6px 14px;
  cursor: pointer;
  box-shadow: 0 3px 10px var(--bh-shadow-accent);
}

/* 禁用态必须看得出来：无改动可存时这个按钮不可点（原先只是"变淡"得像可点）。 */
button.primary:disabled {
  opacity: 0.55;
  cursor: default;
  box-shadow: none;
}
</style>
