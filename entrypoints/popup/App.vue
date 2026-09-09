<script setup lang="ts">
import { browser } from 'wxt/browser'

// 打开设置页；openOptionsPage 返回 Promise，await + .catch 处理拒绝（例如设置页不可打开时）。
async function openOptions() {
  await browser.runtime.openOptionsPage().catch(() => {
    // 骨架期无反馈 UI，失败静默。
  })
}
</script>

<template>
  <div class="popup-shell">
    <div class="popup-row">
      <span>总开关</span>
      <!-- 占位：开关接线后续实现。 -->
      <span class="placeholder">待接线</span>
    </div>
    <button type="button" class="open-options" @click="openOptions">打开设置页</button>
  </div>
</template>

<style scoped>
.popup-shell {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 220px;
  padding: 16px;
  font-family: system-ui, sans-serif;
}

.popup-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.placeholder {
  font-size: 12px;
  color: #6f6a80;
}

.open-options {
  padding: 8px 12px;
  border: none;
  border-radius: 9999px;
  background: #7c5cfc;
  color: #fff;
  cursor: pointer;
  font-size: 13px;
}

.open-options:hover {
  background: #7452f4;
}
</style>