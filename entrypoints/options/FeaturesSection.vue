<script setup lang="ts">
// 设置页功能分区（Epic1-S1.4）：按功能组渲染功能开关行——标题 / 描述 / 适用范围标签，
// 参与统计的两个拦截器带「今日拦截 N」。开关走 setFeatureEnabled（串行链持久化），
// 保存失败必须可见（拨回真实状态 + 错误文案），绝不静默假装成功。
// 样式自足（父组件 style 是 scoped，子组件继承不到）：与设置页既有开关同款视觉。
import { computed, onMounted, reactive, ref } from 'vue'
import {
  FEATURE_GROUPS,
  FEATURE_REGISTRY,
  readFeatureConfigs,
  readFeatureStats,
  setFeatureEnabled,
} from '../../modules/features/config'
import type { FeatureEntry, FeatureGroupId, FeatureId } from '../../modules/features/config'
import FilterRulesPanel from './FilterRulesPanel.vue'
import FilterLogPanel from './FilterLogPanel.vue'

const props = defineProps<{ groupId: FeatureGroupId }>()

const group = computed(() => FEATURE_GROUPS.find((item) => item.id === props.groupId))
const features = computed(() =>
  Object.values(FEATURE_REGISTRY).filter((feature) => feature.group === props.groupId),
)

const entries = reactive<Partial<Record<FeatureId, FeatureEntry>>>({})
const blockedToday = reactive<Partial<Record<FeatureId, number>>>({})
const hint = ref<{ kind: 'ok' | 'fail'; text: string } | null>(null)
const busyId = ref<FeatureId | null>(null)

async function reload(): Promise<void> {
  try {
    const map = await readFeatureConfigs()
    for (const feature of features.value) entries[feature.id] = map[feature.id]
    const stats = await readFeatureStats()
    for (const feature of features.value) {
      blockedToday[feature.id] = stats[feature.id]?.totalBlocked ?? 0
    }
  } catch {
    hint.value = { kind: 'fail', text: '功能配置读取失败，请刷新重试' }
  }
}

onMounted(() => void reload())

async function onToggle(id: FeatureId, event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const enabled = input.checked
  busyId.value = id
  hint.value = null
  try {
    entries[id] = await setFeatureEnabled(id, enabled)
    hint.value = {
      kind: 'ok',
      text: `已${enabled ? '开启' : '关闭'}${FEATURE_REGISTRY[id].title}`,
    }
  } catch (error) {
    // 失败可见：开关拨回真实状态，错误文案直说原因。
    input.checked = !enabled
    hint.value = {
      kind: 'fail',
      text: `保存失败：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    busyId.value = null
  }
}
</script>

<template>
  <section class="card" aria-labelledby="features-group-title">
    <h2 id="features-group-title" class="card-title">{{ group?.title ?? '功能' }}</h2>
    <label
      v-for="feature in features"
      :key="feature.id"
      class="switch-row"
      :for="`feature-${feature.id}`"
    >
      <span class="switch-info">
        <span class="switch-name">
          {{ feature.title }}
          <span class="applies-tag">{{ feature.appliesTo.join(' / ') }}</span>
          <span
            v-if="feature.counted && (blockedToday[feature.id] ?? 0) > 0"
            class="stat-badge"
          >今日拦截 {{ blockedToday[feature.id] }}</span>
        </span>
        <span class="switch-desc">{{ feature.description }}</span>
      </span>
      <span class="switch">
        <input
          :id="`feature-${feature.id}`"
          type="checkbox"
          :checked="entries[feature.id]?.enabled ?? false"
          :disabled="busyId === feature.id"
          :aria-label="`${feature.title}开关`"
          @change="onToggle(feature.id, $event)"
        />
        <span class="switch-track" aria-hidden="true" />
        <span class="switch-knob" aria-hidden="true" />
      </span>
    </label>
    <!-- 视频筛选开启后展开规则面板（关闭时收起，开关与规则一体）；
         拦截明细面板常驻（有明细才知道规则拦了什么、为什么）。 -->
    <FilterRulesPanel v-if="groupId === 'filter' && entries.videoFilter?.enabled" />
    <FilterLogPanel v-if="groupId === 'filter'" />
    <p v-if="hint" class="section-hint" :class="hint.kind" aria-live="polite">{{ hint.text }}</p>
  </section>
</template>

<style scoped>
.card {
  background: var(--bh-surface-glass);
  border: 1px solid var(--bh-glass-border);
  border-radius: 16px;
  padding: 18px 20px;
  box-shadow: 0 8px 24px var(--bh-shadow-card);
  backdrop-filter: blur(12px);
}

.card-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--bh-text-primary);
  margin: 0 0 12px;
}

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
  color: var(--bh-text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.applies-tag {
  font-size: 11px;
  font-weight: 500;
  color: var(--bh-primary);
  background: var(--bh-purple-tint);
  border-radius: 6px;
  padding: 1px 6px;
}

.stat-badge {
  font-size: 11px;
  font-weight: 600;
  color: var(--bh-success-deep);
  background: var(--bh-success-tint);
  border-radius: 6px;
  padding: 1px 6px;
}

.switch-desc {
  font-size: 12px;
  color: var(--bh-text-secondary);
  line-height: 1.5;
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

.switch input:focus-visible ~ .switch-track {
  outline: 2px solid var(--bh-primary);
  outline-offset: 2px;
}

.section-hint {
  margin: 12px 0 0;
  font-size: 12px;
}

.section-hint.ok {
  color: var(--bh-success-deep);
}

.section-hint.fail {
  color: var(--bh-danger-deep);
}
</style>
