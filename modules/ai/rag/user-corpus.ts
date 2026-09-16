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
  /** 实际参与召回命中的次数（检测链路自动累计）：0 = 还没产生过价值，可考虑清理。 */
  hitCount: number
  /** 最近一次命中时间（ISO；空串 = 从未命中）。 */
  lastHitAt: string
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

/**
 * 不可见格式字符（零宽空格 / BOM / 方向标记）：从字幕或网页粘贴时很常见。
 * 不剥掉的后果是「看起来是空的词」能入库，以及「恰饭​」（带零宽）绕过与内置词的去重——
 * 而精确匹配用 includes，带零宽的词条永远匹配不上字幕，白占权重还白白触发向量重算。
 */
const INVISIBLE_CHARS = /[\u200b-\u200f\u2060\ufeff]/gu

/** 词条文本归一：剥不可见字符后 trim（校验、入库、读侧共用同一口径）。 */
export function normalizeEntryText(value: unknown): string {
  return typeof value === 'string' ? value.replace(INVISIBLE_CHARS, '').trim() : ''
}

/** 读侧防御：storage 里可能是旧版本/手改的脏数据，逐条归一，非法条目直接丢弃。 */
export function normalizeUserEntry(value: unknown): UserCorpusEntry | null {
  if (!isRecord(value)) return null
  const text = normalizeEntryText(value.text)
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
    // note 压成单行：手改/旧版本的脏数据里带换行，会让导出 patch 出现脱离注释的注入行。
    note: typeof value.note === 'string' ? value.note.replace(/\s+/gu, ' ').trim().slice(0, 200) : '',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    hitCount:
      typeof value.hitCount === 'number' && Number.isFinite(value.hitCount) && value.hitCount > 0
        ? Math.round(value.hitCount)
        : 0,
    lastHitAt: typeof value.lastHitAt === 'string' ? value.lastHitAt : '',
  }
}

export async function readUserCorpus(): Promise<UserCorpusEntry[]> {
  try {
    return normalizeUserEntries((await readRaw()).raw)
  } catch {
    // 读失败按「没有用户词」处理：检索链路绝不能因为补录数据挂掉。
    // 注意这个降级只适用于读侧（effectiveCorpus）；写侧走 readRaw()，
    // 否则一次瞬时读失败就会把「读不到」当成「没有」，读改写直接清空整个词库。
    return []
  }
}

/** 裸读：失败照抛，供读改写链使用。 */
async function readRaw(): Promise<{ raw: unknown }> {
  const result = await chrome.storage.local.get(USER_CORPUS_KEY)
  return { raw: result[USER_CORPUS_KEY] }
}

/** 读侧归一：非数组/脏条目/重复词一律收敛，保证下游拿到的永远是干净列表。 */
export function normalizeUserEntries(raw: unknown): UserCorpusEntry[] {
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
}

// 写操作串行化：读改写在并发下会互相覆盖（设置页连点两次「添加」就要丢一条）。
// 校验也必须在链内做——链外校验下，并发的同词添加会双双通过校验而重复入库，
// 并发越过上限同样会击穿 MAX_USER_ENTRIES。
// 写失败必须让调用方知道：静默返回旧列表会让界面报「已补录」而实际什么都没存下。
let writeChain: Promise<unknown> = Promise.resolve()

/** persist 为 null = 校验未过，不写入；value 原样带回调用方（含拒绝原因）。 */
type MutateOutcome<T> = { persist: UserCorpusEntry[] | null; value: T }

/** 单步存储操作上限：扩展上下文失效时 storage promise 可能永不落定，不给超时就会卡死整条写链。 */
export const STORAGE_STEP_TIMEOUT_MS = 10_000

