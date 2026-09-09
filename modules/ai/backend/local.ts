// local 适配器：端上直连实现。summarize/chat 走 OpenAI 兼容直连客户端，
// detectAds 本阶段按裁决占位抛 config（RAG 混合检索在后续故事接入替换）。
// chat 遵循端口 SSE 终止性：emit start 之后的任何失败（含外部中止）都以 end{error} 收尾，
// 消费方永不悬挂。

import { AiError, errorInfoFrom } from '../../shared/error'
import type { AiSettings } from '../../settings'
import type {
  AiCapabilities,
  ChatInput,
  DetectAdsResult,
  SummarizeInput,
  SummarizeResult,
} from '../port'
import { buildChatMessages, buildSummaryMessages, parseSummarizeResponse } from '../prompts'
import { chatCompletion, chatCompletionStream, type ChatEndpoint } from '../llm/client'

export function createLocalBackend(settings: AiSettings): AiCapabilities {
  const endpoint: ChatEndpoint = {
    baseUrl: settings.apiUrl,
    model: settings.model,
    apiKey: settings.apiKey,
  }

  return {
    async detectAds(): Promise<DetectAdsResult> {
      // 占位：真实实现（RAG 混合检索 + 定界）在去广告故事接入。
      throw new AiError('config', '本地去广告将在下一阶段上线')
    },

    async summarize(input: SummarizeInput): Promise<SummarizeResult> {
      const { content } = await chatCompletion({
        endpoint,
        messages: buildSummaryMessages(input),
        signal: input.signal,
      })
      return parseSummarizeResponse(content)
    },

    async chat(input: ChatInput, handlers): Promise<void> {
      try {
        // start 也在 try 内：handler 抛错同样落入终止性收束，而不是拒绝后悬挂。
        handlers.onEvent({ type: 'start' })
        await chatCompletionStream({
          endpoint,
          messages: buildChatMessages(input),
          signal: input.signal,
          onChunk: (chunk) => handlers.onEvent({ type: 'message', chunk }),
        })
        handlers.onEvent({ type: 'end' })
      } catch (error) {
        // 终止性约定：流一旦开始，失败与中止（含 handler 自身抛错）都经 end{error} 收束。
        handlers.onEvent({ type: 'end', error: errorInfoFrom(error) })
      }
    },
  }
}