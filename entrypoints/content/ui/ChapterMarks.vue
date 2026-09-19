<script setup lang="ts">
// 进度条章节标记（chapter-marks）：官方看点 + AI 总结时间线合并后的导航刻度。
// 与广告标记（ProgressMarks）同挂在标记盒几何上（章节跟踪器同步，同款防闪烁口径）；
// 刻度是细竖线（区别于广告的粉色横条），悬停出时间+标题，点击跳转到章节起点。
// 章节本身免费：官方看点来自 player 接口，AI 时间线是手动点总结时已付 token 的产物缓存。
import { ui } from '../../../modules/content/ui-state'

function boxStyle(): Record<string, string> {
  const { left, top, width } = ui.marksBox
  return {
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
  }
}

function sourceLabel(source: 'official' | 'ai'): string {
  return source === 'official' ? '章节' : 'AI 分段'
}
</script>

<template>
  <div v-if="ui.chapterMarks.length > 0 && ui.marksBox.visible" class="bh-chapters" :style="boxStyle()">
    <button
      v-for="chapter in ui.chapterMarks"
      :key="chapter.key"
      type="button"
      class="bh-chapter"
      :class="chapter.source"
      :style="{ left: `${chapter.leftPct}%` }"
      :aria-label="`跳到章节 ${chapter.timeText}：${chapter.label}`"
      @click="ui.actions.onSeek(chapter.start)"
    >
      <span class="bh-chapter-line" aria-hidden="true" />
      <span class="bh-chapter-tip">
        <span class="bh-chapter-title">{{ chapter.label }}</span>
        <span class="bh-chapter-meta">{{ chapter.timeText }} · {{ sourceLabel(chapter.source) }}</span>
      </span>
    </button>
  </div>
</template>
