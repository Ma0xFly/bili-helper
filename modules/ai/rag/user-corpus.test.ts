// 用户层广告语料的回归：读侧防御、增删校验、两层合并、md patch 导出，
// 以及最关键的联动不变量——用户加一个词，语料哈希必变（向量缓存据此自动全量重算）。
import { describe, expect, it, vi } from 'vitest'
import { rankWindowsByLexical } from './bm25'
import { AD_SIGNAL_CORPUS, corpusContentHash, corpusFileMeta, parseCorpusSource } from './corpus'
import {
  MAX_ENTRY_LENGTH,
  MAX_USER_ENTRIES,
  STORAGE_STEP_TIMEOUT_MS,
  USER_CORPUS_CATEGORIES,
  USER_CORPUS_KEY,
  addUserCorpusEntries,
  addUserCorpusEntry,
  clearUserCorpus,
  effectiveCorpus,
  effectiveCorpusDetailed,
  recordUserCorpusHits,
  exportUserCorpusMarkdown,
  mergeWithBuiltinCorpus,
  normalizeUserEntry,
  readUserCorpus,
  removeUserCorpusEntry,
  validateUserEntryText,
} from './user-corpus'

describe('normalizeUserEntry（读侧防御）', () => {
  it('合法条目按品类补全 kind 与默认权重', () => {
    expect(normalizeUserEntry({ text: ' 某新品牌 ', category: 'brands-digital' })).toMatchObject({
      text: '某新品牌',
      category: 'brands-digital',
      kind: 'brand',
      weight: 1,
      note: '',
    })
    expect(normalizeUserEntry({ text: '感谢金主催更', category: 'scripts' })).toMatchObject({
      kind: 'script',
      weight: 2,
    })
    expect(normalizeUserEntry({ text: '口令红包', category: 'deals' })).toMatchObject({
      kind: 'deal',
      weight: 2,
    })
  })

  it('脏数据丢弃：非对象/空词/超长/缺品类', () => {
    expect(normalizeUserEntry(null)).toBeNull()
    expect(normalizeUserEntry('词')).toBeNull()
    expect(normalizeUserEntry({ text: '   ', category: 'scripts' })).toBeNull()
    expect(normalizeUserEntry({ text: 'a'.repeat(MAX_ENTRY_LENGTH + 1), category: 'scripts' })).toBeNull()
    expect(normalizeUserEntry({ text: '某词' })).toBeNull()
  })

  it('非法 kind/weight 回落品类默认，weight 夹在 1..9', () => {
    expect(normalizeUserEntry({ text: '某词', category: 'scripts', kind: 'x', weight: -3 })).toMatchObject({
      kind: 'script',
      weight: 2,
    })
    expect(normalizeUserEntry({ text: '某词', category: 'scripts', weight: 99 })).toMatchObject({ weight: 9 })
  })

  it('未知品类（用户自建 brands-*）按品牌类兜底', () => {
    expect(normalizeUserEntry({ text: '某新茶饮', category: 'brands-tea' })).toMatchObject({
      kind: 'brand',
      weight: 1,
    })
  })
})

describe('readUserCorpus', () => {
  it('空存储返回空数组；脏条目过滤、重复词去重', async () => {
    expect(await readUserCorpus()).toEqual([])

    await chrome.storage.local.set({
      [USER_CORPUS_KEY]: [
        { text: '词A', category: 'scripts' },
        { text: '词A', category: 'deals' },
        { text: '', category: 'scripts' },
        'junk',
        { text: '词B', category: 'brands-games' },
      ],
    })
    const entries = await readUserCorpus()
    expect(entries.map((entry) => entry.text)).toEqual(['词A', '词B'])
  })
})

