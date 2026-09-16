// 统一错误契约：能力层只抛 AiError，禁止再并行一套 BHLLMError。
// kind 五值覆盖网络/HTTP/鉴权/解析/配置五类失败，status 与 cause 用于向上透传原始上下文。

export type AiErrorKind = 'network' | 'http' | 'auth' | 'parse' | 'config'

export interface AiErrorOptions {
  /** HTTP 状态码（仅 http/auth 类错误有意义）。 */
  status?: number
  /** 原始错误或附加上下文，透传给上层。 */
  cause?: unknown
  /** 原始响应摘录（诊断用：坏 JSON/格式不对时直接看到端点回了什么）。不进 JSON 序列化。 */
  rawResponse?: string
}

export interface AiErrorJson {
  name: string
  kind: AiErrorKind
  message: string
  status?: number
  cause?: unknown
}

export class AiError extends Error {
  readonly kind: AiErrorKind
  readonly status?: number
  /** 原始响应摘录（诊断控制台用；序列化契约不含它）。 */
  readonly rawResponse?: string

  constructor(kind: AiErrorKind, message: string, options: AiErrorOptions = {}) {
    // cause 交给原生 Error 承载，保证 Error.prototype.cause 语义一致。
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AiError'
    this.kind = kind
    this.status = options.status
    this.rawResponse = options.rawResponse
  }

  toJSON(): AiErrorJson {
    return {
      name: this.name,
      kind: this.kind,
      message: this.message,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.cause === undefined ? {} : { cause: normalizeCause(this.cause) }),
    }
  }

  serialize(): string {
    try {
      return JSON.stringify(this.toJSON())
    } catch {
      // 环形结构 / BigInt 等无法 JSON 化的 cause：退回不含 cause 的安全摘要。
      return JSON.stringify({
        name: this.name,
        kind: this.kind,
        message: this.message,
        status: this.status,
      })
    }
  }
}

// 原生 Error 直接 JSON 化只剩 {}，丢失 message；归一为可序列化的摘要形态。
function normalizeCause(cause: unknown): unknown {
  return cause instanceof Error ? { name: cause.name, message: cause.message } : cause
}

// SSE end.error 的载体：可跨事件/进程边界序列化的错误摘要（不含 cause）。
export interface AiErrorInfo {
  kind: AiErrorKind
  message: string
  status?: number
}

// 把任意抛出物归一为摘要：AiError 直接投影 kind/message/status，
// 普通 Error 与未知值收敛为 network——能力层的边界统一出口。
export function errorInfoFrom(error: unknown): AiErrorInfo {
  if (error instanceof AiError) {
    return {
      kind: error.kind,
      message: error.message,
      ...(error.status === undefined ? {} : { status: error.status }),
    }
  }
  if (error instanceof Error) {
    return { kind: 'network', message: error.message || '未知错误' }
  }
  let message: string
  try {
    message = String(error)
  } catch {
    // null 原型对象等不可字符串化的值：兜底文案保证 end{error} 一定送得出去。
    message = '未知错误'
  }
  return { kind: 'network', message }
}