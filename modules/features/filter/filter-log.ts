// 拦截明细（filter-log）：videoFilter 命中的每条「视频 + 规则原因」落 storage.local，
// 设置页「拦截明细」面板展示——让八维度规则可审计可调参（计数只告诉你拦了多少，
// 明细才告诉你拦了什么、为什么）。隔离世界专用（主世界明细经 postMessage 回传，
// 由 features.content 接收后走这里）。
//
// 写入带 300ms 合批：滚动加载一批过滤几十条时不逐条读改写 storage。

import type { FilterLogEventPayload } from '../intercept/protocol'

export const FILTER_LOG_STORAGE_KEY = 'biliHelperFilterLog'
/** 明细条数上限（环形：最新的在前，超限截尾）。 */
export const FILTER_LOG_LIMIT = 100
/** 合批窗口：窗口内的多条明细一次落库。 */
export const FILTER_LOG_FLUSH_MS = 300

export interface FilterLogEntry {
  time: number
  bvid: string
  title: string
  reason: string
  surface: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 读侧归一：字段非法的条目丢弃（storage 可能被旧版本/手改变脏）。 */
export function normalizeFilterLogEntry(raw: unknown): FilterLogEntry | null {
  if (!isRecord(raw)) return null
  const bvid = typeof raw.bvid === 'string' ? raw.bvid : ''
  const reason = typeof raw.reason === 'string' ? raw.reason : ''
  if (bvid === '' || reason === '') return null
  return {
    time: typeof raw.time === 'number' && Number.isFinite(raw.time) ? raw.time : 0,
    bvid,
    title: typeof raw.title === 'string' ? raw.title : '',
    reason,
    surface: typeof raw.surface === 'string' ? raw.surface : '',
  }
}

export async function readFilterLog(): Promise<FilterLogEntry[]> {
  const result = (await chrome.storage.local.get(FILTER_LOG_STORAGE_KEY)) as Record<string, unknown>
  const raw = result[FILTER_LOG_STORAGE_KEY]
  if (!Array.isArray(raw)) return []
  const out: FilterLogEntry[] = []
  for (const item of raw) {
    const entry = normalizeFilterLogEntry(item)
    if (entry !== null) out.push(entry)
  }
  return out.slice(0, FILTER_LOG_LIMIT)
}

async function writeEntries(entries: FilterLogEntry[]): Promise<void> {
  const result = (await chrome.storage.local.get(FILTER_LOG_STORAGE_KEY)) as Record<string, unknown>
  const raw = result[FILTER_LOG_STORAGE_KEY]
  const existing = Array.isArray(raw) ? raw.map(normalizeFilterLogEntry).filter((e) => e !== null) : []
  const merged = [...entries, ...existing]
  // 去重：同 bvid+reason 的重复命中只留最新一条（同视频翻页反复出现不刷屏）。
  const seen = new Set<string>()
  const deduped: FilterLogEntry[] = []
  for (const entry of merged) {
    const key = `${entry.bvid}|${entry.reason}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(entry)
  }
  await chrome.storage.local.set({
    [FILTER_LOG_STORAGE_KEY]: deduped.slice(0, FILTER_LOG_LIMIT),
  })
}

let pending: FilterLogEntry[] = []
let flushTimer: ReturnType<typeof setTimeout> | undefined

/**
 * 追加明细（合批）：窗口内累积，一次落库。immediate=true 跳过窗口（测试/收尾用）。
 * 单条构造：事件回传（主世界）与 DOM 拦截器（隔离侧）共用。
 */
export function appendFilterLogEntries(
  events: FilterLogEventPayload[],
  options: { now?: () => number; immediate?: boolean } = {},
): void {
  if (events.length === 0) return
  const now = options.now ?? Date.now
  const entries = events
    .map((event) => normalizeFilterLogEntry({ ...event, time: now() }))
    .filter((entry): entry is FilterLogEntry => entry !== null)
  if (entries.length === 0) return
  // 到达序 → 最新在前（后续条目排在批次头部，整表恒为「新的在上」）。
  pending = [...entries.reverse(), ...pending]
  if (options.immediate) {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }
    void writeEntries(pending)
    pending = []
    return
  }
  if (flushTimer === undefined) {
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      const batch = pending
      pending = []
      void writeEntries(batch)
    }, FILTER_LOG_FLUSH_MS)
  }
}

/** 测试隔离：清空合批缓冲。 */
export function resetFilterLogBuffer(): void {
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer)
    flushTimer = undefined
  }
  pending = []
}

export async function clearFilterLog(): Promise<void> {
  resetFilterLogBuffer()
  await chrome.storage.local.remove(FILTER_LOG_STORAGE_KEY)
}
