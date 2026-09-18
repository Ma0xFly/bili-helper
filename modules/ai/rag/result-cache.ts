// 检测结果缓存：去广告是高频功能，重复观看/回看同一视频不该再花一次 token。
// 键 = 每视频一条独立 storage.local 键（无读改写竞态），值携带指纹（算法版本 + 后端模式 +
// 去广告/向量端点 + 生效语料哈希），任一变化即未命中自动重算；负缓存（"这视频没广告"）同样
// 入缓存——没有广告的结论也是花了 token 得到的。LRU 淘汰最旧条目，读失败按未命中处理。

import type { AiSettings } from '../../settings'
import { resolveDetectEndpoint, resolveEmbeddingEndpoint } from '../../settings'
import type { AdSegment, AdSource, DetectMeta } from '../port'
import { corpusContentHash } from './corpus'
import { effectiveCorpusDetailed } from './user-corpus'

export const DETECT_CACHE_PREFIX = 'biliHelperDetectCache:'
/** 缓存条数上限：每条约 1KB，200 条 ≈ 200KB storage.local，量级安全。 */
export const DETECT_CACHE_MAX_ENTRIES = 200
/** 算法版本：定界提示词/召回逻辑变化时 +1，让全部旧缓存自动失效。 */
export const DETECT_CACHE_ALGO_VERSION = 1

export interface DetectCacheEntry {
  ads: AdSegment[]
  source: AdSource
  meta?: DetectMeta
  fingerprint: string
  savedAt: number
}

export function detectCacheKey(bvid: string, cid: number): string {
  return `${DETECT_CACHE_PREFIX}${bvid}:${cid}`
}

/**
 * 失效指纹：算法版本 + 后端模式（server 模式的结果来自服务端自己的模型与词库）+
 * 去广告端点/模型（定界者）+ 向量端点/模型（召回者）+ 生效语料哈希（含用户补录）。
 */
export async function detectCacheFingerprint(settings: AiSettings): Promise<string> {
  const detect = resolveDetectEndpoint(settings)
  const embed = resolveEmbeddingEndpoint(settings)
  const { signals } = await effectiveCorpusDetailed()
  return [
    `v${DETECT_CACHE_ALGO_VERSION}`,
    settings.mode,
    settings.mode === 'local' ? '' : settings.serverBaseUrl,
    detect.baseUrl,
    detect.model,
    embed.baseUrl,
    embed.model,
    corpusContentHash(signals),
  ].join('|')
}

function isAdSegment(value: unknown): value is AdSegment {
  if (typeof value !== 'object' || value === null) return false
  const ad = value as Record<string, unknown>
  return (
    typeof ad.start === 'number' &&
    Number.isFinite(ad.start) &&
    typeof ad.end === 'number' &&
    Number.isFinite(ad.end) &&
    ad.end > ad.start
  )
}

function isCacheEntry(value: unknown): value is DetectCacheEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    Array.isArray(entry.ads) &&
    entry.ads.every(isAdSegment) &&
    (entry.source === 'rag' || entry.source === 'llm' || entry.source === 'none') &&
    typeof entry.fingerprint === 'string' &&
    typeof entry.savedAt === 'number'
  )
}

/** 读缓存：读失败/形状不对/指纹不符一律按未命中（缓存是加速器，绝不带崩主链路）。 */
export async function readDetectCache(
  bvid: string,
  cid: number,
  fingerprint: string,
): Promise<DetectCacheEntry | null> {
  try {
    const key = detectCacheKey(bvid, cid)
    const result = await chrome.storage.local.get(key)
    const entry = result[key]
    if (!isCacheEntry(entry) || entry.fingerprint !== fingerprint) return null
    return entry
  } catch {
    return null
  }
}

/** 写缓存并按 LRU 淘汰：淘汰失败静默（多几条旧缓存无害，主链路不能被它拖垮）。 */
export async function writeDetectCache(
  bvid: string,
  cid: number,
  entry: Omit<DetectCacheEntry, 'savedAt'>,
): Promise<void> {
  const record: DetectCacheEntry = { ...entry, savedAt: Date.now() }
  try {
    await chrome.storage.local.set({ [detectCacheKey(bvid, cid)]: record })
  } catch {
    return
  }
  try {
    const all = await chrome.storage.local.get(null)
    const keyed: { key: string; savedAt: number }[] = []
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(DETECT_CACHE_PREFIX)) continue
      const savedAt = (value as { savedAt?: unknown })?.savedAt
      keyed.push({ key, savedAt: typeof savedAt === 'number' ? savedAt : 0 })
    }
    if (keyed.length <= DETECT_CACHE_MAX_ENTRIES) return
    keyed.sort((a, b) => a.savedAt - b.savedAt)
    const stale = keyed.slice(0, keyed.length - DETECT_CACHE_MAX_ENTRIES).map((item) => item.key)
    if (stale.length > 0) await chrome.storage.local.remove(stale)
  } catch {
    // 淘汰失败静默
  }
}

/** 清空检测结果缓存（排障用）。 */
export async function clearDetectCache(): Promise<void> {
  try {
    const all = await chrome.storage.local.get(null)
    const keys = Object.keys(all).filter((key) => key.startsWith(DETECT_CACHE_PREFIX))
    if (keys.length > 0) await chrome.storage.local.remove(keys)
  } catch {
    // 清空失败静默
  }
}
