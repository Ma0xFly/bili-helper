<script setup lang="ts">
// 浮层根组件：寄居 Shadow DOM，position:fixed 覆盖视口、指针事件只在交互件上开启。
// 视觉 token 全部来自 overlay.css（此处零裸 hex），亮暗由 ui.dark 驱动。
// AI 面板不在这里渲染：它有独立宿主，由接线层插进 B 站右栏文档流（见 index.ts）。
import { computed } from 'vue'
import SkipBanner from './SkipBanner.vue'
import SavedChip from './SavedChip.vue'
import VectorHint from './VectorHint.vue'
import ProgressMarks from './ProgressMarks.vue'
import { ui } from '../../../modules/content/ui-state'

const overlayStyle = computed(() => {
  const { visible, left, top, width, height } = ui.overlay
  return {
    display: visible && width > 0 && height > 0 ? 'block' : 'none',
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${height}px`,
  }
})
</script>

<template>
  <div class="bh-root bh-overlay-root" :data-dark="ui.dark ? '' : undefined">
    <div class="bh-overlay" :style="overlayStyle">
      <ProgressMarks />
      <SkipBanner />
      <SavedChip />
      <VectorHint />
    </div>
  </div>
</template>