// 设置页「一键体检」的服务器探测：按转发契约探活 {serverBaseUrl}/ai/health。
// 只判定「地址可达 + 鉴权通过」，不代替真实业务请求；第三方实现若没提供 /ai/health，
// 按「可达但未体检」上报（healthSupported=false），不当成失败——否则老实现会被误判为坏地址。

import { AiError } from '../shared/error'
import {
  PROBE_TIMEOUT_MS,
  isAbortError,
  joinApiUrl,
  mapNetworkError,
  mapResponseError,
  withDeadline,
} from './llm/client'

export interface ServerProbeParams {
  baseUrl: string
  token: string
  signal?: AbortSignal
}

export type ServerProbeResult =
  | { ok: true; ms: number; healthSupported: boolean }
  | { ok: false; reason: string }

export async function probeServerEndpoint(params: ServerProbeParams): Promise<ServerProbeResult> {
  const baseUrl = params.baseUrl.trim()
  if (baseUrl === '') return { ok: false, reason: '先填写服务器地址' }
  const token = params.token.trim()
  const started = Date.now()
  const signal = withDeadline(params.signal, PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(joinApiUrl(baseUrl, '/ai/health'), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(token === '' ? {} : { Authorization: `Bearer ${token}` }),
      },
      signal,
    })
    // 404/405 = 服务在线但不认这个路径：可达性已经证明，深入检查跳过。
    if (response.status === 404 || response.status === 405) {
      return { ok: true, ms: Date.now() - started, healthSupported: false }
    }
    if (!response.ok) throw mapResponseError(response)
    return { ok: true, ms: Date.now() - started, healthSupported: true }
  } catch (error) {
    if (isAbortError(error)) return { ok: false, reason: '体检已取消' }
    return {
      ok: false,
      reason: describeServerFailure(error instanceof AiError ? error : mapNetworkError(error)),
    }
  }
}

/**
 * 服务器探活的红灯文案：与直连端点的文案分开写——扩展页发请求不受页面 CORS 约束，
 * 套用端点那套「请放行 B站域名 CORS」的提示会把人引向错误的排查方向。
 */
export function describeServerFailure(error: AiError): string {
  switch (error.kind) {
    case 'config':
      return error.message
    case 'auth':
      return `${error.status ?? 401} 未授权：请检查 Server Token 是否与服务端一致`
    case 'http':
      return `服务器返回 ${error.status ?? '错误'}：地址可达但服务异常，5xx 可稍后重试`
    case 'parse':
      return error.message
    case 'network':
      return error.message === '请求超时'
        ? '请求超时：服务器未在限定时间内响应，请确认服务已启动'
        : '请求没发出去：请检查服务器地址与网络（自签证书或内网地址需先在浏览器里信任）'
  }
}
