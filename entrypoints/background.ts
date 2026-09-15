import { defineBackground } from 'wxt/utils/define-background'
import { browser } from 'wxt/browser'
import { routeMessage } from '../modules/content/relay'
import type { RelayDeps } from '../modules/content/relay'
import { NET_RELAY_PORT_NAME, attachNetRelay } from '../modules/ai/llm/net-relay'
import type { RelayPort } from '../modules/ai/llm/net-relay'

// 最小 service worker：两个职责——
// 1. 协调 popup ↔ 当前页内容脚本的快开关消息转发（「AI 去广告」与「总结面板」
//    两条通路，分派在 content/relay.routeMessage，本文件只做浏览器依赖接线）；
// 2. 内容脚本的 AI 直连代取（net-relay 端口）：内容脚本受页面 CORS 约束，这里的
//    fetch 拿着 host_permissions 不受限。流式转发持续产生端口消息（外加客户端
//    20 秒一拍的保活心跳），MV3 闲置计时不会中途熄火掐断长流。
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

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== NET_RELAY_PORT_NAME) return
    attachNetRelay(port as unknown as RelayPort)
  })
})