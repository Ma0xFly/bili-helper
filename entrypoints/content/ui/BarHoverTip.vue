<script setup lang="ts">
// 原生进度条悬停提示（native-marks 配套）：标记本体已注入 B 站进度条，
// 这张卡是唯一的 Shadow 层交互面——章节显示标题/时间/来源；广告段显示商品名/区间
// 并带「不是广告」纠错按钮。位置由注入层按鼠标横位与原生预览高度算好（容器坐标）。
import { computed } from 'vue'
import { ui } from '../../../modules/content/ui-state'

const hover = computed(() => ui.barHover)
const sourceLabel = computed(() =>
  hover.value.chapter?.source === 'official' ? '章节' : 'AI 分段',
)
</script>

<template>
  <div
    v-if="hover.active && ui.marksBox.visible"
    class="bh-bar-tip"
    :style="{ left: `${hover.left}px`, bottom: `${hover.bottom}px` }"
    @mouseenter="ui.actions.keepBarHover"
    @mouseleave="ui.actions.endBarHover"
  >
    <template v-if="hover.chapter">
      <span class="bh-bar-tip-title">{{ hover.chapter.label }}</span>
      <span class="bh-bar-tip-meta">
        {{ hover.chapter.timeText }} · {{ sourceLabel }}
      </span>
    </template>
    <template v-else-if="hover.ad">
      <span class="bh-bar-tip-title">{{ hover.ad.productName || '恰饭段' }}</span>
      <span class="bh-bar-tip-meta">
        {{ hover.ad.range }}<template v-if="hover.ad.done"> · 已跳过</template>
      </span>
      <button
        type="button"
        class="bh-bar-tip-reject"
        title="从本视频移除该段并记住：不再自动跳"
        @click="ui.actions.onMarkNotAd(hover.ad.key)"
      >
        不是广告
      </button>
    </template>
  </div>
</template>
