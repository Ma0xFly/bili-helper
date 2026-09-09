import { defineConfig } from 'wxt'
import UnoCSS from 'unocss/vite'

// manifest 一律经此声明（不手写 rollup/vite 裸配置）；storage 与任意 http(s) 端点权限据此落地。
export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  manifest: {
    name: 'B站增强助手',
    permissions: ['storage'],
    host_permissions: ['http://*/*', 'https://*/*'],
  },
  vite: () => ({
    plugins: [UnoCSS()],
  }),
})