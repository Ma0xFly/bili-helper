<script setup lang="ts">
// 模型可搜索选择器：几百个模型翻 datalist 翻不到，这里输入即过滤——
// 首字母/关键词命中，startsWith 优先、contains 次之，组内按字母序；↑↓ 选择、Enter 确认、Esc 关闭。
// 输入框同时是自由输入框（列表拉不到时手输模型名照常生效）。
import { computed, ref } from 'vue'

const props = defineProps<{
  modelValue: string
  options: string[]
  loading?: boolean
  placeholder?: string
  /** 无障碍标签（透传到 input 的 aria-label）。 */
  label: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const open = ref(false)
const activeIndex = ref(-1)
const inputEl = ref<HTMLInputElement | null>(null)

const keyword = computed(() => props.modelValue.trim().toLowerCase())
const hasKeyword = computed(() => keyword.value !== '')

/** 过滤 + 排序：startsWith 组在前（打首字母即跳到那一行），contains 组在后，各按字母序。 */
const filtered = computed(() => {
  const sorted = [...props.options].sort((a, b) => a.localeCompare(b))
  if (!hasKeyword.value) return sorted
  const prefix: string[] = []
  const infix: string[] = []
  for (const option of sorted) {
    const lower = option.toLowerCase()
    if (lower.startsWith(keyword.value)) prefix.push(option)
    else if (lower.includes(keyword.value)) infix.push(option)
  }
  return [...prefix, ...infix]
})

function choose(option: string): void {
  emit('update:modelValue', option)
  close()
}

function close(): void {
  open.value = false
  activeIndex.value = -1
}

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLInputElement).value)
  open.value = true
  activeIndex.value = -1
}

function onFocus(): void {
  if (props.options.length > 0) open.value = true
}

function onKeydown(event: KeyboardEvent): void {
  if (!open.value) {
    if (event.key === 'ArrowDown' && filtered.value.length > 0) {
      open.value = true
      activeIndex.value = 0
      event.preventDefault()
    }
    return
  }
  if (event.key === 'ArrowDown') {
    activeIndex.value = Math.min(activeIndex.value + 1, filtered.value.length - 1)
    event.preventDefault()
  } else if (event.key === 'ArrowUp') {
    activeIndex.value = Math.max(activeIndex.value - 1, 0)
    event.preventDefault()
  } else if (event.key === 'Enter') {
    const option = filtered.value[activeIndex.value]
    if (option !== undefined) {
      choose(option)
      event.preventDefault()
    }
  } else if (event.key === 'Escape') {
    close()
  }
}

// mousedown 先于 blur：在列表上按下时阻止默认，避免输入框失焦导致列表先收起、点击落空。
function pickOnMouseDown(event: MouseEvent, option: string): void {
  event.preventDefault()
  choose(option)
}
</script>

<template>
  <div class="model-combo grow">
    <input
      ref="inputEl"
      :value="modelValue"
      type="text"
      :placeholder="placeholder"
      :aria-label="label"
      autocomplete="off"
      role="combobox"
      :aria-expanded="open ? 'true' : 'false'"
      aria-autocomplete="list"
      @input="onInput"
      @focus="onFocus"
      @blur="close"
      @keydown="onKeydown"
    />
    <ul v-show="open && filtered.length > 0" class="model-list" role="listbox">
      <li
        v-for="(option, index) in filtered"
        :key="option"
        role="option"
        :aria-selected="option === modelValue ? 'true' : 'false'"
        :class="{ active: index === activeIndex }"
        @mousedown="pickOnMouseDown($event, option)"
        @mousemove="activeIndex = index"
      >
        {{ option }}
      </li>
    </ul>
    <span v-if="loading" class="model-loading">拉取中…</span>
    <span v-else-if="open && options.length > 0 && filtered.length === 0" class="model-loading">
      没有匹配的模型（可手动输入）
    </span>
  </div>
</template>

<style scoped>
/* 输入样式继承全局 input 规则；这里只管下拉列表自身。 */
.model-combo {
  position: relative;
  display: flex;
  flex-direction: column;
}

.model-list {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 30;
  margin: 4px 0 0;
  padding: 4px;
  list-style: none;
  max-height: 240px;
  overflow-y: auto;
  background: #ffffff;
  border: 1px solid #e3def0;
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(124, 92, 252, 0.14);
}

.model-list li {
  padding: 7px 10px;
  border-radius: 7px;
  font-size: 13px;
  color: #2e2a3b;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.model-list li.active,
.model-list li:hover {
  background: #f1edff;
  color: #5b3fd4;
}

.model-loading {
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 11px;
  color: #857fa0;
  pointer-events: none;
}
</style>
