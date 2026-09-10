import { describe, expect, it } from 'vitest'
import { panelBackoffMs, panelVisibleNow } from './panel-state'

// 面板接线层显隐/退避纯规则的回归（评审补测：接线层 gate 与退避此前零覆盖）。

describe('panelVisibleNow（面板采集/显隐 gate）', () => {
  function state(overrides: Partial<Parameters<typeof panelVisibleNow>[0]> = {}) {
    return { ready: true, masterEnabled: true, pageEnabled: true, fullscreen: false, ...overrides }
  }

  it('全绿时可见', () => {
    expect(panelVisibleNow(state(), true)).toBe(true)
  })

  it('设置读回前（ready=false）不可见——panelEnabled=false 用户不闪现', () => {
    expect(panelVisibleNow(state({ ready: false }), true)).toBe(false)
  })

  it('总开关关 / 页内开关关 / 全屏 任一即不可见', () => {
    expect(panelVisibleNow(state({ masterEnabled: false }), true)).toBe(false)
    expect(panelVisibleNow(state({ pageEnabled: false }), true)).toBe(false)
    expect(panelVisibleNow(state({ fullscreen: true }), true)).toBe(false)
  })

  it('后台标签页不可见（懒采集可见性门）', () => {
    expect(panelVisibleNow(state(), false)).toBe(false)
  })
})

describe('panelBackoffMs（采集失败指数退避）', () => {
  it('失败次数递增：0→10s、1→20s、3→80s', () => {
    expect(panelBackoffMs(0)).toBe(10_000)
    expect(panelBackoffMs(1)).toBe(20_000)
    expect(panelBackoffMs(3)).toBe(80_000)
  })

  it('指数退避封顶（默认 5 分钟）', () => {
    expect(panelBackoffMs(4)).toBe(160_000)
    expect(panelBackoffMs(5)).toBe(300_000)
    expect(panelBackoffMs(20)).toBe(300_000)
  })

  it('负值收敛为 0 失败（10s）', () => {
    expect(panelBackoffMs(-3)).toBe(10_000)
  })

  it('base/max 可注入（测试友好）', () => {
    expect(panelBackoffMs(2, 1_000, 3_000)).toBe(3_000)
    expect(panelBackoffMs(1, 1_000, 10_000)).toBe(2_000)
  })
})