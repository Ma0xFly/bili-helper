<script setup lang="ts">
// 进度条章节标记（chapter-marks）——回退形态：官方看点 + AI 总结时间线合并后的导航刻度。
// 常规形态下刻度已注入原生进度条（native-marks.ts），点击由原生进度条接管（点哪跳哪），
// 悬停提示走 BarHoverTip；本组件只在注入不可用（ui.nativeMarksActive=false）时渲染，
// 沿用旧「标记盒几何镜像 + 刻度按钮点击跳转」口径。
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
  <div
    v-if="ui.chapterMarks.length > 0 && ui.marksBox.visible && !ui.nativeMarksActive"
    class="bh-chapters"
    :style="boxStyle()"
  >
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
