<script setup lang="ts">
// 进度条广告标记（progressBarAdMark）：detectAds 结果区间在播放器进度条位的粉色标记，
// 悬停可见商品名与区间；标记渲染在做标层（Shadow DOM），不触碰 B 站进度条本体。
import { ui } from '../../../modules/content/ui-state'
</script>

<template>
  <div v-if="ui.marks.length > 0" class="bh-marks">
    <div
      v-for="mark in ui.marks"
      :key="mark.key"
      class="bh-mark"
      :class="{ done: mark.done }"
      :style="{
        left: `${mark.leftPct}%`,
        width: `${mark.widthPct}%`,
        top: `${mark.topPct}%`,
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