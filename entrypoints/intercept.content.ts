// 主世界内容脚本（Epic1-S1.3）：patch fetch 与 XHR，承接隔离侧广播的功能配置重建拦截规则。
// 关键约束：主世界没有 chrome.* API——配置只能经 postMessage 进来（见 protocol.ts）；
// 拦截器实现必须编进本包（函数过不了结构化克隆），功能故事（Epic 2/4）在 registrations
// 里登记自己的工厂。注册表为空时零拦截、零开销。
// runAt document_start：必须抢在页面脚本发请求之前完成 patch。

import { defineContentScript } from 'wxt/utils/define-content-script'
import { onInterceptConfigs } from '../modules/features/intercept/protocol'
import {
  InterceptRuntime,
  buildInterceptors,
  type InterceptorFactoryRegistration,
} from '../modules/features/intercept/runtime'
import { installFetchPatch, installXhrPatch } from '../modules/features/intercept/install'
import { videoFilterInterceptorRegistration } from '../modules/features/filter/feed-interceptor'

export default defineContentScript({
  matches: [
    'https://www.bilibili.com/',
    'https://www.bilibili.com/index.html',
    'https://www.bilibili.com/video/*',
    'https://www.bilibili.com/list/*',
  ],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    const runtime = new InterceptRuntime()
    installFetchPatch(runtime, window)
    installXhrPatch(runtime, window.XMLHttpRequest, window)

    // 功能拦截器注册表（Epic 2/4 填充）：视频筛选（首页推荐流，observe-only + 卡片隐藏）。
    const registrations: InterceptorFactoryRegistration[] = [videoFilterInterceptorRegistration]

    onInterceptConfigs(window, (configs) => {
      try {
        runtime.setInterceptors(buildInterceptors(registrations, configs))
      } catch (error) {
        // 构建失败 = 全注销（不留半启用状态），页面请求照常，错误可读。
        console.error(
          '[bili-helper:intercept] 构建拦截规则失败，已注销全部拦截器:',
          String(error),
        )
        runtime.setInterceptors([])
      }
    })
  },
})
