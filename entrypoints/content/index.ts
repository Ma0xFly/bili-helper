import 'uno.css'
import { defineContentScript } from 'wxt/utils/define-content-script'
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root'

// 一切注入 UI 寄居 Shadow DOM。cssInjectionMode:"ui" 是内容脚本级选项（非 defineConfig
// 顶层），让引入的 uno.css 经 createShadowRootUi 自动注入 shadow root。
export default defineContentScript({
  matches: ['https://www.bilibili.com/video/*'],
  cssInjectionMode: 'ui',
  async main(ctx) {
    try {
      const ui = await createShadowRootUi(ctx, {
        name: 'bili-helper-anchor',
        position: 'inline',
        anchor: 'body',
        append: 'last',
        onMount(_container, _shadow, shadowHost) {
          // 隐藏宿主：现阶段只挂一个不可见的锚点宿主，后续总结面板/去广告浮层在此之上生长。
          shadowHost.style.display = 'none'
          return shadowHost
        },
      })
      ui.mount()
    } catch {
      // 页面早导航等场景下宿主已不可用，挂载失败时静默放弃，不影响宿主页。
    }
  },
})