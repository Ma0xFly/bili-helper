// 主题模式解析单测：三种模式的来源选择、跨午夜窗口、非法窗口回退。
// 纯函数——不碰 matchMedia/Date，来源全部注入。
import { describe, expect, it } from 'vitest'
import { isInNightWindow, parseTimeOfDay, resolveThemeDark } from './theme-mode'

describe('parseTimeOfDay', () => {
  it('合法 HH:MM → 分钟数', () => {
    expect(parseTimeOfDay('19:00')).toBe(19 * 60)
    expect(parseTimeOfDay('07:05')).toBe(7 * 60 + 5)
    expect(parseTimeOfDay('00:00')).toBe(0)
    expect(parseTimeOfDay('23:59')).toBe(23 * 60 + 59)
  })

  it('非法输入 → null（含越界、缺冒号、空串）', () => {
    expect(parseTimeOfDay('24:00')).toBeNull()
    expect(parseTimeOfDay('7:00')).toBeNull()
    expect(parseTimeOfDay('19:60')).toBeNull()
    expect(parseTimeOfDay('')).toBeNull()
    expect(parseTimeOfDay('1900')).toBeNull()
  })
})

describe('isInNightWindow', () => {
  it('正常顺序窗口（含边界：含 start、不含 end）', () => {
    expect(isInNightWindow(19 * 60, '19:00', '07:00')).toBe(true)
    expect(isInNightWindow(6 * 60 + 59, '19:00', '07:00')).toBe(true)
    expect(isInNightWindow(7 * 60, '19:00', '07:00')).toBe(false)
    expect(isInNightWindow(12 * 60, '19:00', '07:00')).toBe(false)
  })

  it('跨午夜窗口：23:00 与 02:00 都是夜', () => {
    expect(isInNightWindow(23 * 60, '19:00', '07:00')).toBe(true)
    expect(isInNightWindow(2 * 60, '19:00', '07:00')).toBe(true)
    expect(isInNightWindow(12 * 60, '19:00', '07:00')).toBe(false)
  })

  it('起止相等或非法 → 永远非夜（调用方回退 B 站检测）', () => {
    expect(isInNightWindow(23 * 60, '19:00', '19:00')).toBe(false)
    expect(isInNightWindow(23 * 60, 'abc', '07:00')).toBe(false)
  })
})

describe('resolveThemeDark', () => {
  const sources = (options: {
    bilibili?: boolean
    system?: boolean
    now?: number
  }) => ({
    bilibiliDark: () => options.bilibili ?? false,
    systemDark: () => options.system ?? false,
    nowMinutes: () => options.now ?? 12 * 60,
  })

  it('bilibili 模式：只看 B 站检测', () => {
    expect(resolveThemeDark({ themeMode: 'bilibili', nightStart: '19:00', nightEnd: '07:00' }, sources({ bilibili: true, system: false, now: 3 * 60 }))).toBe(true)
    expect(resolveThemeDark({ themeMode: 'bilibili', nightStart: '19:00', nightEnd: '07:00' }, sources({ bilibili: false, system: true, now: 23 * 60 }))).toBe(false)
  })

  it('system 模式：只看系统亮暗', () => {
    expect(resolveThemeDark({ themeMode: 'system', nightStart: '19:00', nightEnd: '07:00' }, sources({ system: true, bilibili: false }))).toBe(true)
    expect(resolveThemeDark({ themeMode: 'system', nightStart: '19:00', nightEnd: '07:00' }, sources({ system: false, bilibili: true }))).toBe(false)
  })

  it('schedule 模式：窗口内为夜、窗口外为日', () => {
    const preference = { themeMode: 'schedule' as const, nightStart: '19:00', nightEnd: '07:00' }
    expect(resolveThemeDark(preference, sources({ now: 23 * 60, bilibili: true }))).toBe(true)
    expect(resolveThemeDark(preference, sources({ now: 2 * 60, bilibili: true }))).toBe(true)
    expect(resolveThemeDark(preference, sources({ now: 12 * 60, bilibili: true }))).toBe(false)
    expect(resolveThemeDark(preference, sources({ now: 12 * 60, bilibili: false }))).toBe(false)
  })

  it('schedule 窗口非法（相等/坏值）→ 回退 B 站检测', () => {
    expect(resolveThemeDark({ themeMode: 'schedule', nightStart: '19:00', nightEnd: '19:00' }, sources({ now: 12 * 60, bilibili: true }))).toBe(true)
    expect(resolveThemeDark({ themeMode: 'schedule', nightStart: 'abc', nightEnd: '07:00' }, sources({ now: 12 * 60, bilibili: false }))).toBe(false)
  })
})
