// @vitest-environment happy-dom
// 页面深色跟随浏览器（官方主题写入器）：写 theme_style=dark / 只擦自己写的、
// 用户手动开的官方深色不代擦、运行中翻转的可见页刷新与节流、stop 清理。
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createPageDarkRuntime,
  OWN_COOKIE_MARKER_KEY,
  RELOAD_MIN_INTERVAL_MS,
} from './page-dark'

/** 订阅可达的封装：记录 subscribe 的回调，setDark 时触发。 */
function makeControllableHarness({
  initialCookie = 'light' as 'dark' | 'light',
  initialOwn = false,
  dark = false,
} = {}) {
  let cookie = initialCookie
  let own = initialOwn
  let darkNow = dark
  let reloadCount = 0
  let clock = 1_000_000
  let listener: (() => void | Promise<void>) | null = null
  const runtime = createPageDarkRuntime({
    doc: document,
    media: {
      matches: () => darkNow,
      subscribe: (cb) => {
        listener = cb
        return () => {
          listener = null
        }
      },
    },
    readOfficial: () => (cookie === 'dark' ? 'dark' : 'light'),
    writeOfficial: (value) => {
      cookie = value ? 'dark' : 'light'
    },
    readOwnMarker: async () => own,
    writeOwnMarker: async (value) => {
      own = value
    },
    reload: () => {
      reloadCount += 1
    },
    now: () => clock,
  })
  return {
    runtime,
    async start() {
      await runtime.start()
    },
    async stop() {
      runtime.stop()
    },
    async setDark(value: boolean) {
      darkNow = value
      await listener?.()
    },
    get cookie() {
      return cookie
    },
    get own() {
      return own
    },
    get reloadCount() {
      return reloadCount
    },
    tick(ms: number) {
      clock += ms
    },
  }
}

describe('createPageDarkRuntime（官方主题写入器）', () => {
  it('start 时浏览器深色 → 写 theme_style=dark 并标记自己写的；浅色 → 不动官方 cookie', async () => {
    const h = makeControllableHarness({ dark: true })
    await h.start()
    expect(h.cookie).toBe('dark')
    expect(h.own).toBe(true)
    expect(h.reloadCount).toBe(0) // start 永不刷新
    await h.stop()

    const h2 = makeControllableHarness({ dark: false })
    await h2.start()
    expect(h2.cookie).toBe('light')
    expect(h2.own).toBe(false)
    await h2.stop()
  })

  it('运行中 浏览器浅→深：写 cookie + 可见页刷新一次；深→浅：只擦自己写的并刷新', async () => {
    const h = makeControllableHarness({ dark: false })
    await h.start()
    await h.setDark(true)
    expect(h.cookie).toBe('dark')
    expect(h.own).toBe(true)
    expect(h.reloadCount).toBe(1) // 可见页翻转 → 刷新生效官方主题

    h.tick(RELOAD_MIN_INTERVAL_MS + 1)
    await h.setDark(false)
    expect(h.cookie).toBe('light')
    expect(h.own).toBe(false)
    expect(h.reloadCount).toBe(2)
    await h.stop()
  })

  it('刷新节流：RELOAD_MIN_INTERVAL_MS 内的连续翻转只刷一次', async () => {
    const h = makeControllableHarness({ dark: false })
    await h.start()
    await h.setDark(true)
    expect(h.reloadCount).toBe(1)
    await h.setDark(false)
    expect(h.reloadCount).toBe(1) // 60s 内不二刷
    h.tick(RELOAD_MIN_INTERVAL_MS + 1)
    await h.setDark(true)
    expect(h.reloadCount).toBe(2)
    await h.stop()
  })

  it('用户手动开的官方深色（无标记）不被代擦', async () => {
    const h = makeControllableHarness({ initialCookie: 'dark', initialOwn: false, dark: false })
    await h.start()
    expect(h.cookie).toBe('dark') // 保持用户的选择
    await h.setDark(true)
    expect(h.own).toBe(false) // 我们没写就不标记
    expect(h.reloadCount).toBe(0) // cookie 已是 dark，无翻转可刷
    await h.stop()
  })

  it('stop 后翻转不再写 cookie（cookie 是用户可见的站级状态，stop 不动它）', async () => {
    const h = makeControllableHarness({ dark: true })
    await h.start()
    await h.stop()
    const before = h.cookie
    await h.setDark(false)
    expect(h.cookie).toBe(before)
  })

  it('标记键名稳定（session 存储跨标签页共享）', () => {
    expect(OWN_COOKIE_MARKER_KEY).toBe('biliHelperPageDarkOwnCookie')
  })
})
