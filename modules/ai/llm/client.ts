// 直连客户端：直连层的唯一网络出口，流量只发往 settings 指定的 baseUrl/model/key。
// 支持两种 API 协议（settings.apiFormat）：OpenAI 兼容（chat/completions）与
// Anthropic Messages（messages，x-api-key 头 + system 顶层字段 + max_tokens 必填）。
// 统一 fetch + 错误映射：fetch 抛错→network、401/403→auth、其余非 2xx→http（带 status）、
// 坏 JSON/形状不符→parse、未配置→config。凭据只进鉴权头，不落日志。

import { AiError } from '../../shared/error'
import { netRelayEnabled, netRelayFetch } from './net-relay'

export interface OpenAiChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 对话协议模式：OpenAI 兼容 / Anthropic Messages（向量接口只有 OpenAI 形态）。 */
export type ApiFormat = 'openai' | 'anthropic'

export interface ChatEndpoint {
  baseUrl: string
  model: string
  apiKey: string
  /** 省略即 openai（向后兼容旧调用点）。 */
  format?: ApiFormat
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
  return statusError(response.status)
}

/** 非 2xx 的统一映射：401/403 → auth，其余 → http（带 status）。 */
export function statusError(status: number): AiError {
  const kind = status === 401 || status === 403 ? 'auth' : 'http'
  return new AiError(kind, `端点返回了 ${status}`, { status })
}

export function mapJsonFailure(cause: unknown): AiError {
  return new AiError('parse', '响应不是合法 JSON，请确认端点是否 OpenAI 兼容', { cause })
}

/** 统一的响应形状：直连取自 fetch Response；中继路径为端口桥接流（body/text 语义一致）。 */
interface HttpResponseLike {
  ok: boolean
  status: number
  contentType: string
  body: ReadableStream<Uint8Array> | undefined
  text(): Promise<string>
}

interface PerformFetchInit {
  method: string
  headers: Record<string, string>
  body?: string
}

/**
 * 直连层的唯一网络出口：内容脚本里装配了中继（setNetRelayConnect）就走后台代取
 * （后台带 host_permissions，不受页面 CORS 约束）；扩展页/后台/测试里未装配则直接
 * fetch（这些上下文本就豁免 CORS）。timeoutMs：直连路径折进 fetch 死线 signal，
 * 中继路径由宿主侧死线兜底；省略即不限时（流式请求，由消费方 abort）。
 */
async function performFetch(
  url: string,
  init: PerformFetchInit,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<HttpResponseLike> {
  if (netRelayEnabled()) {
    const result = await netRelayFetch(
      {
        url,
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      },
      opts.signal,
    )
    return {
      ok: result.ok,
      status: result.status,
      contentType: result.contentType,
      body: result.body,
      text: () => streamToText(result.body),
    }
  }
  let response: Response
  try {
    response = await fetch(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: opts.timeoutMs === undefined ? opts.signal : withDeadline(opts.signal, opts.timeoutMs),
    })
  } catch (cause) {
    throw mapNetworkError(cause)
  }
  return {
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    body: response.body ?? undefined,
    text: () => response.text(),
  }
}

async function streamToText(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
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

const ANTHROPIC_VERSION = '2023-06-01'
/** Anthropic Messages 的 max_tokens 必填：给足总结/定界/问答的输出预算，又不越过旧模型上限。 */
const ANTHROPIC_MAX_TOKENS = 4096

function isAnthropic(endpoint: ChatEndpoint): boolean {
  return endpoint.format === 'anthropic'
}

/** Anthropic 鉴权头：x-api-key + 固定版本号（不用 Authorization: Bearer）。 */
function anthropicHeaders(apiKey: string, withContentType = true): Record<string, string> {
  const headers: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION }
  if (withContentType) headers['Content-Type'] = 'application/json'
  const key = apiKey.trim()
  if (key) headers['x-api-key'] = key
  return headers
}

/** Anthropic 的 Bearer 形态：Claude Code 类网关（如火山方舟 Coding）只认 ANTHROPIC_AUTH_TOKEN 的 Bearer。 */
function anthropicBearerHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION, 'Content-Type': 'application/json' }
  const key = apiKey.trim()
  if (key) headers.Authorization = `Bearer ${key}`
  return headers
}

