<script setup lang="ts">
// 进度条广告标记——回退形态（B 站改版导致原生注入不可用时才渲染，ui.nativeMarksActive=false）。
// 常规形态下广告底段长在原生进度条里（native-marks.ts），悬停提示走 BarHoverTip。
// 本组件沿用旧「标记盒几何镜像」渲染：盒子锚在进度条本体的实时几何上（控制器高频同步），
// 控制层淡出/收起时整层跟随隐藏。纯展示——点击语义已统一归原生进度条，标记不再截停指针。
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
  <div
    v-if="ui.marks.length > 0 && ui.marksBox.visible && !ui.nativeMarksActive"
    class="bh-marks"
    :style="boxStyle()"
  >
    <div
      v-for="mark in ui.marks"
      :key="mark.key"
      class="bh-mark"
      :class="{ done: mark.done }"
      :style="{
        left: `${mark.leftPct}%`,
        width: `${mark.widthPct}%`,
      }"
      :aria-label="`广告标记：${mark.productName || '恰饭段'} ${mark.range}`"
    >
      <div class="bh-mark-tip">
        <span>{{ mark.productName ? `${mark.productName} · 恰饭段` : '恰饭段' }}</span>
        <span class="bh-mark-range">{{ mark.range }}<template v-if="mark.done"> · 已跳过</template></span>
        <button
          type="button"
          class="bh-mark-reject"
          title="从本视频移除该段并记住：不再自动跳"
          @click.stop="ui.actions.onMarkNotAd(mark.key)"
        >
          不是广告
        </button>
      </div>
    </div>
  </div>
</template>
