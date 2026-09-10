// 用户层广告语料：漏检广告的补录入口（设置页「广告词库」）。
// 与构建期内置词库分层——corpus/*.md 打包后只读、随版本发布；用户层存 chrome.storage.local，
// 可写、即时生效。两层合并后同时喂给词表精确匹配与向量召回，并进入语料哈希：
// 用户加一个词 → 哈希变 → 语料向量缓存自动全量重算，不需要任何额外的失效逻辑。
//
// 为什么不让用户提交直接写进 md：扩展 bundle 运行时不可写；更重要的是未经审核的词进精确匹配
// 词表会污染全库召回质量（泛义词误伤），所以运行时只写用户层，入库审核走导出的 md patch。

import type { CorpusSignal } from './corpus'
import { AD_SIGNAL_CORPUS, corpusFileMeta } from './corpus'

export const USER_CORPUS_KEY = 'biliHelperUserCorpus'
/** 用户层词条上限：防止无限增长拖慢每次检索的词表遍历与向量重算。 */
export const MAX_USER_ENTRIES = 500
/** 单词条长度上限：信号是短语，不是句子（超长说明用户贴了整段字幕）。 */
export const MAX_ENTRY_LENGTH = 40

export interface UserCorpusEntry {
  text: string
  /** 品类分组，与内置词库同名（scripts/slang/deals/brands-*）。 */
  category: string
  kind: CorpusSignal['kind']
  weight: number
  /** 来源备注（可空）：如「BV1xx 03:20–04:10 漏检」，导出 md patch 时作为注释保留。 */
  note: string
  createdAt: string
}

export type AddUserCorpusResult =
  | { ok: true; entries: UserCorpusEntry[] }
  | { ok: false; reason: string }

/** 可选品类 = 内置词库现有分组（去重排序）；新增 brands-* 分组由 categoryKind 自然支持。 */
export const USER_CORPUS_CATEGORIES: readonly string[] = [
  ...new Set(AD_SIGNAL_CORPUS.map((signal) => signal.category)),
].sort()

