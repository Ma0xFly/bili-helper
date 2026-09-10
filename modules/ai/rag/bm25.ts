// 召回第一路：词表精确匹配 + BM25 评分（英文 token 化 + 中文 bigram）。
// 检索方向 = 内置语料信号为查询、候选窗口为文档；idf 取自窗口集合自身，
// 词表命中加语料信号权重（恰饭话术类权重高于普通品牌词）。

import type { CorpusSignal } from './corpus'
import { AD_SIGNAL_CORPUS } from './corpus'

export interface LexicalRankedWindow {
  /** 对应输入 windows 数组的下标。 */
  index: number
  score: number
}

const K1 = 1.5
const B = 0.75

/** 英文按词（小写）、中文按 bigram 的 token 化：混合文本各段落到各自通道。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lowered = text.toLowerCase()
  // ASCII 词与 CJK 连段分开匹配，其余标点跳过。
  const segments = lowered.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]+|[a-z0-9]+/g) ?? []
  for (const segment of segments) {
    if (/^[a-z0-9]+$/.test(segment)) {
      tokens.push(segment)
    } else {
      tokens.push(...cjkBigrams(segment))
    }
  }
  return tokens
}

/** 中文 bigram 切分：长度 1 的单字原样保留（品牌短信号如「vivo」之外的单字词极少，保底不丢）。 */
export function cjkBigrams(text: string): string[] {
  const chars = Array.from(text)
  if (chars.length === 1) return [chars[0] ?? '']
  const bigrams: string[] = []
  for (let i = 0; i + 1 < chars.length; i += 1) {
    bigrams.push(`${chars[i]}${chars[i + 1]}`)
  }
  return bigrams
}

/** 词表精确匹配：语料短语原样出现在文本里即命中（返回命中短语集合）。 */
export function exactSignalMatches(
  text: string,
  corpus: readonly CorpusSignal[] = AD_SIGNAL_CORPUS,
): Set<string> {
  const hits = new Set<string>()
  for (const signal of corpus) {
    if (text.includes(signal.text)) hits.add(signal.text)
  }
  return hits
}

/** 精确命中的加权分：命中短语的语料权重求和。 */
export function exactSignalScore(
  text: string,
  corpus: readonly CorpusSignal[] = AD_SIGNAL_CORPUS,
): number {
  let score = 0
  for (const signal of corpus) {
    if (text.includes(signal.text)) score += signal.weight
  }
  return score
}

interface DocStats {
  /** 每篇文档的 term → 词频。 */
  termFreqs: Map<string, number>[]
  lengths: number[]
  avgLength: number
  idf: Map<string, number>
}

function buildDocStats(documents: string[]): DocStats {
  const termFreqs = documents.map((doc) => {
    const freq = new Map<string, number>()
    for (const token of tokenize(doc)) freq.set(token, (freq.get(token) ?? 0) + 1)
    return freq
  })
  const lengths = termFreqs.map((freq) => {
    let total = 0
    for (const count of freq.values()) total += count
    return total
  })
  const avgLength =
    lengths.length > 0 ? lengths.reduce((sum, len) => sum + len, 0) / lengths.length : 0
  const documentCount = documents.length
  const idf = new Map<string, number>()
  for (const freq of termFreqs) {
    for (const term of freq.keys()) {
      if (idf.has(term)) continue
      // 命中文档数
      let df = 0
      for (const other of termFreqs) if (other.has(term)) df += 1
      idf.set(term, Math.log(1 + (documentCount - df + 0.5) / (df + 0.5)))
    }
  }
  return { termFreqs, lengths, avgLength, idf }
}

/** 语料查询词（去重）：词表精确匹配的天然候选词集合。 */
function corpusQueryTerms(corpus: readonly CorpusSignal[]): string[] {
  const terms = new Set<string>()
  for (const signal of corpus) {
    for (const token of tokenize(signal.text)) terms.add(token)
  }
  return [...terms]
}

/**
 * 对窗口集跑词表召回：BM25 与精确命中加权之和为窗口得分，0 分（无任何语料痕迹）不进入结果。
 * 输入是字幕切出的窗口（约 30 秒），输出按得分降序的命中窗口下标。
 * corpus 缺省为内置词库；编排层会传入「内置 + 用户补录」的生效语料。
 */
export function rankWindowsByLexical(
  windows: { text: string }[],
  corpus: readonly CorpusSignal[] = AD_SIGNAL_CORPUS,
): LexicalRankedWindow[] {
  if (windows.length === 0) return []
  const documents = windows.map((window) => window.text)
  const stats = buildDocStats(documents)
  const queryTerms = corpusQueryTerms(corpus)
  const ranked: LexicalRankedWindow[] = []
  for (let index = 0; index < windows.length; index += 1) {
    const freq = stats.termFreqs[index]
    const docLength = stats.lengths[index] ?? 0
    if (!freq || docLength === 0) continue
    let bm25 = 0
    for (const term of queryTerms) {
      const tf = freq.get(term) ?? 0
      if (tf === 0) continue
      const idf = stats.idf.get(term) ?? 0
      const norm = docLength / Math.max(stats.avgLength, 1)
      bm25 += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + B * norm))
    }
    const score = bm25 + exactSignalScore(documents[index] ?? '', corpus)
    if (score > 0) ranked.push({ index, score })
  }
  ranked.sort((a, b) => b.score - a.score || a.index - b.index)
  return ranked
}