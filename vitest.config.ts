import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

// chrome.storage mock 经 tests/setup.ts 挂载（vitest setupFiles 惯例），而非在此内联——
// 单测运行在 Node 环境，浏览器扩展 API 需要显式注入。
// vue 插件让 vitest 能编译 options/popup 的 .vue 组件测试（组件测试文件自声明 happy-dom 环境）。
export default defineConfig({
  plugins: [vue()],
  test: {
    setupFiles: ['tests/setup.ts'],
  },
})