// 服务端构建：必须走 vite 而不是 esbuild——词库用 import.meta.glob 在构建期内联 md，
// 这是 Vite 特性，esbuild 会原样留着导致运行时取不到词库。
// 产物是单文件 server/dist/server.mjs，零运行时依赖，`node server/dist/server.mjs` 即可跑。

import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }

export default defineConfig({
  define: { __SERVER_VERSION__: JSON.stringify(pkg.version) },
  build: {
    ssr: 'server/index.ts',
    outDir: 'server/dist',
    target: 'node20',
    // 服务端产物要能读、能改、能对着排错，不压缩。
    minify: false,
    emptyOutDir: true,
    rollupOptions: {
      output: { entryFileNames: 'server.mjs' },
    },
  },
})
