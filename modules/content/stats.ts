// 成就统计的 storage.local 读写口（按日累计）；纯逻辑见 logic.ts，
// 本模块只做存取与容错：读失败按无记录处理、写失败返回 null（调用方不显示 chip）。

import { accumulateDailyStats, todayString } from './logic'
import type { DailyStats } from './logic'

const STATS_STORAGE_KEY = 'biliHelperAdSkipStats'

function isDailyStats(value: unknown): value is DailyStats {
  if (typeof value !== 'object' || value === null) return false
  const stats = value as Record<string, unknown>
  return (
    typeof stats.date === 'string' &&
    typeof stats.savedSeconds === 'number' &&
    Array.isArray(stats.skippedKeys)
  )
}

export async function readDailyStats(): Promise<DailyStats | null> {
  try {
    const result = await chrome.storage.local.get(STATS_STORAGE_KEY)
    const value = result[STATS_STORAGE_KEY]
    return isDailyStats(value) ? value : null
  } catch {
    return null
  }
}

/** 写串行链：recordSkipped 的读改写排他执行，并发记跳不丢累计。 */
let serializationChain: Promise<unknown> = Promise.resolve()

/** 记一次跳过（片段同日内只计一次）；成功返回今日累计秒数，失败返回 null。 */
export function recordSkipped(
  segmentKey: string,
  savedSeconds: number,
): Promise<number | null> {
  const task = async (): Promise<number | null> => {
    try {
      const previous = await readDailyStats()
      const next = accumulateDailyStats(previous, todayString(), segmentKey, savedSeconds)
      await chrome.storage.local.set({ [STATS_STORAGE_KEY]: next })
      return next.savedSeconds
    } catch {
      return null
    }
  }
  const result = serializationChain.then(task, task)
  serializationChain = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}