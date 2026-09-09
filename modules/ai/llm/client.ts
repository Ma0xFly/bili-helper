// OpenAI 兼容直连客户端：直连层的唯一网络出口，流量只发往 settings 指定的 baseUrl/model/key。
// 统一 fetch + 错误映射：fetch 抛错→network、401/403→auth、其余非 2xx→http（带 status）、
// 坏 JSON/形状不符→parse、未配置→config。凭据只进 Authorization 头，不落日志。

import { AiError } from '../../shared/error'

export interface OpenAiChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatEndpoint {
  baseUrl: string
  model: string
  apiKey: string
}

export interface ChatCompletionParams {
  endpoint: ChatEndpoint
  messages: OpenAiChatMessage[]
  signal?: AbortSignal
}

export interface ChatCompletionResult {
  content: string
}

export interface ChatCompletionStreamParams extends ChatCompletionParams {
  onChunk: (chunk: string) => void
}

export interface EmbeddingsParams {
  endpoint: ChatEndpoint
  inputs: string[]
  signal?: AbortSignal
}

export interface ListModelsParams {
  baseUrl: string
  apiKey: string
  signal?: AbortSignal
}

const CONFIG_HINT = '先去设置页配置端点'

/** 探测类请求（测试连接/拉取模型）的默认超时：配置台交互不能无限悬挂。 */
export const PROBE_TIMEOUT_MS = 15_000
/** 生成类请求（补全/向量）的默认超时：给足生成时间，但端点静默时必须有界。 */
const REQUEST_TIMEOUT_MS = 120_000

// 与调用方 signal 组合的死线 signal（流式请求不加死线，由消费方 abort）。
export function withDeadline(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, deadline]) : deadline
}

export function joinApiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function requireBaseUrl(baseUrl: string): void {
  if (!baseUrl.trim()) throw new AiError('config', CONFIG_HINT)
}

function requireModel(model: string): void {
  if (!model.trim()) throw new AiError('config', '还没配置模型名称，先去设置页填写')
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

export function mapNetworkError(cause: unknown): AiError {
  if (cause instanceof Error && cause.name === 'TimeoutError') {
    return new AiError('network', '请求超时', { cause })
  }
  if (isAbortError(cause)) return new AiError('network', '请求已中止', { cause })
  return new AiError('network', '请求发不出去，请检查端点地址与网络', { cause })
}

export function mapResponseError(response: Response): AiError {
  const kind = response.status === 401 || response.status === 403 ? 'auth' : 'http'
  return new AiError(kind, `端点返回了 ${response.status}`, { status: response.status })
}

export function mapJsonFailure(cause: unknown): AiError {
  return new AiError('parse', '响应不是合法 JSON，请确认端点是否 OpenAI 兼容', { cause })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function authHeaders(apiKey: string, withContentType = true): Record<string, string> {
  const headers: Record<string, string> = {}
  if (withContentType) headers['Content-Type'] = 'application/json'
  const key = apiKey.trim()
  if (key) headers.Authorization = `Bearer ${key}`
  return headers
}

async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (cause) {
    throw mapNetworkError(cause)
  }
  if (!response.ok) throw mapResponseError(response)
  try {
    return await response.json()
  } catch (cause) {
    throw mapJsonFailure(cause)
  }
}

export async function chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult> {
  requireBaseUrl(params.endpoint.baseUrl)
  requireModel(params.endpoint.model)
  const data = await requestJson(joinApiUrl(params.endpoint.baseUrl, 'chat/completions'), {
    method: 'POST',
    headers: authHeaders(params.endpoint.apiKey),
    body: JSON.stringify({ model: params.endpoint.model, messages: params.messages }),
    signal: withDeadline(params.signal, REQUEST_TIMEOUT_MS),
  })
  const root = isRecord(data) ? data : undefined
  const choices = root && Array.isArray(root.choices) ? root.choices : undefined
  const message = choices && choices.length > 0 && isRecord(choices[0]) ? choices[0].message : undefined
  const content = isRecord(message) ? message.content : undefined
  if (typeof content !== 'string') {
    throw new AiError('parse', '补全响应缺少 choices[0].message.content，请确认端点是否 OpenAI 兼容')
  }
  return { content }
}

const STREAM_DONE = Symbol('stream-done')

type SseLineResult = string | typeof STREAM_DONE | null

// 解析一行 SSE data：返回增量文本；非 data 行/脏 JSON/无增量时返回 null；[DONE] 返回终止标记；
// 事件携带 error 对象（OpenAI 流内错误约定）时抛 http，由上层以 end{error} 收束。
function parseSseLine(line: string): SseLineResult {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  const payload = trimmed.slice('data:'.length).trim()
  if (payload === '[DONE]') return STREAM_DONE
  let event: unknown
  try {
    event = JSON.parse(payload)
  } catch {
    return null
  }
  if (!isRecord(event)) return null
  if (event.error) {
    const message =
      isRecord(event.error) && typeof event.error.message === 'string'
        ? event.error.message
        : '流式响应返回错误'
    throw new AiError('http', message)
  }
  const choices = Array.isArray(event.choices) ? event.choices[0] : undefined
  const delta = isRecord(choices) ? choices.delta : undefined
  const chunk = isRecord(delta) ? delta.content : undefined
  return typeof chunk === 'string' && chunk !== '' ? chunk : null
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  try {
    return await reader.read()
  } catch (cause) {
    if (isAbortError(cause) || signal?.aborted) throw new AiError('network', '请求已中止', { cause })
    throw new AiError('network', '流式响应在传输中中断', { cause })
  }
}

export async function chatCompletionStream(
  params: ChatCompletionStreamParams,
): Promise<ChatCompletionResult> {
  requireBaseUrl(params.endpoint.baseUrl)
  requireModel(params.endpoint.model)
  let response: Response
  try {
    response = await fetch(joinApiUrl(params.endpoint.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: authHeaders(params.endpoint.apiKey),
      body: JSON.stringify({ model: params.endpoint.model, messages: params.messages, stream: true }),
      signal: params.signal,
    })
  } catch (cause) {
    throw mapNetworkError(cause)
  }
  if (!response.ok) throw mapResponseError(response)
  // 200 也可能是代理/网关的 HTML 错误页：按解析失败处理，而不是把空流当成功。
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  if (contentType.includes('text/html')) {
    throw new AiError('parse', '端点返回了 HTML 页面而不是流式响应，请确认端点地址是否正确')
  }
  const body = response.body
  if (!body) throw new AiError('parse', '端点没有返回流式响应体，请确认是否支持流式输出')
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let content = ''
  try {
    while (true) {
      const { done, value } = await readStreamChunk(reader, params.signal)
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // 按行切分（SSE data 事件单行），跨 TCP 分片由 buffer 组装；残行留到下一轮。
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const delta = parseSseLine(line)
        if (delta === STREAM_DONE) return { content }
        if (delta === null) continue
        content += delta
        params.onChunk(delta)
      }
    }
    // 收尾兜底：部分实现省略 [DONE] 直接关流（按正常收束）；末行无换行时补解析一次。
    if (buffer.trim() !== '') {
      const delta = parseSseLine(buffer)
      if (delta === STREAM_DONE) return { content }
      if (delta !== null) {
        content += delta
        params.onChunk(delta)
      }
    }
    // 某些实现对已中止的流以 done 代替 reject，此处补检信号，消费方不悬挂。
    if (params.signal?.aborted) throw new AiError('network', '请求已中止')
    return { content }
  } finally {
    reader.cancel().catch(() => {
      // 连接已断开或已读完时 cancel 会失败，忽略即可。
    })
  }
}