/** 品类的信号类别与默认权重：复用「文件名即元信息」的同一套规则，避免两处口径漂移。 */
export function categoryDefaults(category: string): { kind: CorpusSignal['kind']; weight: number } {
  const meta = corpusFileMeta(`${category}.md`)
  return meta ? { kind: meta.kind, weight: meta.defaultWeight } : { kind: 'brand', weight: 1 }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 读侧防御：storage 里可能是旧版本/手改的脏数据，逐条归一，非法条目直接丢弃。 */
export function normalizeUserEntry(value: unknown): UserCorpusEntry | null {
  if (!isRecord(value)) return null
  const text = typeof value.text === 'string' ? value.text.trim() : ''
  if (text === '' || text.length > MAX_ENTRY_LENGTH) return null
  const category = typeof value.category === 'string' ? value.category.trim() : ''
  if (category === '') return null
  const defaults = categoryDefaults(category)
  const kind =
    value.kind === 'script' || value.kind === 'brand' || value.kind === 'deal'
      ? value.kind
      : defaults.kind
  const weight =
    typeof value.weight === 'number' && Number.isFinite(value.weight) && value.weight > 0
      ? Math.min(9, Math.round(value.weight))
      : defaults.weight
  return {
    text,
    category,
    kind,
    weight,
    note: typeof value.note === 'string' ? value.note.slice(0, 200) : '',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
  }
}

export async function readUserCorpus(): Promise<UserCorpusEntry[]> {
  try {
    const result = await chrome.storage.local.get(USER_CORPUS_KEY)
    const raw = result[USER_CORPUS_KEY]
    if (!Array.isArray(raw)) return []
    const entries: UserCorpusEntry[] = []
    const seen = new Set<string>()
    for (const item of raw) {
      const entry = normalizeUserEntry(item)
      // 读侧也去重：历史脏数据里的重复词不该让词表遍历白跑两遍。
      if (!entry || seen.has(entry.text)) continue
      seen.add(entry.text)
      entries.push(entry)
    }
    return entries
  } catch {
    // 读失败按「没有用户词」处理：检索链路绝不能因为补录数据挂掉。
    return []
  }
}

// 写操作串行化：读改写在并发下会互相覆盖（设置页连点两次「添加」就要丢一条）。
// 写失败必须让调用方知道——静默返回旧列表会让界面报「已补录」而实际什么都没存下。
let writeChain: Promise<unknown> = Promise.resolve()

async function mutate(
  fn: (entries: UserCorpusEntry[]) => Promise<UserCorpusEntry[]> | UserCorpusEntry[],
): Promise<UserCorpusEntry[]> {
  const next = writeChain.then(async () => {
    const entries = await readUserCorpus()
    const updated = await fn(entries)
    await chrome.storage.local.set({ [USER_CORPUS_KEY]: updated })
    return updated
  })
  // 链条本身永不 reject，避免一次失败把后续写入全卡死。
  writeChain = next.catch(() => undefined)
  return next
}

// 内置词库不变，词集合只算一次（每次校验都重建 182 项 Set 是白烧）。
let builtinTexts: Set<string> | null = null

/** 内置词库已有词集合：用户层不收重复词（重复只会让精确匹配白遍历一遍）。 */
export function builtinCorpusTexts(): Set<string> {
  if (builtinTexts === null) {
    builtinTexts = new Set(AD_SIGNAL_CORPUS.map((signal) => signal.text))
  }
  return builtinTexts
}

/** 词条校验：短语形态、不含 md 分隔符、不与内置/用户层重复、未超上限。 */
export function validateUserEntryText(
  text: string,
  existing: readonly UserCorpusEntry[],
): string | null {
  const trimmed = text.trim()
  if (trimmed === '') return '先填一个词或短语'
  if (trimmed.length > MAX_ENTRY_LENGTH) return `太长了（最多 ${MAX_ENTRY_LENGTH} 字），信号应是短语而不是整句`
  // md 词库用「词|N」表达权重，词条里带 | 会让导出的 patch 解析错乱。
  if (trimmed.includes('|')) return '不能包含「|」字符（词库用它分隔权重）'
  if (/[\r\n]/.test(trimmed)) return '不能包含换行'
  if (builtinCorpusTexts().has(trimmed)) return '内置词库已经有这个词了'
  if (existing.some((entry) => entry.text === trimmed)) return '这个词已经在你的词库里了'
  if (existing.length >= MAX_USER_ENTRIES) return `词库已满（${MAX_USER_ENTRIES} 条），先删掉一些再加`
  return null
}

export async function addUserCorpusEntry(input: {
  text: string
  category: string
  note?: string
}): Promise<AddUserCorpusResult> {
  const category = input.category.trim()
  if (category === '' || !/^[a-z0-9-]+$/u.test(category)) {
    return { ok: false, reason: '品类不合法（只允许小写字母、数字与连字符）' }
  }
  const text = input.text.trim()
  const current = await readUserCorpus()
  const invalid = validateUserEntryText(text, current)
  if (invalid) return { ok: false, reason: invalid }
  const defaults = categoryDefaults(category)
  try {
    const entries = await mutate((existing) => [
      ...existing,
      {
        text,
        category,
        kind: defaults.kind,
        weight: defaults.weight,
        note: (input.note ?? '').trim().slice(0, 200),
        createdAt: new Date().toISOString(),
      },
    ])
    return { ok: true, entries }
  } catch {
    return { ok: false, reason: '保存失败，请重试' }
  }
}

export async function removeUserCorpusEntry(text: string): Promise<UserCorpusEntry[]> {
  const target = text.trim()
  return mutate((entries) => entries.filter((entry) => entry.text !== target))
}

export async function clearUserCorpus(): Promise<UserCorpusEntry[]> {
  return mutate(() => [])
}

/** 按品类分组（品类名排序），导出与合并共用同一份分组结果。 */
function groupByCategory(
  entries: readonly UserCorpusEntry[],
): [string, UserCorpusEntry[]][] {
  const grouped = new Map<string, UserCorpusEntry[]>()
  for (const entry of entries) {
    const list = grouped.get(entry.category) ?? []
    list.push(entry)
    grouped.set(entry.category, list)
  }
  return [...grouped.keys()].sort().map((category) => [category, grouped.get(category) ?? []])
}

/**
 * 两层合并：内置在前、用户在后（按品类分组、品类内保持添加顺序），text 撞车时内置优先
 * （用户层不能改内置词的权重，只能新增）。顺序稳定 → 语料哈希稳定 → 不会无故触发向量全量重算。
 */
export function mergeWithBuiltinCorpus(
  userEntries: readonly UserCorpusEntry[],
  builtin: readonly CorpusSignal[] = AD_SIGNAL_CORPUS,
): CorpusSignal[] {
  const seen = new Set(builtin.map((signal) => signal.text))
  const merged = [...builtin]
  for (const [, list] of groupByCategory(userEntries)) {
    for (const entry of list) {
      if (seen.has(entry.text)) continue
      seen.add(entry.text)
      merged.push({
        text: entry.text,
        kind: entry.kind,
        weight: entry.weight,
        category: entry.category,
      })
    }
  }
  return merged
}

/** 检索入口用：内置 + 用户层的生效语料（读失败自动退化为纯内置）。 */
export async function effectiveCorpus(): Promise<CorpusSignal[]> {
  return mergeWithBuiltinCorpus(await readUserCorpus())
}

/**
 * 导出为 md patch：与 corpus/*.md 完全同格式——按品类分块、一行一条、权重非默认才写「词|N」、
 * 来源备注作为注释保留。整份导出可以直接追加进对应 md 文件而不丢词：
 * 分组标题一律用「#」注释（词库解析器把 # 行当注释跳过；写成 ## 之外的标记会被当脏行丢弃）。
 */
export function exportUserCorpusMarkdown(entries: readonly UserCorpusEntry[]): string {
  if (entries.length === 0) return ''
  const lines: string[] = ['# 用户补录广告词库导出（格式与 corpus/*.md 一致，可直接追加进对应分组）']
  for (const [category, list] of groupByCategory(entries)) {
    const defaults = categoryDefaults(category)
    lines.push('', `# —— ${category}.md ——`)
    for (const entry of list) {
      if (entry.note !== '') lines.push(`# 来源：${entry.note}`)
      lines.push(entry.weight === defaults.weight ? entry.text : `${entry.text}|${entry.weight}`)
    }
  }
  return `${lines.join('\n')}\n`
}
