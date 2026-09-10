import { defineBackground } from 'wxt/utils/define-background'
import { browser } from 'wxt/browser'
import { routeMessage } from '../modules/content/relay'
import type { RelayDeps } from '../modules/content/relay'

// 最小 service worker：仅协调 popup ↔ 当前页内容脚本的快开关消息转发
// （「AI 去广告」与「总结面板」两条通路，分派在 content/relay.routeMessage，
// 本文件只做浏览器依赖接线），不承载流式 AI 与采集（内容脚本直连端点），
// 避免 MV3 service worker 生命周期干扰。
export default defineBackground(() => {
  const deps: RelayDeps = {
    queryActiveTab: async () => {
      const [tab] = await browser.tabs
        .query({ active: true, currentWindow: true })
        .catch(() => [{ id: undefined }])
      return tab?.id
    },
    sendToTab: (tabId, payload) => browser.tabs.sendMessage(tabId, payload),
  }

  browser.runtime.onMessage.addListener((message: unknown) => routeMessage(message, deps))
})