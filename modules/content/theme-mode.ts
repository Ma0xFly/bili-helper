// 页内浮层亮暗解析单点：三种主题模式（跟随B站 / 跟随系统 / 定时自动）在此收敛为
// 一个纯函数，调用方（content 接线层）只注入三个来源探针——B 站夜间检测、系统
// prefers-color-scheme、当前时刻。放纯函数是为了跨午夜窗口与模式回退可以脱离
// 浏览器单测（真机回归是 E2E 的事）。

import type { ThemeMode } from '../settings'

export interface ThemePreference {
  themeMode: ThemeMode
  nightStart: string
  nightEnd: string
}

export interface ThemeDarkSources {
  /** mode=bilibili 时的 B 站夜间检测（现行实现：class 标记优先、body 亮度兜底）。 */
  bilibiliDark: () => boolean
  /** mode=system 时的系统亮暗（matchMedia），取值惰性——只有该模式才查询。 */
  systemDark: () => boolean
  /** mode=schedule 时的当前时刻（分钟数，0–1439），惰性。 */
  nowMinutes: () => number
}

/** 「HH:MM」→ 当日分钟数；格式非法返回 null（读取侧已归一，这里兜防御性回退）。 */
export function parseTimeOfDay(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * 夜间窗口判定：start–end 内为夜（窗口外为日），跨午夜（start > end）合法——
 * 「19:00–07:00」在 23:00 与 02:00 都判夜。起止相等视为非法窗口（不做 24h 夜）。
 */
export function isInNightWindow(nowMinutes: number, start: string, end: string): boolean {
  const startMin = parseTimeOfDay(start)
  const endMin = parseTimeOfDay(end)
  if (startMin === null || endMin === null || startMin === endMin) return false
  if (startMin < endMin) return nowMinutes >= startMin && nowMinutes < endMin
  return nowMinutes >= startMin || nowMinutes < endMin
}

/**
 * 亮暗唯一事实源：按主题模式选来源。schedule 窗口非法（相等/坏值）时回退 B 站
 * 检测——亮暗永远有答案，不因配置错误变盲。
 */
export function resolveThemeDark(
  preference: ThemePreference,
  sources: ThemeDarkSources,
): boolean {
  if (preference.themeMode === 'system') return sources.systemDark()
  if (preference.themeMode === 'schedule') {
    // 非法窗口（坏值/两端相等）没有可靠答案，回 B 站检测——亮暗永远有结论。
    const startMin = parseTimeOfDay(preference.nightStart)
    const endMin = parseTimeOfDay(preference.nightEnd)
    if (startMin === null || endMin === null || startMin === endMin) {
      return sources.bilibiliDark()
    }
    return isInNightWindow(sources.nowMinutes(), preference.nightStart, preference.nightEnd)
  }
  return sources.bilibiliDark()
}
