<script setup lang="ts">
// 成就 chip：跳过成功后的瞬时态，短暂展示今日累计节省时长。
import { ui } from '../../../modules/content/ui-state'
</script>

<template>
  <div v-if="ui.chip.visible" class="bh-saved-chip" role="status" aria-live="polite">
    <span class="bh-orb" aria-hidden="true" />
    {{ ui.chip.text }}
  </div>
</template>