import { defineConfig } from 'vitest/config'

// chrome.storage mock 经 tests/setup.ts 挂载（vitest setupFiles 惯例），而非在此内联——
// 单测运行在 Node 环境，浏览器扩展 API 需要显式注入。
export default defineConfig({
  test: {
    setupFiles: ['tests/setup.ts'],
  },
})