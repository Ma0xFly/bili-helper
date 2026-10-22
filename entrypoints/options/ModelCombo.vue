<script setup lang="ts">
// 模型可搜索选择器：几百个模型翻 datalist 翻不到，这里输入即过滤——
// 首字母/关键词命中，startsWith 优先、contains 次之，组内按字母序；↑↓ 选择、Enter 确认、Esc 关闭。
// 输入框同时是自由输入框（列表拉不到时手输模型名照常生效）。
//
// 两个「被遮挡」都靠浮层化解决：
// ① 层级遮挡：设置页卡片带 backdrop-filter（毛玻璃），会创建堆叠上下文把列表的 z-index 关在卡内——
//    页面级吸底条（保存条）反而盖住列表下半部分，命中测试显示列表行的点击落到保存按钮上，
//    模型根本选不中。列表 Teleport 到 body 后层级由 body 统一裁决。
// ② 视口遮挡：长名单在页面底部时，列表下沿会被视口切掉。定位时按上下剩余空间决定展开方向
//    与高度（空间不够向上翻），并把浮层夹在视口内。
// ③ 名单可读性：长模型名不再用省略号截断——浮层宽度按内容撑开（受视口上限约束），
//    悬停另有 title 兜底。
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

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
const listEl = ref<HTMLElement | null>(null)
/** 浮层定位态（视口坐标，fixed 定位）。 */
const listStyle = ref<Record<string, string>>({
  position: 'fixed',
  top: '0px',
  left: '0px',
  width: '0px',
  maxHeight: '0px',
})

/** 浮层 id：与输入框 aria-controls 关联（combobox 模式），也便于测试定位。 */
let listSeq = 0
const listId = `bh-model-list-${(listSeq += 1)}`

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

/** 浮层最大高度上限（视口内实际可用高度更小时取小）。 */
const MAX_LIST_HEIGHT = 320
/** 浮层与视口边缘的最小间距。 */
const EDGE_GAP = 12

/**
 * 按输入框位置算浮层定位：默认向下展开；下方空间不够而上方够时改为向上展开，
 * 高度取两侧较大者——长名单在页面底部也不被视口切掉。
 */
function updatePosition(): void {
  const input = inputEl.value
  if (!input) return
  const rect = input.getBoundingClientRect()
  const gap = 4
  const spaceBelow = window.innerHeight - rect.bottom - gap - EDGE_GAP
  const spaceAbove = rect.top - gap - EDGE_GAP
  const flip = spaceAbove > spaceBelow
  const available = Math.max(80, flip ? spaceAbove : spaceBelow)
  const height = Math.min(MAX_LIST_HEIGHT, available)
  listStyle.value = {
    position: 'fixed',
    left: `${Math.round(rect.left)}px`,
    top: flip ? 'auto' : `${Math.round(rect.bottom + gap)}px`,
    bottom: flip ? `${Math.round(window.innerHeight - rect.top + gap)}px` : 'auto',
    // 宽度交给 CSS（max-content + min-width/max-width 约束），这里只给下限。
    minWidth: `${Math.round(rect.width)}px`,
    maxHeight: `${Math.round(height)}px`,
  }
  // 浮层按内容撑宽后可能顶出视口右沿：量出实际宽度再把左边夹回来。
  void nextTick(() => {
    const list = listEl.value
    if (!list) return
    const width = list.getBoundingClientRect().width
    const left = Math.round(rect.left)
    const overflow = left + width - (window.innerWidth - EDGE_GAP)
    if (overflow > 0) listStyle.value = { ...listStyle.value, left: `${Math.max(EDGE_GAP, left - overflow)}px` }
  })
}

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
  void nextTick(updatePosition)
}