export async function embeddings(params: EmbeddingsParams): Promise<number[][]> {
  requireBaseUrl(params.endpoint.baseUrl)
  requireModel(params.endpoint.model)
  const data = await requestJson(joinApiUrl(params.endpoint.baseUrl, 'embeddings'), {
    method: 'POST',
    headers: authHeaders(params.endpoint.apiKey),
    body: JSON.stringify({ model: params.endpoint.model, input: params.inputs }),
    signal: withDeadline(params.signal, REQUEST_TIMEOUT_MS),
  })
  const root = isRecord(data) ? data : undefined
  const list = root && Array.isArray(root.data) ? root.data : undefined
  if (!list || list.length !== params.inputs.length) {
    throw new AiError('parse', '向量响应与输入数量不一致，请确认端点是否 OpenAI 兼容')
  }
  // OpenAI 约定按 index 对齐输入顺序，服务端乱序也恢复原序。
  const sorted = [...list].sort((a, b) => indexOfVector(a) - indexOfVector(b))
  return sorted.map((item) => {
    const vector = isRecord(item) ? item.embedding : undefined
    if (!Array.isArray(vector) || vector.some((x) => typeof x !== 'number')) {
      throw new AiError('parse', '向量响应形状不符合 OpenAI 约定')
    }
    return vector as number[]
  })
}

function indexOfVector(item: unknown): number {
  const index = isRecord(item) ? item.index : undefined
  return typeof index === 'number' ? index : 0
}

export async function listModels(params: ListModelsParams): Promise<string[]> {
  requireBaseUrl(params.baseUrl)
  const data = await requestJson(joinApiUrl(params.baseUrl, 'models'), {
    method: 'GET',
    headers: authHeaders(params.apiKey, false),
    signal: withDeadline(params.signal, PROBE_TIMEOUT_MS),
  })
  const root = isRecord(data) ? data : undefined
  const list = root && Array.isArray(root.data) ? root.data : undefined
  if (!list) throw new AiError('parse', '模型列表响应缺少 data 数组，请确认端点是否支持 /models')
  const ids: string[] = []
  for (const item of list) {
    if (!isRecord(item) || typeof item.id !== 'string') {
      throw new AiError('parse', '模型列表响应形状不符合 OpenAI 约定')
    }
    // 去重保序：datalist 的 option 以 id 为 key，重复会触发 Vue 重复 key 告警。
    if (!ids.includes(item.id)) ids.push(item.id)
  }
  return ids
}