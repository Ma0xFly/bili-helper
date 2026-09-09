// 后端分派唯一入口：settings.mode ∈ {local, server, auto} 是后端选择的唯一事实来源。
// auto = 先 server、失败回退 local（chat 只在流开始前回退——server 流开始后失败已由
// end{error} 收束，回退会造成事件流混合）。调用方只拿 AiCapabilities，永不感知后端。

import type { AiSettings } from '../../settings'
import type { AiCapabilities, AiChatEvent, ChatHandlers } from '../port'
import type { DetectHooks } from '../rag/detect'
import { createLocalBackend } from './local'
import { createServerBackend } from './server'

/** resolveBackend 可注入的本地链路钩子：向量降级提示等内容脚本听的回调经此透传。 */
export type BackendHooks = DetectHooks

export function resolveBackend(settings: AiSettings, hooks: BackendHooks = {}): AiCapabilities {
  switch (settings.mode) {
    case 'server':
      return createServerBackend(settings)
    case 'auto':
      return createAutoBackend(settings, hooks)
    case 'local':
    default:
      return createLocalBackend(settings, hooks)
  }
}

function createAutoBackend(settings: AiSettings, hooks: BackendHooks): AiCapabilities {
  const server = createServerBackend(settings)
  const local = createLocalBackend(settings, hooks)
  return {
    detectAds: (input) =>
      preferServer(() => server.detectAds(input), () => local.detectAds(input), input.signal),
    summarize: (input) =>
      preferServer(() => server.summarize(input), () => local.summarize(input), input.signal),
    chat: async (input, handlers) => {
      let emitted = 0
      const counting: ChatHandlers = {
        onEvent: (event: AiChatEvent) => {
          emitted += 1
          handlers.onEvent(event)
        },
      }
      try {
        await server.chat(input, counting)
      } catch (error) {
        // 用户中止不是「server 失败」，原样上抛；server 已发过任何事件说明流已开始，
        // 回退会产生第二条事件流，同样上抛。只有流开始前的失败才退 local。
        if (input.signal?.aborted || emitted > 0) throw error
        await local.chat(input, handlers)
      }
    },
  }
}

async function preferServer<T>(
  serverCall: () => Promise<T>,
  localCall: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await serverCall()
  } catch (error) {
    // 用户中止原样上抛：拿已中止信号对 local 做二次请求只会再失败一次。
    if (signal?.aborted) throw error
    // server 失败只吞掉并退 local；local 再失败则上抛其 AiError。
    return await localCall()
  }
}