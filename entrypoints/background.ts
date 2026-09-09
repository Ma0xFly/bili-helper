import { defineBackground } from 'wxt/utils/define-background'
import { browser } from 'wxt/browser'
import { isKnownMessage } from '../modules/content/protocol'
import { relayAdSkipMessage } from '../modules/content/relay'

// 最小 service worker：仅协调 popup ↔ 当前页内容脚本的「AI 去广告」快开关消息转发
// （转发逻辑在 content/relay，本文件只做浏览器依赖接线），不承载流式 AI 与采集
// （内容脚本直连端点），避免 MV3 service worker 生命周期干扰。
export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: unknown) => {
    if (!isKnownMessage(message)) return undefined
    return relayAdSkipMessage(message, {
      queryActiveTab: async () => {
        const [tab] = await browser.tabs
          .query({ active: true, currentWindow: true })
          .catch(() => [{ id: undefined }])
        return tab?.id
      },
      sendToTab: (tabId, payload) => browser.tabs.sendMessage(tabId, payload),
    })
  })
})