// 功能组内容脚本（第二阶段：过滤视频 / 布局优化 / 功能增强）。
// 与 AI 助手栈（entrypoints/content/index.ts，视频页专属）完全独立：这份脚本覆盖
// 首页与视频页两个注入面，跑 FeatureManager 按「注入面 + 开关」编排功能运行时；
// 功能运行时在各功能故事（Epic 2–4）里注册，注册表为空时管理器空转、页面零开销。
// SPA 首页 ⇄ 视频页的启停由管理器的导航节拍与配置订阅共同驱动。

import { defineContentScript } from 'wxt/utils/define-content-script'
import { FEATURE_STORAGE_KEY, readFeatureConfigs } from '../modules/features/config'
import { FeatureManager } from '../modules/features/manager'

export default defineContentScript({
  matches: [
    'https://www.bilibili.com/',
    'https://www.bilibili.com/index.html',
    'https://www.bilibili.com/video/*',
    'https://www.bilibili.com/list/*',
  ],
  async main() {
    const manager = new FeatureManager({
      readConfigs: readFeatureConfigs,
      getHref: () => window.location.href,
      setInterval: (handler, ms) => window.setInterval(handler, ms),
      clearInterval: (id) => window.clearInterval(id),
      subscribeConfigChanges: (listener) => {
        const onChange = (
          changes: Record<string, unknown>,
          area: string,
        ): void => {
          if (area === 'local' && FEATURE_STORAGE_KEY in changes) listener()
        }
        chrome.storage.onChanged.addListener(onChange)
        return () => chrome.storage.onChanged.removeListener(onChange)
      },
    })
    await manager.start()
  },
})
