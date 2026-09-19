<script setup lang="ts">
// 拦截明细面板（过滤视频组内）：videoFilter 命中的「视频 + 规则原因」+ 广告/推广拦截器
// 的移除记录，环形保留最近 100 条。规则调参的依据——计数只说拦了多少，明细才说拦了什么。
import { computed, onMounted, ref } from 'vue'
import {
  FILTER_LOG_LIMIT,
  clearFilterLog,
  readFilterLog,
} from '../../modules/features/filter/filter-log'
import type { FilterLogEntry } from '../../modules/features/filter/filter-log'

const open = ref(false)
const entries = ref<FilterLogEntry[]>([])
const hint = ref('')

async function reload(): Promise<void> {
  try {
    entries.value = await readFilterLog()
  } catch {
    entries.value = []
  }
}

onMounted(() => void reload())

async function onClear(): Promise<void> {
  try {
    await clearFilterLog()
    entries.value = []
    hint.value = '已清空拦截明细'
  } catch (error) {
    hint.value = `清空失败：${error instanceof Error ? error.message : String(error)}`
  }
}

/** 按规则原因聚合（调参视角：哪条规则拦得最多一眼可见）。 */
const reasonCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const entry of entries.value) counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
})

function timeText(time: number): string {
  if (time <= 0) return '--:--'
  const date = new Date(time)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
</script>

<template>
  <div class="filter-log">
    <button
      type="button"
      class="ghost log-toggle"
      :aria-expanded="open ? 'true' : 'false'"
      @click="open = !open"
    >
      {{ open ? '收起拦截明细' : `拦截明细（最近 ${entries.length}/${FILTER_LOG_LIMIT} 条）` }}
    </button>
    <template v-if="open">
      <p v-if="reasonCounts.length > 0" class="log-summary">
        <span v-for="[reason, count] in reasonCounts" :key="reason" class="log-chip">
          {{ reason }} × {{ count }}
        </span>
      </p>
      <ul v-if="entries.length > 0" class="log-list" role="log">
        <li v-for="(entry, index) in entries" :key="`${entry.bvid}-${entry.reason}-${index}`" class="log-item">
          <span class="log-time">{{ timeText(entry.time) }}</span>
          <span class="log-surface">{{ entry.surface }}</span>
          <span class="log-reason">{{ entry.reason }}</span>
          <a
            class="log-title"
            :href="`https://www.bilibili.com/video/${entry.bvid}`"
            target="_blank"
            rel="noreferrer"
            :title="entry.title || entry.bvid"
          >{{ entry.title || entry.bvid }}</a>
        </li>
      </ul>
      <p v-else class="log-empty">
        还没有拦截记录：开启「视频筛选」并配置规则，或在首页开启「广告视频 / 推广视频」拦截。
      </p>
      <div class="log-actions">
        <button type="button" class="ghost danger" :disabled="entries.length === 0" @click="onClear">
          清空明细
        </button>
      </div>
    </template>
    <p v-if="hint !== ''" class="log-hint" aria-live="polite">{{ hint }}</p>
  </div>
</template>

<style scoped>
.filter-log {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed #ece7f7;
}

.log-toggle {
  border: 1px solid #e3def0;
  background: rgba(255, 255, 255, 0.7);
  border-radius: 10px;
  padding: 7px 12px;
  font-size: 12px;
  color: #7c5cfc;
  cursor: pointer;
}

.log-toggle:hover {
  background: #f1edff;
}

.log-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0 0;
}

.log-chip {
  font-size: 11px;
  color: #6f6a80;
  background: #f6f3ff;
  border-radius: 999px;
  padding: 2px 9px;
}

.log-list {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  max-height: 260px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.log-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.6);
  font-size: 12px;
  min-width: 0;
}

.log-time {
  font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
  font-size: 11px;
  color: #a49cb8;
  flex-shrink: 0;
}

.log-surface {
  font-size: 10.5px;
  color: #7c5cfc;
  background: rgba(124, 92, 252, 0.1);
  border-radius: 6px;
  padding: 1px 6px;
  flex-shrink: 0;
}

.log-reason {
  color: #b5822a;
  font-weight: 600;
  flex-shrink: 0;
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-title {
  color: #2e2a3b;
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-title:hover {
  color: #7c5cfc;
  text-decoration: underline;
}

.log-empty {
  margin: 10px 0 0;
  font-size: 12px;
  color: #8b84a0;
}

.log-actions {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}

.ghost.danger {
  border: 1px solid rgba(255, 143, 163, 0.45);
  background: rgba(255, 255, 255, 0.7);
  border-radius: 10px;
  padding: 7px 12px;
  font-size: 12px;
  color: #e5484d;
  cursor: pointer;
}

.ghost.danger:hover:not(:disabled) {
  background: #fdecee;
}

.ghost.danger:disabled {
  opacity: 0.5;
  cursor: default;
}

.log-hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: #6f6a80;
}
</style>
