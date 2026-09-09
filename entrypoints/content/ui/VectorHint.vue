<script setup lang="ts">
// 向量端点降级提示：报错式提示（不静默），同视频只出现一次；附跳转设置入口。
import { ui } from '../../../modules/content/ui-state'
</script>

<template>
  <div v-if="ui.vectorHint.visible" class="bh-vector-hint" role="alert">
    <span class="bh-vector-hint-text">向量端点（Embedding）的 API 有问题，暂时只用词表匹配</span>
    <button type="button" class="bh-btn-stay" @click="ui.actions.onOpenSettings()">去看看设置</button>
  </div>
</template>