// 召回第二路：字幕按约 30 秒窗口切块、批量向量化（走模块内缓存），
// 与语料向量按余弦相似度取每窗口最高分排序。
// 向量端点不可用/向量响应异常时向上抛 AiError，由编排层走既定降级链。

import type { Subtitle } from '../../video/types'
import { embeddings } from '../llm/client'
import type { ChatEndpoint } from '../llm/client'
import {
  corpusVectorKey,
  pruneStaleWindowVectors,
  readVectors,
  videoIdentityKey,
  windowVectorKey,
  writeVectors,
} from './cache'
import type { CorpusSignal } from './corpus'
import { AD_SIGNAL_CORPUS, corpusContentHash, corpusDocuments } from './corpus'

export const WINDOW_SECONDS = 30
export const MAX_WINDOW_CHARS = 400

export interface SubtitleWindow {
  index: number
  start: number
  end: number
  text: string
}

export interface VectorRankedWindow {
  /** 对应输入 windows 数组的下标。 */
  index: number
  score: number
}

/** 语料与窗口相似度下限：低于此分数的窗口视为无语义相关（词表未命中时的向量补位面）。 */
export const MIN_SIMILARITY = 0.35

/**
 * 字幕切块：约 30 秒滑动窗口。逐行贪心装窗，装不下（时长或字数到顶）即封窗开新窗；
 * 窗口粒度对齐召回层，父级上下文由小转大阶段回取。
 */
export function chunkSubtitleWindows(
  subtitles: Subtitle[],
  windowSeconds: number = WINDOW_SECONDS,
  maxChars: number = MAX_WINDOW_CHARS,
): SubtitleWindow[] {
  const sorted = [...subtitles].sort((a, b) => a.start - b.start)
  const windows: SubtitleWindow[] = []
  let current: { start: number; end: number; lines: string[] } | null = null
  let totalChars = 0

  const closeWindow = () => {
    if (!current || current.lines.length === 0) return
    windows.push({
      index: windows.length,
      start: current.start,
      end: current.end,
      text: current.lines.join(' '),
    })
  }

  for (const line of sorted) {
    const duration = Math.max(line.end - line.start, 0.5)
    const length = line.text.length
    if (current && (line.end - current.start > windowSeconds || totalChars + length > maxChars)) {
      closeWindow()
      current = null
    }
    if (!current) {
      current = { start: line.start, end: line.end, lines: [] }
      totalChars = 0
    }
    current.lines.push(line.text)
    current.end = Math.max(current.end, line.end)
    totalChars += length
  }
  closeWindow()
  return windows
}

export function normalize(vector: number[]): number[] {
  let sum = 0
  for (const value of vector) sum += value * value
  const norm = Math.sqrt(sum)
  if (norm === 0 || !Number.isFinite(norm)) return vector
  return vector.map((value) => value / norm)
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0)
    normA += (a[i] ?? 0) * (a[i] ?? 0)
    normB += (b[i] ?? 0) * (b[i] ?? 0)
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

/**
 * 语料向量（缓存感知）：键含模型/baseUrl/语料哈希，任一变化缓存不命中、全量重算。
 * corpus 缺省为内置词库；传入「内置 + 用户补录」的生效语料时，哈希随之变化 → 自动重算，
 * 用户加词不需要任何显式清缓存动作。
 */
export async function getCorpusVectors(
  endpoint: ChatEndpoint,
  signal?: AbortSignal,
  corpus: readonly CorpusSignal[] = AD_SIGNAL_CORPUS,
): Promise<number[][]> {
  const key = corpusVectorKey({
    model: endpoint.model,
    baseUrl: endpoint.baseUrl,
    corpusHash: corpusContentHash(corpus),
  })
  const cached = await readVectors(key)
  if (cached?.vectors && cached.vectors.length > 0) return cached.vectors
  const documents = corpusDocuments(corpus)
  const vectors = await embeddings({ endpoint, inputs: documents, signal })
  await writeVectors(key, { vectors })
  return vectors
}

/** 窗口文本哈希（FNV-1a 32 位）：字幕切块内容变化则哈希变化，旧向量缓存随之失效。 */
export function windowsTextHash(windows: SubtitleWindow[]): string {
  const serialized = windows
    .map((window) => `${window.start}|${window.end}|${window.text}`)
    .join('\n')
  let hash = 0x811c9dc5
  for (let i = 0; i < serialized.length; i += 1) {
    hash ^= serialized.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 窗口向量（缓存感知）：键含 bvid:cid/模型/baseUrl；命中还需文本哈希一致（字幕修正后重算）。 */
export async function getWindowVectors(
  windows: SubtitleWindow[],
  videoKey: string,
  endpoint: ChatEndpoint,
  signal?: AbortSignal,
): Promise<number[][]> {
  const key = windowVectorKey({ videoKey, model: endpoint.model, baseUrl: endpoint.baseUrl })
  const textHash = windowsTextHash(windows)
  const cached = await readVectors(key)
  if (cached && cached.textHash === textHash && cached.vectors.length === windows.length) {
    return cached.vectors
  }
  const vectors = await embeddings({ endpoint, inputs: windows.map((window) => window.text), signal })
  await writeVectors(key, { vectors, textHash })
  return vectors
}

/**
 * 向量召回：窗口向量与语料向量两两余弦（取每窗口的最高分），过滤相似度下限后降序返回。
 * 向量端点失败抛错向上——降级链由编排层决定（纯词表续跑）。
 */
export async function rankWindowsByVector(
  windows: SubtitleWindow[],
  video: { bvid: string; cid: number | undefined },
  endpoint: ChatEndpoint,
  signal?: AbortSignal,
  corpus: readonly CorpusSignal[] = AD_SIGNAL_CORPUS,
): Promise<VectorRankedWindow[]> {
  if (windows.length === 0) return []
  // 每个视频进来先清掉其他视频的窗口缓存键：旧视频字幕修正产生的新旧向量键不会无期限堆积。
  await pruneStaleWindowVectors(videoIdentityKey(video.bvid, video.cid))
  const [corpusVectors, windowVectors] = await Promise.all([
    getCorpusVectors(endpoint, signal, corpus),
    getWindowVectors(windows, videoIdentityKey(video.bvid, video.cid), endpoint, signal),
  ])
  const normalizedCorpus = corpusVectors.map(normalize)
  const normalizedWindows = windowVectors.map(normalize)
  const ranked: VectorRankedWindow[] = []
  for (let index = 0; index < windows.length; index += 1) {
    const windowVector = normalizedWindows[index]
    if (!windowVector) continue
    let best = 0
    for (const corpusVector of normalizedCorpus) {
      const similarity = cosineSimilarity(windowVector, corpusVector)
      if (similarity > best) best = similarity
    }
    if (best >= MIN_SIMILARITY) ranked.push({ index, score: best })
  }
  ranked.sort((a, b) => b.score - a.score || a.index - b.index)
  return ranked
}