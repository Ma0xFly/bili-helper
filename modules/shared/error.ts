// 统一错误契约：能力层只抛 AiError，禁止再并行一套 BHLLMError。
// kind 五值覆盖网络/HTTP/鉴权/解析/配置五类失败，status 与 cause 用于向上透传原始上下文。

export type AiErrorKind = 'network' | 'http' | 'auth' | 'parse' | 'config'

export interface AiErrorOptions {
  /** HTTP 状态码（仅 http/auth 类错误有意义）。 */
  status?: number
  /** 原始错误或附加上下文，透传给上层。 */
  cause?: unknown
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

  constructor(kind: AiErrorKind, message: string, options: AiErrorOptions = {}) {
    // cause 交给原生 Error 承载，保证 Error.prototype.cause 语义一致。
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AiError'
    this.kind = kind
    this.status = options.status
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