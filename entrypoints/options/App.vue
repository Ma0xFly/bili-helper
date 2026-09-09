<script setup lang="ts">
import { ref } from 'vue'

// 骨架期：只搭设置页的侧边栏分组导航结构与内容区占位，端点表单留待后续实现。
const groups = ['AI 助手', '服务器', '过滤', '净化', '布局', '增强']
const active = ref<string>(groups[0] ?? 'AI 助手')
</script>

<template>
  <div class="options-shell">
    <nav class="sidebar" aria-label="设置分组">
      <span class="sidebar-title">设置</span>
      <button
        v-for="group in groups"
        :key="group"
        type="button"
        class="sidebar-item"
        :class="{ active: group === active }"
        :aria-current="group === active ? 'page' : undefined"
        @click="active = group"
      >
        {{ group }}
      </button>
    </nav>
    <main class="content">
      <h1>{{ active }}</h1>
      <p>端点配置表单将在后续实现。</p>
    </main>
  </div>
</template>

<style scoped>
.options-shell {
  display: flex;
  min-height: 100vh;
  font-family: system-ui, sans-serif;
}

.sidebar {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 200px;
  padding: 16px;
}

.sidebar-title {
  font-weight: 700;
  padding: 4px 8px 12px;
  color: #2e2a3b;
}

.sidebar-item {
  text-align: left;
  padding: 8px 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  font-size: 14px;
  color: #6f6a80;
}

.sidebar-item:hover {
  background: #f1edff;
}

.sidebar-item.active {
  background: #f1edff;
  color: #7c5cfc;
  font-weight: 600;
}

.content {
  flex: 1;
  padding: 32px;
}

.content h1 {
  margin: 0 0 8px;
  font-size: 20px;
}

.content p {
  color: #6f6a80;
}
</style>