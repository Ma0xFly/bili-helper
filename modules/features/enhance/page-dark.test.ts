// @vitest-environment happy-dom
// 页面深色跟随浏览器：官方 cookie 优先（原生深色，不叠反色）、浏览器 scheme 兜底（自绘反色）、
// live 翻转、stop 零残留、桥接属性。
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
  it('浏览器深色（官方未开）→ 注入反色样式与桥接属性', () => {
    const media = fakeMedia(true)
    const runtime = createPageDarkRuntime({ media, officialDark: () => false })
    runtime.start()
    expect(document.getElementById(PAGE_DARK_STYLE_ID)).not.toBeNull()
    expect(document.documentElement.hasAttribute('data-bh-page-dark')).toBe(true)
    expect(document.getElementById(PAGE_DARK_STYLE_ID)?.textContent).toContain('invert(1)')
    runtime.stop()
    expect(document.getElementById(PAGE_DARK_STYLE_ID)).toBeNull()
    expect(document.documentElement.hasAttribute('data-bh-page-dark')).toBe(false)
  })

  it('官方深色开着（theme_style=dark）→ 只设桥接属性、绝不叠反色（B 站自己上色）', () => {
    const media = fakeMedia(false) // 浏览器是浅色也要跟着官方深色走
    const runtime = createPageDarkRuntime({ media, officialDark: () => true })
    runtime.start()
    expect(document.getElementById(PAGE_DARK_STYLE_ID)).toBeNull()
    expect(document.documentElement.hasAttribute('data-bh-page-dark')).toBe(true)
    // 官方开着时即便浏览器也深色，反色样式同样不出现（否则双重变暗）。
    media.setDark(true)
    expect(document.getElementById(PAGE_DARK_STYLE_ID)).toBeNull()
    runtime.stop()
    expect(document.documentElement.hasAttribute('data-bh-page-dark')).toBe(false)
  })

  it('轮询捕捉官方开关变化：cookie 开 → 反色让位原生；cookie 关 → 浏览器深色接回反色', () => {
    let official = false
    const media = fakeMedia(true)
    const holder: { poll?: () => void } = {}
    const runtime = createPageDarkRuntime({
      media,
      officialDark: () => official,
      pollMs: 5,
      setInterval: (handler) => {
        holder.poll = handler
        return 1
      },
      clearInterval: () => {},
    })
    runtime.start()
    expect(document.getElementById(PAGE_DARK_STYLE_ID)).not.toBeNull()
    official = true
    holder.poll?.()
    expect(document.getElementById(PAGE_DARK_STYLE_ID)).toBeNull()
    expect(document.documentElement.hasAttribute('data-bh-page-dark')).toBe(true)
    official = false
    holder.poll?.()
    expect(document.getElementById(PAGE_DARK_STYLE_ID)).not.toBeNull()
    runtime.stop()
  })

  it('live 翻转：深→浅立即还原，浅→深立即套上', () => {
    const media = fakeMedia(true)
    const runtime = createPageDarkRuntime({ media, officialDark: () => false })
    runtime.start()
    media.setDark(false)
    expect(document.getElementById(PAGE_DARK_STYLE_ID)).toBeNull()
    expect(document.documentElement.hasAttribute('data-bh-page-dark')).toBe(false)
    media.setDark(true)
    expect(document.getElementById(PAGE_DARK_STYLE_ID)).not.toBeNull()
    runtime.stop()
  })

  it('stop 后再次 start 可复用（FeatureManager 重启路径）；stop 解除监听', () => {
    const media = fakeMedia(false)
    const runtime = createPageDarkRuntime({ media, officialDark: () => false })
    runtime.start()
    runtime.stop()
    runtime.start()
    media.setDark(true)
    expect(document.getElementById(PAGE_DARK_STYLE_ID)).not.toBeNull()
    runtime.stop()
    media.setDark(false)
    expect(document.getElementById(PAGE_DARK_STYLE_ID)).toBeNull()
    expect(document.documentElement.hasAttribute('data-bh-page-dark')).toBe(false)
  })

  it('配方含精确逆变换与播放器还原（pixel-exact 反色的关键）', () => {
    expect(PAGE_DARK_CSS).toContain('hue-rotate(-180deg) invert(1)')
    expect(PAGE_DARK_CSS).toContain('.bpx-player-container')
    expect(PAGE_DARK_CSS).toContain('filter: none')
  })
})