describe('addUserCorpusEntry', () => {
  it('添加成功并按品类落默认权重', async () => {
    const result = await addUserCorpusEntry({ text: '某新品牌', category: 'brands-digital', note: 'BV1xx 漏检' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({
      text: '某新品牌',
      category: 'brands-digital',
      kind: 'brand',
      weight: 1,
      note: 'BV1xx 漏检',
    })
    expect(await readUserCorpus()).toHaveLength(1)
  })

  it('拒绝：空词/超长/含竖线/含换行/品类非法', async () => {
    for (const bad of [
      { text: '  ', category: 'scripts' },
      { text: 'a'.repeat(MAX_ENTRY_LENGTH + 1), category: 'scripts' },
      { text: '词|3', category: 'scripts' },
      { text: '词\n第二行', category: 'scripts' },
      { text: '某词', category: '不合法品类' },
      { text: '某词', category: '' },
    ]) {
      const result = await addUserCorpusEntry(bad)
      expect(result.ok, JSON.stringify(bad)).toBe(false)
    }
    expect(await readUserCorpus()).toEqual([])
  })

  it('拒绝与内置词库重复的词（内置已有「恰饭」）', async () => {
    expect(AD_SIGNAL_CORPUS.some((signal) => signal.text === '恰饭')).toBe(true)
    const result = await addUserCorpusEntry({ text: '恰饭', category: 'scripts' })
    expect(result).toEqual({ ok: false, reason: '内置词库已经有这个词了' })
  })

  it('拒绝用户层内重复（含首尾空格差异）', async () => {
    await addUserCorpusEntry({ text: '某新品牌', category: 'brands-digital' })
    const result = await addUserCorpusEntry({ text: ' 某新品牌 ', category: 'brands-food' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('已经在你的词库里')
    expect(await readUserCorpus()).toHaveLength(1)
  })

  it('超出上限拒绝，且不破坏已有词条', async () => {
    const full = Array.from({ length: MAX_USER_ENTRIES }, (_, index) => ({
      text: `词${index}`,
      category: 'scripts',
      kind: 'script' as const,
      weight: 2,
      note: '',
      createdAt: new Date().toISOString(), hitCount: 0, lastHitAt: ''
    }))
    await chrome.storage.local.set({ [USER_CORPUS_KEY]: full })
    const result = await addUserCorpusEntry({ text: '再多一个', category: 'scripts' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('词库已满')
    expect(await readUserCorpus()).toHaveLength(MAX_USER_ENTRIES)
  })

  it('validateUserEntryText 独立可用（表单即时校验共用同一套规则）', () => {
    expect(validateUserEntryText('某新词', [])).toBeNull()
    expect(validateUserEntryText('', [])).toBe('先填一个词或短语')
    expect(validateUserEntryText('恰饭', [])).toContain('内置词库')
  })

  it('并发添加串行化：两条都落库，不互相覆盖', async () => {
    await Promise.all([
      addUserCorpusEntry({ text: '词A', category: 'scripts' }),
      addUserCorpusEntry({ text: '词B', category: 'deals' }),
    ])
    const entries = await readUserCorpus()
    expect(entries.map((entry) => entry.text).sort()).toEqual(['词A', '词B'])
  })

  it('并发添加同一个词：只有一条成功，另一条被拒（校验在串行链内复核）', async () => {
    const [first, second] = await Promise.all([
      addUserCorpusEntry({ text: '词A', category: 'scripts' }),
      addUserCorpusEntry({ text: '词A', category: 'scripts' }),
    ])
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1)
    const rejected = first.ok ? second : first
    if (!rejected.ok) expect(rejected.reason).toContain('已经在你的词库里')
    // 持久层也不能被污染：读侧去重只是遮羞布，存储里就该只有一条。
    const raw = (await chrome.storage.local.get(USER_CORPUS_KEY))[USER_CORPUS_KEY] as unknown[]
    expect(raw).toHaveLength(1)
  })

  it('并发越过上限：链内复核挡住，不击穿 MAX_USER_ENTRIES', async () => {
    const almostFull = Array.from({ length: MAX_USER_ENTRIES - 1 }, (_, index) => ({
      text: `词${index}`,
      category: 'scripts',
      kind: 'script' as const,
      weight: 2,
      note: '',
      createdAt: new Date().toISOString(), hitCount: 0, lastHitAt: ''
    }))
    await chrome.storage.local.set({ [USER_CORPUS_KEY]: almostFull })

    const results = await Promise.all(
      ['甲', '乙', '丙', '丁', '戊'].map((text) => addUserCorpusEntry({ text, category: 'scripts' })),
    )
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(await readUserCorpus()).toHaveLength(MAX_USER_ENTRIES)
  })

  it('拒绝以 # 开头的词（导出 patch 合入 md 时会被当注释吞掉）', async () => {
    const result = await addUserCorpusEntry({ text: '#某品牌话题#', category: 'scripts' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('#')
    expect(await readUserCorpus()).toEqual([])
  })

  it('品类白名单：未知分组拒绝（建了 md 也不会被构建采纳），brands- 前缀新建放行', async () => {
    const rejected = await addUserCorpusEntry({ text: '某词', category: 'misc' })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.reason).toContain('品类不合法')

    const accepted = await addUserCorpusEntry({ text: '某新茶饮', category: 'brands-tea' })
    expect(accepted.ok).toBe(true)
    if (accepted.ok) expect(accepted.entries[0]).toMatchObject({ kind: 'brand', weight: 1 })
  })

  it('note 换行被剥掉（写侧与读侧都防），导出 patch 不出现脱离注释的注入行', async () => {
    const result = await addUserCorpusEntry({
      text: '某新品牌',
      category: 'brands-digital',
      note: 'BV1xx\n恰饭 恶意换行注入',
    })
    expect(result.ok).toBe(true)
    const [entry] = await readUserCorpus()
    expect(entry?.note).toBe('BV1xx 恰饭 恶意换行注入')
    expect(exportUserCorpusMarkdown([entry!]).split('\n').filter((line) => line === '恰饭')).toEqual([])

    // 读侧同样防御：手改 storage 塞进带换行的 note，归一化后不留换行。
    await chrome.storage.local.set({
      [USER_CORPUS_KEY]: [{ text: '脏数据词', category: 'scripts', note: 'a\n injected' }],
    })
    const dirty = await readUserCorpus()
    expect(dirty[0]?.note).toBe('a injected')
  })
})

describe('removeUserCorpusEntry / clearUserCorpus', () => {
  it('按词删除，其余保留；清空后为空', async () => {
    await addUserCorpusEntry({ text: '词A', category: 'scripts' })
    await addUserCorpusEntry({ text: '词B', category: 'deals' })

    const afterRemove = await removeUserCorpusEntry('词A')
    expect(afterRemove.map((entry) => entry.text)).toEqual(['词B'])

    expect(await clearUserCorpus()).toEqual([])
    expect(await readUserCorpus()).toEqual([])
  })

  it('删除不存在的词不报错', async () => {
    await addUserCorpusEntry({ text: '词A', category: 'scripts' })
    expect(await removeUserCorpusEntry('没有这个词')).toHaveLength(1)
  })
})

describe('mergeWithBuiltinCorpus（两层合并）', () => {
  it('内置在前用户在后；text 撞车时内置优先（用户层改不了内置权重）', () => {
    const merged = mergeWithBuiltinCorpus([
      { text: '恰饭', category: 'scripts', kind: 'script', weight: 9, note: '', createdAt: 'x', hitCount: 0, lastHitAt: '' },
      { text: '某新品牌', category: 'brands-digital', kind: 'brand', weight: 1, note: '', createdAt: 'x', hitCount: 0, lastHitAt: '' },
    ])
    expect(merged).toHaveLength(AD_SIGNAL_CORPUS.length + 1)
    expect(merged.filter((signal) => signal.text === '恰饭')).toHaveLength(1)
    expect(merged.find((signal) => signal.text === '恰饭')?.weight).not.toBe(9)
    expect(merged.at(-1)?.text).toBe('某新品牌')
  })

  it('用户词条按品类分组追加（顺序稳定 → 哈希稳定）', () => {
    const entries = [
      { text: '词Z', category: 'scripts', kind: 'script' as const, weight: 2, note: '', createdAt: 'x', hitCount: 0, lastHitAt: '' },
      { text: '词A', category: 'brands-food', kind: 'brand' as const, weight: 1, note: '', createdAt: 'x', hitCount: 0, lastHitAt: '' },
      { text: '词Y', category: 'scripts', kind: 'script' as const, weight: 2, note: '', createdAt: 'x', hitCount: 0, lastHitAt: '' },
    ]
    const tail = mergeWithBuiltinCorpus(entries).slice(AD_SIGNAL_CORPUS.length)
    expect(tail.map((signal) => signal.text)).toEqual(['词A', '词Z', '词Y'])
    // 同样的输入两次合并结果一致（哈希不会无故变化触发向量重算）。
    expect(corpusContentHash(mergeWithBuiltinCorpus(entries))).toBe(
      corpusContentHash(mergeWithBuiltinCorpus(entries)),
    )
  })

  it('无用户词时与内置完全一致（顺序稳定 → 哈希稳定 → 不会无故重算向量）', () => {
    expect(mergeWithBuiltinCorpus([])).toEqual([...AD_SIGNAL_CORPUS])
    expect(corpusContentHash(mergeWithBuiltinCorpus([]))).toBe(corpusContentHash())
  })

  it('用户加一个词 → 语料哈希必变（向量缓存自动失效的依据）', () => {
    const before = corpusContentHash()
    const after = corpusContentHash(
      mergeWithBuiltinCorpus([
        { text: '某新品牌', category: 'brands-digital', kind: 'brand', weight: 1, note: '', createdAt: 'x', hitCount: 0, lastHitAt: '' },
      ]),
    )
    expect(after).not.toBe(before)
    expect(after).toMatch(/^[0-9a-f]{8}$/)
  })

  it('effectiveCorpus 读 storage 后合并；无用户词时等于内置', async () => {
    expect(await effectiveCorpus()).toEqual([...AD_SIGNAL_CORPUS])
    await addUserCorpusEntry({ text: '某新品牌', category: 'brands-digital' })
    const merged = await effectiveCorpus()
    expect(merged).toHaveLength(AD_SIGNAL_CORPUS.length + 1)
    expect(merged.at(-1)).toMatchObject({ text: '某新品牌', kind: 'brand', category: 'brands-digital' })
  })

  it('生效语料只带检索需要的四个字段（note/createdAt 不外泄）', async () => {
    await addUserCorpusEntry({ text: '某新品牌', category: 'brands-digital', note: 'BV1xx' })
    const merged = await effectiveCorpus()
    expect(merged.at(-1)).toEqual({
      text: '某新品牌',
      kind: 'brand',
      weight: 1,
      category: 'brands-digital',
    })
  })
})

describe('exportUserCorpusMarkdown（入库审核用 patch）', () => {
  it('空词库导出空串', () => {
    expect(exportUserCorpusMarkdown([])).toBe('')
  })

  it('按品类分组、权重非默认才写「词|N」、来源作为注释', () => {
    const patch = exportUserCorpusMarkdown([
      { text: '某新品牌', category: 'brands-digital', kind: 'brand', weight: 1, note: 'BV1xx 03:20 漏检', createdAt: 'x', hitCount: 0, lastHitAt: '' },
      { text: '某话术', category: 'scripts', kind: 'script', weight: 3, note: '', createdAt: 'x', hitCount: 0, lastHitAt: '' },
      { text: '某话术二', category: 'scripts', kind: 'script', weight: 2, note: '', createdAt: 'x', hitCount: 0, lastHitAt: '' },
    ])
    expect(patch).toContain('# 用户补录广告词库导出')
    // 分组按品类名排序：brands-digital 在 scripts 前。
    expect(patch.indexOf('# —— brands-digital.md ——')).toBeLessThan(
      patch.indexOf('# —— scripts.md ——'),
    )
    expect(patch).toContain('# 来源：BV1xx 03:20 漏检\n某新品牌')
    // scripts 默认权重 2：权重 3 写成「词|3」，权重 2 只写词。
    expect(patch).toContain('某话术|3')
    expect(patch).toContain('\n某话术二\n')
    expect(patch).not.toContain('某话术二|2')
  })

  it('导出的 patch 能被词库解析器原样吃回去（追加进 md 不丢词）', () => {
    const patch = exportUserCorpusMarkdown([
      { text: '某新品牌', category: 'brands-digital', kind: 'brand', weight: 1, note: 'BV1xx', createdAt: 'x', hitCount: 0, lastHitAt: '' },
      { text: '某话术', category: 'scripts', kind: 'script', weight: 3, note: '', createdAt: 'x', hitCount: 0, lastHitAt: '' },
    ])
    const digitalMeta = corpusFileMeta('brands-digital.md')
    const scriptsMeta = corpusFileMeta('scripts.md')
    if (!digitalMeta || !scriptsMeta) throw new Error('品类元信息缺失')

    // 整份 patch 直接喂解析器：注释与分组标题被跳过，词条与权重原样还原。
    const parsed = parseCorpusSource(patch, digitalMeta)
    expect(parsed.map((signal) => signal.text)).toEqual(['某新品牌', '某话术'])
    expect(parsed[1]?.weight).toBe(3) // 「词|3」覆盖生效，不受文件默认权重影响

    // 只取 scripts 段落追加进 scripts.md 的情形同样还原。
    const scriptsBlock = patch.slice(patch.indexOf('# —— scripts.md ——'))
    expect(parseCorpusSource(scriptsBlock, scriptsMeta).map((signal) => signal.text)).toEqual([
      '某话术',
    ])
  })

  it('可选品类来自内置词库分组', () => {
    expect(USER_CORPUS_CATEGORIES).toContain('scripts')
    expect(USER_CORPUS_CATEGORIES).toContain('brands-games')
    expect([...USER_CORPUS_CATEGORIES].sort()).toEqual([...USER_CORPUS_CATEGORIES])
  })
})

describe('写入失败要让用户知道（不静默假装成功）', () => {
  it('storage 写失败：添加返回红灯，删除把错误抛给调用方', async () => {
    const setMock = chrome.storage.local.set as unknown as ReturnType<typeof vi.fn>

    setMock.mockRejectedValueOnce(new Error('quota exceeded'))
    expect(await addUserCorpusEntry({ text: '某新词', category: 'scripts' })).toEqual({
      ok: false,
      reason: '保存失败，请重试',
    })
    expect(await readUserCorpus()).toEqual([])

    // 写失败之后链路不被卡死：下一次写入照常成功。
    expect((await addUserCorpusEntry({ text: '某新词', category: 'scripts' })).ok).toBe(true)

    setMock.mockRejectedValueOnce(new Error('quota exceeded'))
    await expect(removeUserCorpusEntry('某新词')).rejects.toThrow()
    expect(await readUserCorpus()).toHaveLength(1)
  })

  it('链内读失败：中止写入并报错，绝不把「读不到」当「没有」而清空词库', async () => {
    await addUserCorpusEntry({ text: '旧词A', category: 'scripts' })
    await addUserCorpusEntry({ text: '旧词B', category: 'deals' })
    expect(await readUserCorpus()).toHaveLength(2)

    const getMock = chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>
    const setMock = chrome.storage.local.set as unknown as ReturnType<typeof vi.fn>
    // 前面两次成功添加已经写过 storage，这里只关心读失败之后有没有再写。
    setMock.mockClear()

    // 删除时恰逢一次瞬时读失败：如果拿空列表去做读改写，两条旧词会被整库覆盖掉。
    getMock.mockRejectedValueOnce(new Error('context invalidated'))
    await expect(removeUserCorpusEntry('旧词A')).rejects.toThrow()
    expect(setMock).not.toHaveBeenCalled()

    getMock.mockRejectedValueOnce(new Error('context invalidated'))
    expect(await addUserCorpusEntry({ text: '新词', category: 'scripts' })).toEqual({
      ok: false,
      reason: '保存失败，请重试',
    })

    // 存储恢复后词库完好无损：两条旧词都还在，没有被静默清空。
    expect((await readUserCorpus()).map((entry) => entry.text)).toEqual(['旧词A', '旧词B'])
  })

  it('存储操作挂起：超时按失败处理，且写链自愈（后续写入照常）', async () => {
    vi.useFakeTimers()
    try {
      const getMock = chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>
      getMock.mockImplementationOnce(() => new Promise(() => {})) // 永不落定
      const pending = addUserCorpusEntry({ text: '某词', category: 'scripts' })
      await vi.advanceTimersByTimeAsync(STORAGE_STEP_TIMEOUT_MS + 50)
      expect(await pending).toEqual({ ok: false, reason: '保存失败，请重试' })
    } finally {
      vi.useRealTimers()
    }

    // 挂起的那一步不能把整条写链带走：恢复后立刻可写。
    expect((await addUserCorpusEntry({ text: '某词', category: 'scripts' })).ok).toBe(true)
    expect(await readUserCorpus()).toHaveLength(1)
  })
})

describe('不可见字符（零宽空格/BOM）', () => {
  it('纯零宽「空词」被拒；带零宽的内置词照样撞去重', async () => {
    expect((await addUserCorpusEntry({ text: '\u200b\ufeff', category: 'scripts' })).ok).toBe(false)
    expect(await readUserCorpus()).toEqual([])

    const sneaky = await addUserCorpusEntry({ text: '恰饭\u200b', category: 'scripts' })
    expect(sneaky.ok).toBe(false)
    if (!sneaky.ok) expect(sneaky.reason).toContain('内置词库')
  })

  it('入库前剥掉零宽字符（否则精确匹配永远命中不了字幕）', async () => {
    const result = await addUserCorpusEntry({ text: '\ufeff某新品牌\u200b', category: 'brands-digital' })
    expect(result.ok).toBe(true)
    expect((await readUserCorpus())[0]?.text).toBe('某新品牌')
  })

  it('读侧同样剥离：手改 storage 塞进带零宽的词条，归一化后不留', async () => {
    await chrome.storage.local.set({
      [USER_CORPUS_KEY]: [{ text: '\u200b脏数据词\u200b', category: 'scripts' }],
    })
    expect((await readUserCorpus())[0]?.text).toBe('脏数据词')
  })
})

describe('补录端到端生效（storage → 生效语料 → 词表召回）', () => {
  it('补录前召回不到的窗口，补录后立即被召回', async () => {
    const windows = [
      { text: '这期节目由某新品牌独家冠名，我们来看看它的表现' },
      { text: '接下来是普通内容，讲讲今天的天气和心情' },
    ]
    // 补录前：这个词不在任何一层语料里，窗口 0 无信号命中。
    expect(rankWindowsByLexical(windows, await effectiveCorpus()).some((hit) => hit.index === 0)).toBe(
      false,
    )

    await addUserCorpusEntry({ text: '某新品牌', category: 'brands-digital' })

    const ranked = rankWindowsByLexical(windows, await effectiveCorpus())
    expect(ranked.map((hit) => hit.index)).toContain(0)
    expect(ranked[0]?.index).toBe(0)
  })
})


describe('addUserCorpusEntries（批量补录）', () => {
  it('一次入库多词；重复/超长逐条给出去留原因', async () => {
    await addUserCorpusEntry({ text: '已有词', category: 'scripts' })
    const result = await addUserCorpusEntries({
      texts: ['词A', '词B', '已有词', '词A', '  ', 'x'.repeat(MAX_ENTRY_LENGTH + 1)],
      category: 'deals',
      note: '批量测试',
    })
    expect(result.ok).toBe(true)
    expect(result.added).toBe(2)
    expect(result.skipped.map((item) => item.reason)).toEqual(
      expect.arrayContaining(['这个词已经在你的词库里了', '本批次重复']),
    )
    const stored = await readUserCorpus()
    expect(stored.map((entry) => entry.text)).toEqual(['已有词', '词A', '词B'])
    expect(stored[1]).toMatchObject({ category: 'deals', note: '批量测试', hitCount: 0, lastHitAt: '' })
  })

  it('品类不合法整体拒绝；空列表拒绝', async () => {
    const bad = await addUserCorpusEntries({ texts: ['词A'], category: 'misc' })
    expect(bad).toMatchObject({ ok: false, added: 0 })
    const empty = await addUserCorpusEntries({ texts: ['  ', ''], category: 'scripts' })
    expect(empty).toMatchObject({ ok: false, added: 0 })
  })

  it('越过上限按提交顺序截断', async () => {
    const filler = Array.from({ length: MAX_USER_ENTRIES - 1 }, (_, i) => `填充${i}`)
    await addUserCorpusEntries({ texts: filler, category: 'scripts' })
    const result = await addUserCorpusEntries({ texts: ['倒数第二', '最后一个'], category: 'scripts' })
    expect(result.added).toBe(1)
    expect(result.skipped.some((item) => item.reason.includes('词库已满'))).toBe(true)
    await clearUserCorpus()
  })
})

describe('recordUserCorpusHits（命中统计）', () => {
  it('命中词条 +1 并记录时间；未命中词条不动', async () => {
    await addUserCorpusEntries({ texts: ['词A', '词B'], category: 'scripts' })
    await recordUserCorpusHits(['词A'])
    await recordUserCorpusHits(['词A'])
    const stored = await readUserCorpus()
    const a = stored.find((entry) => entry.text === '词A')
    const b = stored.find((entry) => entry.text === '词B')
    expect(a?.hitCount).toBe(2)
    expect(a?.lastHitAt).not.toBe('')
    expect(b?.hitCount).toBe(0)
    expect(b?.lastHitAt).toBe('')
    await clearUserCorpus()
  })

  it('不存在的词/空列表静默（不抛错、不写库）', async () => {
    await expect(recordUserCorpusHits(['没有这个词'])).resolves.toBeUndefined()
    await expect(recordUserCorpusHits([])).resolves.toBeUndefined()
  })
})

describe('effectiveCorpusDetailed（来源标记）', () => {
  it('userTexts 只含用户词条；signals 与 effectiveCorpus 同源', async () => {
    await addUserCorpusEntry({ text: '某新品牌词', category: 'brands-digital' })
    const detailed = await effectiveCorpusDetailed()
    expect(detailed.userTexts.has('某新品牌词')).toBe(true)
    expect(detailed.userTexts.has('恰饭')).toBe(false)
    expect(detailed.signals).toEqual(await effectiveCorpus())
    await clearUserCorpus()
  })
})
