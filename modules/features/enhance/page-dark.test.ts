// @vitest-environment happy-dom
// 页面深色跟随浏览器：亮暗应用/还原、live 翻转、stop 零残留、桥接属性。
import { beforeEach, describe, expect, it } from 'vitest'
import { createPageDarkRuntime, PAGE_DARK_CSS, PAGE_DARK_STYLE_ID } from './page-dark'

/** 可手动翻转的 matchMedia 替身。 */
function fakeMedia(initialDark: boolean) {
  let dark = initialDark
  const listeners = new Set<() => void>()
  return {
    matches: () => dark,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setDark(value: boolean) {
      dark = value
      for (const listener of [...listeners]) listener()
    },
  }
}

beforeEach(() => {
  document.head.innerHTML = ''
  document.documentElement.removeAttribute('data-bh-page-dark')
})

describe('createPageDarkRuntime', () => {
  it('浏览器深色 → 注入样式与桥接属性；浅色 → 不套深色', () => {
    const media = fakeMedia(true)
    const runtime = createPageDarkRuntime({ media })
    runtime.start()
    expect(document.getElementById(PAGE_DARK_STYLE_ID)).not.toBeNull()
    expect(document.documentElement.hasAttribute('data-bh-page-dark')).toBe(true)
    expect(document.getElementById(PAGE_DARK_STYLE_ID)?.textContent).toContain('invert(1)')
    runtime.stop()
    expect(document.getElementById(PAGE_DARK_STYLE_ID)).toBeNull()
    expect(document.documentElement.hasAttribute('data-bh-page-dark')).toBe(false)
  })

  it('live 翻转：深→浅立即还原，浅→深立即套上', () => {
    const media = fakeMedia(true)
    const runtime = createPageDarkRuntime({ media })
    runtime.start()
    media.setDark(false)
    expect(document.getElementById(PAGE_DARK_STYLE_ID)).toBeNull()
    expect(document.documentElement.hasAttribute('data-bh-page-dark')).toBe(false)
    media.setDark(true)
    expect(document.getElementById(PAGE_DARK_STYLE_ID)).not.toBeNull()
    runtime.stop()
  })

  it('stop 后再次 start 可复用（FeatureManager 重启路径）', () => {
    const media = fakeMedia(true)
    const runtime = createPageDarkRuntime({ media })
    runtime.start()
    runtime.stop()
    runtime.start()
    expect(document.getElementById(PAGE_DARK_STYLE_ID)).not.toBeNull()
    runtime.stop()
    expect(document.getElementById(PAGE_DARK_STYLE_ID)).toBeNull()
  })

  it('stop 解除监听：停止后浏览器翻转不再影响页面', () => {
    const media = fakeMedia(false)
    const runtime = createPageDarkRuntime({ media })
    runtime.start()
    runtime.stop()
    media.setDark(true)
    expect(document.getElementById(PAGE_DARK_STYLE_ID)).toBeNull()
    expect(document.documentElement.hasAttribute('data-bh-page-dark')).toBe(false)
  })

  it('配方含精确逆变换与播放器还原（pixel-exact 反色的关键）', () => {
    expect(PAGE_DARK_CSS).toContain('hue-rotate(-180deg) invert(1)')
    expect(PAGE_DARK_CSS).toContain('.bpx-player-container')
    expect(PAGE_DARK_CSS).toContain('filter: none')
  })
})
