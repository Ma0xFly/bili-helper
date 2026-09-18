// local 适配器：端上直连实现。summarize/chat 走 OpenAI 兼容直连客户端，
// detectAds 走 RAG 混合检索链路（召回→小转大→LLM 定界，strategy 固定 smart，
// 降级链见模块注释）。chat 遵循端口 SSE 终止性：emit start 之后的任何失败（含外部中止）
// 都以 end{error} 收尾，消费方永不悬挂。

import { errorInfoFrom, AiError } from '../../shared/error'
import type { AiSettings } from '../../settings'
import { resolveDetectEndpoint } from '../../settings'
import type {
  AiCapabilities,
  ChatInput,
  DetectAdsInput,
  DetectAdsResult,
  SummarizeInput,
  SummarizeResult,
} from '../port'
import { buildChatMessages, buildSummaryMessages, parseSummarizeResponse } from '../prompts'
import { chatCompletionStream, type ChatEndpoint } from '../llm/client'
import { runRagDetect, type DetectHooks } from '../rag/detect'
import { recordAiFailure, type AiFailureFeature } from '../diagnostics-log'

/** 总结的流式死线：流式靠持续分块保活，不再受非流式 120 秒限制，但仍要有界。 */
const SUMMARIZE_STREAM_TIMEOUT_MS = 300_000

export function createLocalBackend(settings: AiSettings, hooks: DetectHooks = {}): AiCapabilities {
  const endpoint: ChatEndpoint = {
    baseUrl: settings.apiUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    format: settings.apiFormat,
  }

  /**
   * 失败落诊断日志（设置页「诊断记录」卡消费）：kind/文案/原始响应摘录，
   * 只记元信息与模型自己的回答文本，凭据永远不经过这里。记录失败静默。
   */
  function logFailure(
    feature: AiFailureFeature,
    error: unknown,
    origin: ChatEndpoint = endpoint,
  ): void {
    // 任何抛出物都入档（非 AiError 经 errorInfoFrom 归一）：排障时「没日志」比「日志多」更致命。
    const info = errorInfoFrom(error)
    const raw = error instanceof AiError ? error.rawResponse : undefined
    const detail = error instanceof Error ? ` [${error.name}] ${error.stack?.split('\n')[1]?.trim() ?? ''}` : ''
    console.error(`[bili-helper] ${feature} 失败:`, info.kind, info.message + detail)
    void recordAiFailure({
      time: Date.now(),
      feature,
      kind: info.kind,
      message: info.message + detail,
      ...(raw === undefined ? {} : { rawExcerpt: raw }),
      ...(origin.baseUrl === '' ? {} : { endpoint: origin.baseUrl }),
      ...(origin.model === '' ? {} : { model: origin.model }),
    })
  }

  // 去广告定界走专用端点（默认继承对话端点）：失败记录要标真实使用的端点/模型。
  const detectResolved = resolveDetectEndpoint(settings)
  const detectEndpoint: ChatEndpoint = {
    baseUrl: detectResolved.baseUrl,
    model: detectResolved.model,
    apiKey: detectResolved.apiKey,
    format: detectResolved.format,
  }

  return {
    async detectAds(input: DetectAdsInput): Promise<DetectAdsResult> {
      // strategy 本阶段固定 smart：无论调用方传什么，链路只走 smart 路径。
      try {
        return await runRagDetect(input, settings, hooks)
      } catch (error) {
        logFailure('去广告', error, detectEndpoint)
        throw error
      }
    },

    async summarize(input: SummarizeInput): Promise<SummarizeResult> {
      try {
        // 走流式而非一次性补全：长回复的非流式连接会被部分网关中途掐断
        // （症状一半截体 → parse 错、连接直切 → network 错）；流式有持续分块，
        // Claude Code 类网关（方舟 Coding 等）按流式设计，不会掐。
        // 面板暂不消费增量（onChunk 留空），只在收尾解析全文。
        const deadline = AbortSignal.timeout(SUMMARIZE_STREAM_TIMEOUT_MS)
        const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline
        const { content } = await chatCompletionStream({
          endpoint,
          messages: buildSummaryMessages(input),
          signal,
          onChunk: () => {},
        })
        // 200 但流里解析不出任何内容（错误页/非流式体）：不算成功，别拿空总结糊弄面板。
        if (content.trim() === '') {
          throw new AiError('parse', '端点返回了空回复（可能回了错误页或非流式内容）')
        }
        return parseSummarizeResponse(content)
      } catch (error) {
        logFailure('总结', error)
        throw error
      }
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
        logFailure('提问', error)
        handlers.onEvent({ type: 'end', error: errorInfoFrom(error) })
      }
    },
  }
}