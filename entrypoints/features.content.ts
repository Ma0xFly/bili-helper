// 功能组内容脚本（第二阶段：过滤视频 / 布局优化 / 功能增强）。
// 与 AI 助手栈（entrypoints/content/index.ts，视频页专属）完全独立：这份脚本覆盖
// 首页与视频页两个注入面，跑 FeatureManager 按「注入面 + 开关」编排功能运行时；
// 功能运行时在各功能故事（Epic 2–4）里注册，注册表为空时管理器空转、页面零开销。
// SPA 首页 ⇄ 视频页的启停由管理器的导航节拍与配置订阅共同驱动。

import { defineContentScript } from 'wxt/utils/define-content-script'
import { FEATURE_IDS, FEATURE_STORAGE_KEY, readFeatureConfigs } from '../modules/features/config'
import type { FeatureConfigMap } from '../modules/features/config'
import { FeatureManager } from '../modules/features/manager'
import { pushInterceptConfigs } from '../modules/features/intercept/protocol'
import type { SerializedFeatureConfigs } from '../modules/features/intercept/protocol'
import { createAdVideoBlocker } from '../modules/features/blockers/ad-video'
import { createPromotedVideoBlocker } from '../modules/features/blockers/promoted-video'
import { createLabelVideoBlocker } from '../modules/features/blockers/label-video'

/** FeatureConfigMap → 主世界线协议（纯 JSON；函数过不了 postMessage）。 */
function toInterceptPayload(map: FeatureConfigMap): SerializedFeatureConfigs {
  const payload: SerializedFeatureConfigs = {}
  for (const id of FEATURE_IDS) {
    payload[id] = { enabled: map[id].enabled, config: map[id].config as Record<string, unknown> }
  }
  return payload
}

export default defineContentScript({
  matches: [
    'https://www.bilibili.com/',
    'https://www.bilibili.com/index.html',
    'https://www.bilibili.com/video/*',
    'https://www.bilibili.com/list/*',
  ],
  async main() {
    // 主世界拦截器需要配置（videoFilter 的规则、换一换的开关…），但主世界没有 chrome API：
    // 启动时广播一次，此后每次 storage 变化再广播（主世界收到即重建拦截规则）。
    const broadcastConfigs = async (): Promise<void> => {
      try {
        pushInterceptConfigs(window, toInterceptPayload(await readFeatureConfigs()))
      } catch {
        // 广播失败保持主世界现状，下一次变化再试。
      }
    }
    const onStorageChanged = (
      changes: Record<string, unknown>,
      area: string,
    ): void => {
      if (area === 'local' && FEATURE_STORAGE_KEY in changes) void broadcastConfigs()
    }
    chrome.storage.onChanged.addListener(onStorageChanged)

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
    // 功能运行时注册（Epic 2–4 逐个登记）：广告视频 / 推广视频（首页，DOM 移除 + 日统计）、
    // 标签视频（首页，纯 CSS 隐藏）。
    manager.register('adVideoBlocker', () => createAdVideoBlocker())
    manager.register('promotedVideoBlocker', () => createPromotedVideoBlocker())
    manager.register('labelVideoBlocker', () => createLabelVideoBlocker())

    await manager.start()
    await broadcastConfigs()
  },
})
