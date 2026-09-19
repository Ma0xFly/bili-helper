<script setup lang="ts">
// 漏报标记进行中提示条（两拍流第二拍入口）：浮在播放器底部中央，
// 「结束并标记」以当前播放位置收终点并入广告段，「取消」放弃本次标记。
import { ui } from '../../../modules/content/ui-state'
</script>

<template>
  <div v-if="ui.marking.active" class="bh-marking-chip" role="status" aria-live="polite">
    <span class="bh-marking-text">
      正在标记广告段（从 {{ ui.marking.startText }} 起），播到广告结束时点一下
    </span>
    <button type="button" class="bh-btn-skip" @click="ui.actions.onFinishMarkAd()">结束并标记</button>
    <button type="button" class="bh-btn-stay" @click="ui.actions.onCancelMarkAd()">取消</button>
  </div>
</template>
