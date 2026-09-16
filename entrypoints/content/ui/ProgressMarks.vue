<script setup lang="ts">
// 进度条广告标记（progressBarAdMark）：detectAds 结果区间在播放器进度条位的粉色标记，
// 悬停可见商品名与区间。标记盒子直接锚在 B 站进度条本体的实时几何上（控制器高频同步），
// 控制层淡出/收起时整层跟随隐藏——绝不悬在进度条已不在的位置。渲染仍在做标层（Shadow DOM）。
import { ui } from '../../../modules/content/ui-state'

function boxStyle(): Record<string, string> {
  const { left, top, width } = ui.marksBox
  return {
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
  }
}
</script>

<template>
  <div v-if="ui.marks.length > 0 && ui.marksBox.visible" class="bh-marks" :style="boxStyle()">
    <div
      v-for="mark in ui.marks"
      :key="mark.key"
      class="bh-mark"
      :class="{ done: mark.done }"
      :style="{
        left: `${mark.leftPct}%`,
        width: `${mark.widthPct}%`,
      }"
      role="button"
      tabindex="0"
      :aria-label="`广告标记：${mark.productName || '恰饭段'} ${mark.range}`"
    >
      <div class="bh-mark-tip">
        <span>{{ mark.productName ? `${mark.productName} · 恰饭段` : '恰饭段' }}</span>
        <span class="bh-mark-range">{{ mark.range }}<template v-if="mark.done"> · 已跳过</template></span>
      </div>
    </div>
  </div>
</template>
