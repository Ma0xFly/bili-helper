// 设置页「测试连接」的数据来源：以最小补全/最小向量探测两端点，
// 返回 {ok} 或 {ok:false, reason}，reason 由 AiError kind 映射（覆盖 CORS 未放行/Key/地址三类去向提示）。
// 未配置时由直连客户端的 config 守卫拦截，reason 即「先去设置页配置端点」。

import { AiError } from '../shared/error'
import type { AiErrorKind } from '../shared/error'
import type { ApiFormat, ChatEndpoint } from './llm/client'
import { PROBE_TIMEOUT_MS, chatCompletion, embeddings, withDeadline } from './llm/client'

export interface EndpointTestParams {
  baseUrl: string
  model: string
  apiKey: string
  /** 对话协议：anthropic 走 /messages（向量探测不受影响，向量只有 OpenAI 形态）。 */
  format?: ApiFormat
  signal?: AbortSignal
}

/** 失败时的结构化详情（诊断日志用）：kind/文案/原始响应摘录。 */
export interface EndpointTestFailure {
  kind: AiErrorKind
  message: string
  rawResponse?: string
}

export type EndpointTestResult =
  | { ok: true; model: string; ms: number }
  | { ok: false; reason: string; failure?: EndpointTestFailure }

export async function testChatEndpoint(params: EndpointTestParams): Promise<EndpointTestResult> {
  // 探测用短死线：端点接受连接但不响应时不能悬挂配置台。
  const signal = withDeadline(params.signal, PROBE_TIMEOUT_MS)
  return runProbe(params, async (endpoint) => {
    const { content } = await chatCompletion({
      endpoint,
      messages: [{ role: 'user', content: '连接测试：请只回复「pong」二字，不要补充其他内容。' }],
      signal,
    })
    // 空回复同样不算连通：绿灯必须意味着端点真的答得出内容。
    if (content.trim() === '') throw new AiError('parse', '端点返回了空回复')
  })
}

export async function testEmbeddingEndpoint(params: EndpointTestParams): Promise<EndpointTestResult> {
  const signal = withDeadline(params.signal, PROBE_TIMEOUT_MS)
  return runProbe(params, async (endpoint) => {
    await embeddings({ endpoint, inputs: ['连接测试'], signal })
  })
}

async function runProbe(
  params: EndpointTestParams,
  probe: (endpoint: ChatEndpoint) => Promise<unknown>,
): Promise<EndpointTestResult> {
  const started = Date.now()
  try {
    await probe({
      baseUrl: params.baseUrl,
      model: params.model,
      apiKey: params.apiKey,
      format: params.format,
    })
    return { ok: true, model: params.model, ms: Date.now() - started }
  } catch (error) {
    return {
      ok: false,
      reason: describeTestFailure(error),
      ...(error instanceof AiError
        ? {
            failure: {
              kind: error.kind,
              message: error.message,
              ...(error.rawResponse === undefined ? {} : { rawResponse: error.rawResponse }),
            },
          }
        : {}),
    }
  }
}

// AiError 五类映射为设置页红灯原因摘要；网络类附带 CORS 排查提示（浏览器直连的首要排查项）。
export function describeTestFailure(error: unknown): string {
  if (!(error instanceof AiError)) {
    return error instanceof Error ? `未知错误：${error.message}` : '未知错误，请重试'
  }
  switch (error.kind) {
    case 'config':
      return error.message
    case 'auth':
      return `${error.status ?? '401'} 未授权：请检查 API Key 是否正确，向量端点请确认是否继承了对话 Key`
    case 'http':
      if (error.status === 404) {
        return '端点返回 404：地址带/不带 /v1 两种拼法都试过仍未命中，请核对地址与协议（OpenAI / Anthropic）'
      }
      if (error.message !== `端点返回了 ${error.status}`) {
        // 带上游原因（模型名/参数被拒的具体信息只在响应体里）。
        return error.message
      }
      return `端点返回 ${error.status ?? '错误'}：请检查端点地址是否正确；5xx 可稍后重试`
    case 'parse':
      if (error.message === '端点返回了空回复') return error.message
      return '响应格式不符合所选协议：请确认 API 协议选对（OpenAI / Anthropic）、地址确实是该类端点'
    case 'network':
      return error.message === '请求超时'
        ? '请求超时：端点未在限定时间内响应，请检查端点是否可用'
        : '请求没发出去：请检查网络与系统代理——浏览器流量可能经过本地代理（如 Clash），'
          + '需为该端点域名放行或配置直连规则；请求经扩展后台发起，不受页面跨域限制'
  }
}