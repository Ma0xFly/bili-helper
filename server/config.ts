// 服务端配置：全部来自环境变量。模型 Key 只从这里流入，绝不写进代码、日志或响应体。
// 向量端点三项留空即继承对话端点——与扩展端同一套语义（复用 resolveEmbeddingEndpoint）。

import type { AiSettings } from '../modules/settings'
import { DEFAULT_SETTINGS } from '../modules/settings'

export const DEFAULT_PORT = 8787
export const DEFAULT_HOST = '127.0.0.1'
/** 字幕+弹幕全量上传，长视频能到几 MB；上限给足但要有，防无限请求体打爆内存。 */
export const DEFAULT_MAX_BODY_BYTES = 24 * 1024 * 1024

export interface ServerConfig {
  /** 交给能力层的设置：mode 固定 local（服务端自己跑 RAG + 直连模型端点）。 */
  settings: AiSettings
  /** 转发鉴权 token；为空表示不鉴权（只适合本机/内网）。 */
  token: string
  allowOrigin: string
  maxBodyBytes: number
  port: number
  host: string
  /** 向量缓存落盘文件；为空则用内存缓存（重启后重算）。 */
  storageFile: string
}

function envString(
  env: Record<string, string | undefined>,
  key: string,
  fallback = '',
): string {
  const value = env[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function envInt(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const parsed = Number(env[key])
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback
}

export function readServerConfig(
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  return {
    settings: {
      ...DEFAULT_SETTINGS,
      apiUrl: envString(env, 'AI_API_URL'),
      model: envString(env, 'AI_MODEL'),
      apiKey: envString(env, 'AI_API_KEY'),
      embedBaseUrl: envString(env, 'AI_EMBED_BASE_URL'),
      embedModel: envString(env, 'AI_EMBED_MODEL'),
      embedKey: envString(env, 'AI_EMBED_API_KEY'),
      // 服务端永远跑本地管线：若照抄 mode=server，它会把请求转发给自己形成回环。
      mode: 'local',
      serverBaseUrl: '',
      serverToken: '',
      // 这两个开关是扩展端 UI 门禁，服务端不消费；给 true 只是保持形状完整。
      adSkipEnabled: true,
      panelEnabled: true,
    },
    token: envString(env, 'AI_SERVER_TOKEN'),
    allowOrigin: envString(env, 'AI_SERVER_ORIGIN', '*'),
    maxBodyBytes: envInt(env, 'AI_SERVER_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES),
    port: envInt(env, 'PORT', DEFAULT_PORT),
    host: envString(env, 'AI_SERVER_HOST', DEFAULT_HOST),
    storageFile: envString(env, 'AI_SERVER_STORAGE_FILE'),
  }
}

/** 启动前体检：缺什么直接说清变量名，而不是等第一个请求进来才报「还没配置端点」。 */
export function missingConfigReasons(config: ServerConfig): string[] {
  const reasons: string[] = []
  if (config.settings.apiUrl === '') reasons.push('AI_API_URL（对话端点 Base URL）')
  if (config.settings.model === '') reasons.push('AI_MODEL（对话模型名）')
  return reasons
}
