// local 适配器：端上直连实现。summarize/chat 走 OpenAI 兼容直连客户端，
// detectAds 走 RAG 混合检索链路（召回→小转大→LLM 定界，strategy 固定 smart，
// 降级链见模块注释）。chat 遵循端口 SSE 终止性：emit start 之后的任何失败（含外部中止）
// 都以 end{error} 收尾，消费方永不悬挂。

import { errorInfoFrom } from '../../shared/error'
import type { AiSettings } from '../../settings'
import type {
  AiCapabilities,
  ChatInput,
  DetectAdsInput,
  DetectAdsResult,
  SummarizeInput,
  SummarizeResult,
} from '../port'
import { buildChatMessages, buildSummaryMessages, parseSummarizeResponse } from '../prompts'
import { chatCompletion, chatCompletionStream, type ChatEndpoint } from '../llm/client'
import { runRagDetect, type DetectHooks } from '../rag/detect'

export function createLocalBackend(settings: AiSettings, hooks: DetectHooks = {}): AiCapabilities {
  const endpoint: ChatEndpoint = {
    baseUrl: settings.apiUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    format: settings.apiFormat,
  }

  return {
    async detectAds(input: DetectAdsInput): Promise<DetectAdsResult> {
      // strategy 本阶段固定 smart：无论调用方传什么，链路只走 smart 路径。
      return runRagDetect(input, settings, hooks)
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