async function withStorageTimeout<T>(step: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      step,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`存储操作超过 ${STORAGE_STEP_TIMEOUT_MS}ms 未响应`)),
          STORAGE_STEP_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function mutate<T>(
  fn: (entries: UserCorpusEntry[]) => MutateOutcome<T> | Promise<MutateOutcome<T>>,
): Promise<T> {
  const next = writeChain.then(async () => {
    // 链内读用裸读：读失败必须中止本次写入，绝不能拿空列表去覆盖已有词库。
    const entries = normalizeUserEntries((await withStorageTimeout(readRaw())).raw)
    const outcome = await fn(entries)
    if (outcome.persist !== null) {
      await withStorageTimeout(chrome.storage.local.set({ [USER_CORPUS_KEY]: outcome.persist }))
    }
    return outcome.value
  })
  // 链条本身永不 reject，避免一次失败（含超时）把后续写入全卡死。
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

/** 词条校验：短语形态、不破坏 md 格式、不与内置/用户层重复、未超上限。 */
export function validateUserEntryText(
  text: string,
  existing: readonly UserCorpusEntry[],
): string | null {
  const trimmed = normalizeEntryText(text)
  if (trimmed === '') return '先填一个词或短语'
  if (trimmed.length > MAX_ENTRY_LENGTH) return `太长了（最多 ${MAX_ENTRY_LENGTH} 字），信号应是短语而不是整句`
  // md 词库用「词|N」表达权重、用「#」表达注释：这两个字符进了词条，导出的 patch 合入 md 时
  // 会被解析器当权重覆盖或注释吞掉（本地能召回、入库却丢词，且双方都看不到报错）。
  if (trimmed.includes('|')) return '不能包含「|」字符（词库用它分隔权重）'
  if (trimmed.startsWith('#')) return '不能以「#」开头（词库把它当注释）'
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
  // 品类必须是构建期真的会采纳的分组：corpusFileMeta 认不出的名字（如 misc）建了 md 也不进词库，
  // 导出的 patch 会让维护者白忙一场。已知分组与新建 brands-* 都放行。
  if (category === '' || corpusFileMeta(`${category}.md`) === null) {
    return { ok: false, reason: '品类不合法：请从下拉里选，或用 brands- 前缀新建分组' }
  }
  const text = normalizeEntryText(input.text)
  // note 压成单行：脏数据里的换行会让导出 patch 出现非注释行（注入词条）。
  const note = (input.note ?? '').replace(/\s+/gu, ' ').trim().slice(0, 200)
  const defaults = categoryDefaults(category)
  try {
    // 校验与写入在同一条串行链里：并发同词添加只有一条能落库，另一条拿到「已存在」的拒绝原因；
    // 并发越过上限也会被链内的上限校验挡住（链外校验做不到这两点）。
    return await mutate<AddUserCorpusResult>((existing) => {
      const invalid = validateUserEntryText(text, existing)
      if (invalid !== null) return { persist: null, value: { ok: false, reason: invalid } }
      const persist = [
        ...existing,
        {
          text,
          category,
          kind: defaults.kind,
          weight: defaults.weight,
          note,
          createdAt: new Date().toISOString(),
          hitCount: 0,
          lastHitAt: '',
        },
      ]
      return { persist, value: { ok: true, entries: persist } }
    })
  } catch {
    return { ok: false, reason: '保存失败，请重试' }
  }
}

export interface BatchAddResult {
  ok: boolean
  /** 成功入库的词条数。 */
  added: number
  /** 跳过的词条（重复/非法/超长），带原因供 UI 展示。 */
  skipped: { text: string; reason: string }[]
  /** 整体失败原因（存储写失败/品类不合法等；逐条跳过不算整体失败）。 */
  reason?: string
}

/**
 * 批量补录（设置页「批量粘贴」与面板「漏检补录」共用）：一次写链步骤完成全部校验与落库，
 * 逐条给出去留原因；超过上限时按提交顺序截断（先贴的先入库）。
 */
export async function addUserCorpusEntries(input: {
  texts: readonly string[]
  category: string
  note?: string
}): Promise<BatchAddResult> {
  const category = input.category.trim()
  if (category === '' || corpusFileMeta(`${category}.md`) === null) {
    return { ok: false, added: 0, skipped: [], reason: '品类不合法：请从下拉里选，或用 brands- 前缀新建分组' }
  }
  const note = (input.note ?? '').replace(/\s+/gu, ' ').trim().slice(0, 200)
  const defaults = categoryDefaults(category)
  // 提交内部去重（同词贴两行只算一次），保持提交顺序。
  const seenInBatch = new Set<string>()
  const candidates: string[] = []
  const skipped: { text: string; reason: string }[] = []
  for (const raw of input.texts) {
    const text = normalizeEntryText(raw)
    if (text === '') continue
    if (seenInBatch.has(text)) {
      skipped.push({ text, reason: '本批次重复' })
      continue
    }
    seenInBatch.add(text)
    candidates.push(text)
  }
  if (candidates.length === 0) {
    return { ok: false, added: 0, skipped, reason: '没有可入库的词条' }
  }
  try {
    return await mutate<BatchAddResult>((existing) => {
      const persist = [...existing]
      let added = 0
      for (const text of candidates) {
        const invalid = validateUserEntryText(text, persist)
        if (invalid !== null) {
          skipped.push({ text, reason: invalid })
          continue
        }
        if (persist.length >= MAX_USER_ENTRIES) {
          skipped.push({ text, reason: `超出词条上限 ${MAX_USER_ENTRIES}` })
          continue
        }
        persist.push({
          text,
          category,
          kind: defaults.kind,
          weight: defaults.weight,
          note,
          createdAt: new Date().toISOString(),
          hitCount: 0,
          lastHitAt: '',
        })
        added += 1
      }
      if (added === 0) {
        return { persist: null, value: { ok: false, added: 0, skipped, reason: '没有新词条入库' } }
      }
      return { persist, value: { ok: true, added, skipped } }
    })
  } catch {
    return { ok: false, added: 0, skipped, reason: '保存失败，请重试' }
  }
}

/**
 * 命中统计：检测链路发现用户词条真的参与了召回时调用（一次写链步骤批量 +1）。
 * 失败静默——统计是锦上添花，绝不能让写库问题冒泡进检测主链路。
 */
export async function recordUserCorpusHits(texts: readonly string[]): Promise<void> {
  if (texts.length === 0) return
  const targets = new Set(texts.map((text) => normalizeEntryText(text)).filter((text) => text !== ''))
  if (targets.size === 0) return
  try {
    await mutate<UserCorpusEntry[]>((entries) => {
      let touched = false
      const persist = entries.map((entry) => {
        if (!targets.has(entry.text)) return entry
        touched = true
        return { ...entry, hitCount: entry.hitCount + 1, lastHitAt: new Date().toISOString() }
      })
      return touched ? { persist, value: persist } : { persist: null, value: entries }
    })
  } catch {
    // 静默：统计失败不影响任何用户可见行为。
  }
}

export async function removeUserCorpusEntry(text: string): Promise<UserCorpusEntry[]> {
  const target = text.trim()
  return mutate<UserCorpusEntry[]>((entries) => {
    const persist = entries.filter((entry) => entry.text !== target)
    return { persist, value: persist }
  })
}

export async function clearUserCorpus(): Promise<UserCorpusEntry[]> {
  return mutate<UserCorpusEntry[]>(() => ({ persist: [], value: [] }))
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
  return (await effectiveCorpusDetailed()).signals
}

export interface EffectiveCorpus {
  signals: CorpusSignal[]
  /** 用户词条文本集：命中统计需要区分来源（内置词条不计入用户统计）。 */
  userTexts: Set<string>
}

/** 同一次读取同时给出合并语料与用户词条来源标记，避免统计侧再读一遍存储。 */
export async function effectiveCorpusDetailed(): Promise<EffectiveCorpus> {
  const entries = await readUserCorpus()
  return {
    signals: mergeWithBuiltinCorpus(entries),
    userTexts: new Set(entries.map((entry) => entry.text)),
  }
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
