// RAG 检索内置信号语料：语料从 TS 常量改为「分品类 md 词库 + 构建期打包」的单一事实源，
// corpus.ts 只做解析与导出。加词不碰代码：在 corpus/*.md 里加一行即可，哈希自动失效向量缓存。
//
// 词库文件即元信息：文件名 → 品类与信号类别（scripts/slang → script，deals → deal，brands-* → brand），
// 词表精确匹配与向量召回共用同一份解析结果；任何文件任何一行的改动都会改变
// corpusContentHash()，向量缓存据此全量失效重算（缓存键含语料哈希，无需手改版本号）。

/// <reference types="vite/client" />

export interface CorpusSignal {
  /** 信号短语，词表精确匹配与向量召回的检索单元。 */
  text: string
  /** 信号类别：话术 / 品牌产品词 / 交易信号。 */
  kind: 'script' | 'brand' | 'deal'
  /** 词表精确匹配命中时的加分权重。 */
  weight: number
  /** 品类 = 词库文件名（去 .md）：词表/向量两路的 type 过滤维度。 */
  category: string
}

export interface CorpusFileMeta {
  /** 品类 = 文件名（去 .md）。 */
  category: string
  kind: CorpusSignal['kind']
  /** 该文件词条的默认权重；行内「词|N」可覆盖。 */
  defaultWeight: number
}

/** 词库文件名 → 信号类别与默认权重。文件名即元信息，不维护额外清单文件。 */
export function corpusFileMeta(filename: string): CorpusFileMeta | null {
  if (filename === 'scripts.md') return { category: 'scripts', kind: 'script', defaultWeight: 2 }
  if (filename === 'slang.md') return { category: 'slang', kind: 'script', defaultWeight: 2 }
  if (filename === 'deals.md') return { category: 'deals', kind: 'deal', defaultWeight: 2 }
  if (filename.startsWith('brands-')) {
    return { category: filename.slice(0, -'.md'.length), kind: 'brand', defaultWeight: 1 }
  }
  return null
}

/** 解析一行词条：空行与 # 注释忽略；「词|N」覆盖默认权重。 */
export function parseCorpusLine(
  line: string,
  defaultWeight: number,
): Pick<CorpusSignal, 'text' | 'weight'> | null {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return null
  const override = trimmed.match(/^(.*?)\|(\d+)$/)
  if (override) {
    const text = (override[1] ?? '').trim()
    const weight = Number(override[2])
    if (text === '' || weight <= 0) return null
    return { text, weight }
  }
  // 含 | 但不是「词|N」格式 → 视为脏行，不进入词库。
  if (trimmed.includes('|')) return null
  return { text: trimmed, weight: defaultWeight }
}

/** 解析整份词库源码为词条数组（纯函数，加载与测试共用）。 */
export function parseCorpusSource(source: string, meta: CorpusFileMeta): CorpusSignal[] {
  const signals: CorpusSignal[] = []
  for (const line of source.split('\n')) {
    const parsed = parseCorpusLine(line, meta.defaultWeight)
    if (parsed) signals.push({ ...parsed, kind: meta.kind, category: meta.category })
  }
  return signals
}

// 构建期打包词库：扩展运行时没有独立资源路径，不能运行时 fetch md，必须构建期打进 bundle。
const rawCorpus = import.meta.glob<string>('./corpus/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/** 全部词条：文件名排序保证顺序稳定（哈希与向量输入依赖稳定顺序）。 */
export const AD_SIGNAL_CORPUS: readonly CorpusSignal[] = Object.keys(rawCorpus)
  .sort()
  .flatMap((file) => {
    const meta = corpusFileMeta(file.replace(/^.*[\\/]/, ''))
    return meta ? parseCorpusSource(rawCorpus[file] ?? '', meta) : []
  })

/** 语料文本（向量化的输入，词表/向量共用同一份解析结果）；可传合并后的生效语料。 */
export function corpusDocuments(corpus: readonly CorpusSignal[] = AD_SIGNAL_CORPUS): string[] {
  return corpus.map((signal) => signal.text)
}

/** 语料内容哈希（FNV-1a 32 位，同步纯函数）：语料内容变则哈希变，向量缓存随之全量失效。 */
export function corpusContentHash(corpus: readonly CorpusSignal[] = AD_SIGNAL_CORPUS): string {
  const serialized = JSON.stringify(corpus)
  let hash = 0x811c9dc5
  for (let i = 0; i < serialized.length; i += 1) {
    hash ^= serialized.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
