<script setup lang="ts">
// 广告提示条 + 倒计时环（skip-banner / countdown-ring）+ 双按钮。
// 铁律：倒计时归零不点任何按钮也自动跳过——「这段想看」只是弱化反悔出口。
import { computed } from 'vue'
import { ui } from '../../../modules/content/ui-state'

const RING_RADIUS = 11.5
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/** 环进度按剩余秒数 / 3 换算描边长度。 */
const ringDash = computed(() => {
  const progress = Math.min(1, Math.max(0, ui.banner.progress))
  const filled = RING_CIRCUMFERENCE * progress
  return `${filled} ${RING_CIRCUMFERENCE}`
})

const countdownText = computed(() =>
  ui.banner.countdown === null ? '' : String(Math.max(0, Math.ceil(ui.banner.countdown - 1e-9))),
)
</script>

<template>
  <div
    v-if="ui.banner.visible"
    class="bh-banner"
    role="status"
    aria-live="polite"
    :aria-label="`${ui.banner.copy}`"
  >
    <span class="bh-ring-wrap" aria-hidden="true">
      <svg width="28" height="28" viewBox="0 0 28 28">
        <defs>
          <linearGradient id="bh-ring-gradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" class="bh-ring-stop-a" />
            <stop offset="1" class="bh-ring-stop-b" />
          </linearGradient>
        </defs>
        <circle cx="14" cy="14" :r="RING_RADIUS" fill="none" class="bh-ring-track" stroke-width="3" />
        <circle
          cx="14"
          cy="14"
          :r="RING_RADIUS"
          fill="none"
          class="bh-ring-fill"
          stroke-width="3"
          stroke-linecap="round"
          :stroke-dasharray="ringDash"
          transform="rotate(-90 14 14)"
        />
      </svg>
      <span class="bh-ring-num">{{ countdownText }}</span>
    </span>
    <span class="bh-banner-text">
      <span class="bh-banner-copy">{{ ui.banner.copy }}</span>
      <span class="bh-banner-sub">{{ ui.banner.sub }}</span>
    </span>
    <button type="button" class="bh-btn-skip" @click="ui.actions.onSkipNow()">马上跳</button>
    <button type="button" class="bh-btn-stay" @click="ui.actions.onStay()">这段想看</button>
  </div>
</template>