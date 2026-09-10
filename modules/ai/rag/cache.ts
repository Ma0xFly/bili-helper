// RAG 向量缓存的唯一读写口：一律存 chrome.storage.local（其他层禁止直接操作这些键）。
// 每个复合键一条独立存储键（无读改写竞态：语料/窗口两路并发写入互不覆盖）；
// 窗口条目额外携带窗口文本哈希参与命中判定（字幕修正后旧向量自动失效）。
// 读失败视为未命中、写失败静默吞掉——缓存是加速器，绝不把检索链路带崩。

const CACHE_PREFIX = 'biliHelperRagVectorCache:'
const WINDOW_PREFIX = `${CACHE_PREFIX}windows:`
const CORPUS_PREFIX = `${CACHE_PREFIX}corpus:`

/** 缓存条目：窗口向量附文本哈希（语料条目不带哈希）。 */
export interface VectorCacheEntry {
  vectors: number[][]
  /** 窗口文本哈希；与当前字幕切块结果不一致即视为未命中。 */
  textHash?: string
}

export type RagVectorCache = Record<string, VectorCacheEntry>

function storageKey(key: string): string {
  return `${CACHE_PREFIX}${key}`
}

/** 语料向量键：嵌入模型名 + baseUrl + 语料内容哈希，任一变化全量重算。 */
export function corpusVectorKey(params: {
  model: string
  baseUrl: string
  corpusHash: string
}): string {
  return `corpus:${params.model}:${params.baseUrl}:${params.corpusHash}`
}

/** 窗口向量键：bvid:cid + 模型名 + baseUrl；换视频/换模型/换端点即失效。 */
export function windowVectorKey(params: {
  videoKey: string
  model: string
  baseUrl: string
}): string {
  return `windows:${params.videoKey}:${params.model}:${params.baseUrl}`
}

/** bvid 与 cid 合成的视频身份键。 */
export function videoIdentityKey(bvid: string, cid: number | undefined): string {
  return `${bvid}:${String(cid ?? '')}`
}

function isVectorList(value: unknown): value is number[][] {
  return (
    Array.isArray(value) &&
    value.every((vector) => Array.isArray(vector) && vector.every((x) => typeof x === 'number'))
  )
}

export async function readVectors(key: string): Promise<VectorCacheEntry | null> {
  try {
    const result = await chrome.storage.local.get(storageKey(key))
    const rawValue = result[storageKey(key)] as unknown
    const value = (typeof rawValue === 'object' && rawValue !== null ? rawValue : null) as {
      vectors?: unknown
      textHash?: unknown
    } | null
    if (!value || !isVectorList(value.vectors)) return null
    return {
      vectors: value.vectors,
      ...(typeof value.textHash === 'string' ? { textHash: value.textHash } : {}),
    }
  } catch {
    return null
  }
}

export async function writeVectors(key: string, entry: VectorCacheEntry): Promise<void> {
  try {
    await chrome.storage.local.set({ [storageKey(key)]: entry })
  } catch {
    // 写入失败静默：下次访问重算即可。
  }
}

/**
 * 换视频（bvid:cid 变化）时清理旧窗口向量键：避免旧视频的字幕缓存无期限堆积。
 * 读取失败/清理失败都静默，不影响检索链路。
 */
export async function pruneStaleWindowVectors(currentVideoKey: string): Promise<void> {
  try {
    const all = await chrome.storage.local.get(null)
    const currentPrefix = `${WINDOW_PREFIX}${currentVideoKey}:`
    const stale = Object.keys(all).filter(
      (key) => key.startsWith(WINDOW_PREFIX) && !key.startsWith(currentPrefix),
    )
    if (stale.length > 0) {
      await chrome.storage.local.remove(stale)
    }
  } catch {
    // 清理失败不影响任何链路。
  }
}

/**
 * 换语料（内容哈希变化）时清理旧语料向量键。
 * 用户补录/删除词条会让哈希高频变化，一条语料缓存就是几百个浮点数组（MB 级）；
 * 只写不清必然打满 chrome.storage.local 配额，届时向量缓存静默失效（每次重嵌入），
 * 更糟的是会连带让用户词库自己的写入开始因配额失败。
 * 保留同 model:baseUrl 前缀下的其他哈希（并发检测可能正在读），只清别的端点/模型的旧键。
 */
export async function pruneStaleCorpusVectors(currentKey: string): Promise<void> {
  try {
    const all = await chrome.storage.local.get(null)
    const currentStorageKey = storageKey(currentKey)
    const keptPrefix = currentStorageKey.slice(0, currentStorageKey.lastIndexOf(':') + 1)
    const stale = Object.keys(all).filter(
      (key) => key.startsWith(CORPUS_PREFIX) && !key.startsWith(keptPrefix),
    )
    if (stale.length > 0) {
      await chrome.storage.local.remove(stale)
    }
  } catch {
    // 清理失败不影响任何链路。
  }
}