<script setup lang="ts">
// 向量端点降级提示：报错式提示（不静默），同视频只出现一次；附跳转设置入口。
import { ui } from '../../../modules/content/ui-state'
</script>

<template>
  <div v-if="ui.vectorHint.visible" class="bh-vector-hint" role="alert">
    <span class="bh-vector-hint-text">{{ ui.vectorHint.text }}</span>
    <button type="button" class="bh-btn-stay" @click="ui.actions.onOpenSettings()">去看看设置</button>
  </div>
</template>