/**
 * OpenAI 消息 → Anthropic Messages 体：system 角色提到顶层 system 字段（Anthropic 不收 system 消息），
 * user/assistant 轮次原样搬移；max_tokens 是必填项。
 */
function anthropicBody(
  endpoint: ChatEndpoint,
  messages: OpenAiChatMessage[],
  stream: boolean,
): Record<string, unknown> {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')
  const rounds = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({ role: message.role, content: message.content }))
  return {
    model: endpoint.model,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    messages: rounds,
    ...(system === '' ? {} : { system }),
    ...(stream ? { stream: true } : {}),
  }
}

/** Anthropic 补全响应 → 文本：content 是分块数组，取全部 text 块拼接。 */
function parseAnthropicContent(data: unknown): string {
  const root = isRecord(data) ? data : undefined
  const blocks = root && Array.isArray(root.content) ? root.content : undefined
  if (!blocks) {
    throw new AiError('parse', '补全响应缺少 content 数组，请确认端点是否 Anthropic Messages 兼容')
  }
  const text = blocks
    .map((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
  return text
}

async function requestJson(
  url: string,
  init: PerformFetchInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await performFetch(url, init, { timeoutMs, signal })
  if (!response.ok) throw statusError(response.status)
  let data: unknown
  try {
    data = JSON.parse(await response.text())
  } catch (cause) {
    throw mapJsonFailure(cause)
  }
  return data
}

/**
 * 补全请求按序尝试两个维度：
 * - 路径拼法：官方文档的 baseUrl 自带 /v1（…/v1/messages、…/v1/chat/completions），
 *   而 Claude Code 类网关（如火山方舟 Coding 端点）按 ANTHROPIC_BASE_URL 不带 /v1、
 *   路由挂在 /v1/messages。404/405 意味着「这一段路由不存在」，换下一段；
 * - 鉴权头（仅 anthropic）：官方是 x-api-key，Claude Code 类网关只认
 *   ANTHROPIC_AUTH_TOKEN 的 Bearer 形态。401/403 换下一种头再试（未生成不烧 token）。
 * 其余状态与两个维度无关，原样返回交给上层映射——用户粘贴哪种形态的地址和网关都能直接用。
 */
async function postChat(
  endpoint: ChatEndpoint,
  body: string,
  timeoutMs: number | undefined,
  signal?: AbortSignal,
): Promise<HttpResponseLike> {
  const anthropic = isAnthropic(endpoint)
  const key = endpoint.apiKey.trim()
  const headerVariants: Record<string, string>[] = anthropic
    ? [anthropicHeaders(endpoint.apiKey), ...(key === '' ? [] : [anthropicBearerHeaders(endpoint.apiKey)])]
    : [authHeaders(endpoint.apiKey)]
  const paths = anthropic ? ['messages', 'v1/messages'] : ['chat/completions', 'v1/chat/completions']
  let response: HttpResponseLike | undefined
  for (const path of paths) {
    for (let variant = 0; variant < headerVariants.length; variant++) {
      const attempt = await performFetch(
        joinApiUrl(endpoint.baseUrl, path),
        { method: 'POST', headers: headerVariants[variant] as Record<string, string>, body },
        timeoutMs === undefined ? {} : { timeoutMs, signal },
      )
      response = attempt
      // 还有别的鉴权头形态可试时才在 401/403 上换头重试；只剩一种说明就是 Key 的问题。
      if ((attempt.status === 401 || attempt.status === 403) && variant < headerVariants.length - 1) {
        continue
      }
      if (attempt.status === 404 || attempt.status === 405) break // 这段路由不存在，换下一段路径
      return attempt
    }
  }
  return response as HttpResponseLike
}

export async function chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult> {
  requireBaseUrl(params.endpoint.baseUrl)
  requireModel(params.endpoint.model)
  const anthropic = isAnthropic(params.endpoint)
  const response = await postChat(
    params.endpoint,
    JSON.stringify(
      anthropic
        ? anthropicBody(params.endpoint, params.messages, false)
        : { model: params.endpoint.model, messages: params.messages },
    ),
    REQUEST_TIMEOUT_MS,
    params.signal,
  )
  if (!response.ok) throw statusError(response.status)
  let data: unknown
  try {
    data = JSON.parse(await response.text())
  } catch (cause) {
    throw mapJsonFailure(cause)
  }
  const content = anthropic
    ? parseAnthropicContent(data)
    : parseOpenAiContent(data)
  return { content }
}

function parseOpenAiContent(data: unknown): string {
  const root = isRecord(data) ? data : undefined
  const choices = root && Array.isArray(root.choices) ? root.choices : undefined
  const message = choices && choices.length > 0 && isRecord(choices[0]) ? choices[0].message : undefined
  const content = isRecord(message) ? message.content : undefined
  if (typeof content !== 'string') {
    throw new AiError('parse', '补全响应缺少 choices[0].message.content，请确认端点是否 OpenAI 兼容')
  }
  return content
}

const STREAM_DONE = Symbol('stream-done')

type SseLineResult = string | typeof STREAM_DONE | null

// 解析一行 OpenAI SSE data：返回增量文本；非 data 行/脏 JSON/无增量时返回 null；[DONE] 返回终止标记；
// 事件携带 error 对象（OpenAI 流内错误约定）时抛 http，由上层以 end{error} 收束。
function parseOpenAiSseLine(line: string): SseLineResult {
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

// Anthropic SSE：content_block_delta.delta.text 是增量；message_stop 是终止；
// error 事件抛 http。event: 行（事件名）与 ping 等杂项忽略。
function parseAnthropicSseLine(line: string): SseLineResult {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  const payload = trimmed.slice('data:'.length).trim()
  let event: unknown
  try {
    event = JSON.parse(payload)
  } catch {
    return null
  }
  if (!isRecord(event)) return null
  if (event.type === 'error') {
    const message =
      isRecord(event.error) && typeof event.error.message === 'string'
        ? event.error.message
        : '流式响应返回错误'
    throw new AiError('http', message)
  }
  if (event.type === 'message_stop') return STREAM_DONE
  if (event.type !== 'content_block_delta') return null
  const delta = isRecord(event.delta) ? event.delta : undefined
  const chunk = isRecord(delta) && delta.type === 'text_delta' ? delta.text : undefined
  return typeof chunk === 'string' && chunk !== '' ? chunk : null
}

function parseSseLine(line: string, anthropic: boolean): SseLineResult {
  return anthropic ? parseAnthropicSseLine(line) : parseOpenAiSseLine(line)
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
  const anthropic = isAnthropic(params.endpoint)
  // 流式不加死线：由消费方 abort；路径回退与一次性请求同规则。
  const response = await postChat(
    params.endpoint,
    JSON.stringify(
      anthropic
        ? anthropicBody(params.endpoint, params.messages, true)
        : { model: params.endpoint.model, messages: params.messages, stream: true },
    ),
    undefined,
    params.signal,
  )
  if (!response.ok) throw statusError(response.status)
  // 200 也可能是代理/网关的 HTML 错误页：按解析失败处理，而不是把空流当成功。
  if (response.contentType.toLowerCase().includes('text/html')) {
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
        const delta = parseSseLine(line, anthropic)
        if (delta === STREAM_DONE) return { content }
        if (delta === null) continue
        content += delta
        params.onChunk(delta)
      }
    }
    // 收尾兜底：部分实现省略 [DONE]/message_stop 直接关流（按正常收束）；末行无换行时补解析一次。
    if (buffer.trim() !== '') {
      const delta = parseSseLine(buffer, anthropic)
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
  const data = await requestJson(
    joinApiUrl(params.endpoint.baseUrl, 'embeddings'),
    {
      method: 'POST',
      headers: authHeaders(params.endpoint.apiKey),
      body: JSON.stringify({ model: params.endpoint.model, input: params.inputs }),
    },
    REQUEST_TIMEOUT_MS,
    params.signal,
  )
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

export interface ListModelsParams {
  baseUrl: string
  apiKey: string
  signal?: AbortSignal
  /** 省略即 openai。Anthropic 同样有 GET /models，但鉴权头不同。 */
  format?: ApiFormat
}

/**
 * 拉取模型列表（设置页「拉取模型」）。
 * 容错对齐开源客户端的通行做法（LibreChat / Cherry Studio 的探测链）：
 * - 路径两种拼法按序试：/models 与 /v1/models（base 带 /v1 与不带都覆盖）；
 * - 鉴权头按序试：anthropic 先 x-api-key（官方约定）再 Bearer（Claude Code 类网关只认
 *   ANTHROPIC_AUTH_TOKEN 的 Bearer 形态），openai 只试 Bearer；401/403 换下一种，
 *   最后再试一次无鉴权（部分中转/本地服务的 /models 不收 Key）；
 * - 响应形状多认几种：{data:[{id}]}、{data:["id"]}、{models:[{name|model|id}]}、裸数组；
 * - 失败时把 HTTP 状态码带进文案；404 明说「专用 Messages 网关常不提供列表接口」，
 *   用户能判断是该手动填模型名，还是 Key/网络问题。
 */
export async function listModels(params: ListModelsParams): Promise<string[]> {
  requireBaseUrl(params.baseUrl)
  const anthropic = params.format === 'anthropic'
  const key = params.apiKey.trim()

  const authVariants: Record<string, string>[] = []
  if (key !== '') {
    if (anthropic) {
      authVariants.push({ 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION })
      authVariants.push({ Authorization: `Bearer ${key}` })
    } else {
      authVariants.push({ Authorization: `Bearer ${key}` })
    }
  }
  authVariants.push({})

  const parse = async (response: HttpResponseLike): Promise<string[]> => {
    let data: unknown
    try {
      data = JSON.parse(await response.text())
    } catch (cause) {
      throw mapJsonFailure(cause)
    }
    const ids = parseModelIds(data)
    if (ids.length === 0) {
      throw new AiError('parse', '模型列表响应里没有可用条目：该端点可能不支持 /models，可手动输入模型名')
    }
    return ids
  }

  // 一条死线覆盖整条探测链（两个路径 × 若干鉴权头变体），超时算一次失败。
  const deadline = withDeadline(params.signal, PROBE_TIMEOUT_MS)
  let lastStatus = 0
  for (const path of ['models', 'v1/models']) {
    for (const headers of authVariants) {
      const response = await performFetch(
        joinApiUrl(params.baseUrl, path),
        { method: 'GET', headers },
        { signal: deadline },
      )
      if (response.ok) {
        // 去重保序：下拉列表以 id 为 key，重复会触发 Vue 重复 key 告警。
        const seen: string[] = []
        for (const id of await parse(response)) if (!seen.includes(id)) seen.push(id)
        return seen
      }
      lastStatus = response.status
      if (response.status === 401 || response.status === 403) continue // 换下一种鉴权头再试
      if (response.status === 404 || response.status === 405) break // 这段路由不存在，换下一段路径
      throw new AiError('http', `模型列表拉取失败（HTTP ${response.status}）`, {
        status: response.status,
      })
    }
  }
  const hint =
    lastStatus === 404 || lastStatus === 405
      ? '：该端点可能不提供模型列表接口（专用 Messages 网关常见，如火山方舟 Coding），请手动填写模型名'
      : ''
  throw new AiError('http', `模型列表拉取失败（HTTP ${lastStatus}）${hint}`, {
    status: lastStatus,
  })
}

function parseModelIds(data: unknown): string[] {
  // isRecord 不排除数组：裸数组形态要先按数组取，不能被当成 record 吞掉。
  const root = isRecord(data) && !Array.isArray(data) ? data : undefined
  const candidates = root
    ? Array.isArray(root.data)
      ? root.data
      : Array.isArray(root.models)
        ? root.models
        : undefined
    : Array.isArray(data)
      ? data
      : undefined
  if (!candidates) return []
  const ids: string[] = []
  for (const item of candidates) {
    if (typeof item === 'string') {
      ids.push(item)
      continue
    }
    if (!isRecord(item)) continue
    const id = typeof item.id === 'string' ? item.id : typeof item.name === 'string' ? item.name : typeof item.model === 'string' ? item.model : ''
    if (id !== '') ids.push(id)
  }
  return ids
}