function onFocus(): void {
  if (props.options.length > 0) {
    open.value = true
    void nextTick(updatePosition)
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (!open.value) {
    if (event.key === 'ArrowDown' && filtered.value.length > 0) {
      open.value = true
      activeIndex.value = 0
      event.preventDefault()
      void nextTick(updatePosition)
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

// 视口变化（滚动/缩放）时重算定位：浮层是 fixed 定位，不跟着输入框走会错位。
function onViewportChange(): void {
  if (open.value) updatePosition()
}

watch(open, (isOpen) => {
  if (isOpen) {
    window.addEventListener('scroll', onViewportChange, true)
    window.addEventListener('resize', onViewportChange)
  } else {
    window.removeEventListener('scroll', onViewportChange, true)
    window.removeEventListener('resize', onViewportChange)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('resize', onViewportChange)
})
</script>

<template>
  <div class="model-combo grow">
    <input
      ref="inputEl"
      :value="modelValue"
      type="text"
      :placeholder="placeholder"
      :aria-label="label"
      :aria-controls="listId"
      :aria-expanded="open ? 'true' : 'false'"
      aria-autocomplete="list"
      autocomplete="off"
      role="combobox"
      @input="onInput"
      @focus="onFocus"
      @blur="close"
      @keydown="onKeydown"
    />
    <Teleport to="body">
      <ul
        v-show="open && filtered.length > 0"
        :id="listId"
        ref="listEl"
        class="model-list"
        role="listbox"
        :style="listStyle"
      >
        <li
          v-for="(option, index) in filtered"
          :key="option"
          role="option"
          :title="option"
          :aria-selected="option === modelValue ? 'true' : 'false'"
          :class="{ active: index === activeIndex }"
          @mousedown="pickOnMouseDown($event, option)"
          @mousemove="activeIndex = index"
        >
          {{ option }}
        </li>
      </ul>
    </Teleport>
    <span v-if="loading" class="model-loading">拉取中…</span>
    <span v-else-if="open && options.length > 0 && filtered.length === 0" class="model-loading">
      没有匹配的模型（可手动输入）
    </span>
  </div>
</template>

<style scoped>
/* 样式自足：父组件 App.vue 的 style 是 scoped（元素选择器也带作用域标记），
   穿不到子组件的 input 上——这里必须自带一份，否则输入框会退回浏览器默认外观
   （2px inset 边框、21px 高），与设置页其它输入框不是一个样。 */
.model-combo {
  position: relative;
  display: flex;
  flex-direction: column;
}

.model-combo input {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 12px;
  border-radius: 10px;
  border: 1px solid var(--bh-border-hairline);
  background: var(--bh-surface-input);
  font-size: 13.5px;
  font-family: inherit;
  color: var(--bh-text-primary);
  outline: none;
}

.model-combo input:focus {
  border-color: var(--bh-primary);
  box-shadow: 0 0 0 3px var(--bh-shadow-focus);
}

/* 浮层在 body 下（Teleport 出去），scoped 的 data-v 标记照样带在元素上，样式照常生效。 */
.model-list {
  position: fixed;
  z-index: 30;
  margin: 0;
  padding: 4px;
  list-style: none;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--bh-surface-popover);
  border: 1px solid var(--bh-border-hairline);
  border-radius: 10px;
  box-shadow: 0 10px 30px var(--bh-shadow-popover);
  /* 宽度按最长的模型名撑开（min-width 给输入框宽度，max-width 兜住视口右沿）——
     长名字不再被省略号截断，短名单也不会比输入框窄。 */
  width: max-content;
  max-width: min(560px, calc(100vw - 24px));
}

.model-list li {
  padding: 7px 10px;
  border-radius: 7px;
  font-size: 13px;
  color: var(--bh-text-primary);
  cursor: pointer;
  white-space: nowrap;
}

.model-list li.active,
.model-list li:hover {
  background: var(--bh-purple-soft);
  color: var(--bh-primary-ink);
}

.model-loading {
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 11px;
  color: var(--bh-text-faint);
  pointer-events: none;
}
</style>
