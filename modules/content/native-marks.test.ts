// @vitest-environment happy-dom
// 原生进度条标记注入测试：注入/重注入/dispose 零残留、渲染几何、回退标志、悬停提示。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveNativeBar, NativeMarksInjector, NATIVE_MARK_COLORS } from './native-marks'
import { ui } from './ui-state'
import type { AdMarkState, ChapterMarkState } from './ui-state'
import type { TimerApi } from './marks-box'

/** 手动驱动的水钟（悬停保活时延用）。 */
function fakeTimers(): TimerApi & { flush(ms: number): void; now: number } {
  let now = 0
  const jobs: { at: number; run: () => void }[] = []
  return {
    get now() {
      return now
    },
    setTimeout(handler, ms) {
      const id = jobs.length + 1
      jobs.push({ at: now + ms, run: handler })
      return id
    },
    clearTimeout(id) {
      const index = Number(id) - 1
      if (jobs[index]) jobs.splice(index, 1)
    },
    setInterval(handler) {
      const id = 10_000 + jobs.length
      jobs.push({ at: Number.POSITIVE_INFINITY, run: handler })
      void id
      return 0
    },
    clearInterval() {},
    flush(ms) {
      now += ms
      for (const job of [...jobs]) {
        if (job.at <= now) {
          job.run()
          jobs.splice(jobs.indexOf(job), 1)
        }
      }
    },
  }
}

const AD: AdMarkState = {
  key: 'ad:1',
  leftPct: 20,
  widthPct: 10,
  productName: '某麦片',
  range: '03:00-04:00',
  done: false,
}
const CHAPTER: ChapterMarkState = {
  key: 'official:60',
  leftPct: 60,
  start: 60,
  label: '高潮',
  timeText: '01:00',
  source: 'official',
}

/** 原生条结构（探针实测：bar > schedule-wrap + point-wrap + thumb…）。 */
function nativeBar(): { bar: HTMLElement; wrap: HTMLElement; pointWrap: HTMLElement } {
  const bar = document.createElement('div')
  bar.className = 'bpx-player-progress'
  const wrap = document.createElement('div')
  wrap.className = 'bpx-player-progress-schedule-wrap'
  const pointWrap = document.createElement('div')
  pointWrap.className = 'bpx-player-progress-point-wrap'
  bar.append(wrap, pointWrap)
  return { bar, wrap, pointWrap }
}

function makeInjector(overrides: Partial<ConstructorParameters<typeof NativeMarksInjector>[0]> = {}) {
  const timers = fakeTimers()
  const injector = new NativeMarksInjector({
    timers,
    player: {
      findPlayerContainer: () => playerContainer,
      findProgressElement: () => null,
    },
    getVideo: () => video,
    getMarks: () => ui.marks,
    getChapters: () => ui.chapterMarks,
    getDark: () => ui.dark,
    ...overrides,
  })
  return { injector, timers }
}

const video = document.createElement('video')
let playerContainer: HTMLElement

beforeEach(() => {
  document.body.innerHTML = ''
  document.head.innerHTML = ''
  ui.marks = []
  ui.chapterMarks = []
  ui.nativeMarksActive = false
  ui.barHover = { active: false, left: 0, bottom: 0, chapter: null, ad: null }
  playerContainer = document.createElement('div')
  playerContainer.className = 'bpx-player-container'
  document.body.append(playerContainer)
})

describe('resolveNativeBar', () => {
  it('容器里直接命中整条；条内候选一律归一到整条；孤儿填充上溯到父层', () => {
    const { bar } = nativeBar()
    const wrapper = document.createElement('div')
    wrapper.append(bar)
    expect(resolveNativeBar(null, wrapper)).toBe(bar)
    const schedule = document.createElement('div')
    schedule.className = 'bpx-player-progress-schedule'
    const current = document.createElement('div')
    current.className = 'bpx-player-progress-schedule-current'
    schedule.append(current)
    bar.append(schedule)
    // 条内的轨道/填充候选：注入宿主都是整条（geometry 稳定、不随播放生长）。
    expect(resolveNativeBar(current, null)).toBe(bar)
    expect(resolveNativeBar(schedule, null)).toBe(bar)
    expect(resolveNativeBar(bar, null)).toBe(bar)
    // 不在整条内的孤儿填充（异常 DOM）：退而求其次用父层承载。
    const orphan = document.createElement('div')
    const orphanFill = document.createElement('div')
    orphanFill.className = 'bpx-player-progress-schedule-current'
    orphan.append(orphanFill)
    expect(resolveNativeBar(orphanFill, null)).toBe(orphan)
    // 无关元素：不猜，返回 null 走回退形态。
    expect(resolveNativeBar(document.createElement('div'), null)).toBeNull()
  })
})

describe('NativeMarksInjector', () => {
  it('有标记时注入容器与样式：广告底段 + 章节刻度按百分比落位，插在 B 站标记层之前', () => {
    const { bar, pointWrap } = nativeBar()
    playerContainer.append(bar)
    ui.marks = [AD]
    ui.chapterMarks = [CHAPTER]
    const { injector } = makeInjector()
    injector.sync()

    const container = bar.querySelector('.bhx-marks')
    expect(container).not.toBeNull()
    // 紧贴在 B 站官方标记层（point-wrap）之前：官方标记绘制在本扩展标记之上。
    expect(container!.nextElementSibling).toBe(pointWrap)
    const ad = container!.querySelector('.bhx-ad') as HTMLElement
    expect(ad.style.left).toBe('20%')
    expect(ad.style.width).toBe('10%')
    const tick = container!.querySelector('.bhx-tick') as HTMLElement
    expect(tick.style.left).toBe('60%')
    expect(ui.nativeMarksActive).toBe(true)
    expect(document.getElementById('bili-helper-native-marks-style')).not.toBeNull()
    injector.dispose()
  })

  it('亮暗属性随 ui.dark 切换（data-bhx-dark）', () => {
    const { bar } = nativeBar()
    playerContainer.append(bar)
    ui.marks = [AD]
    const { injector } = makeInjector()
    ui.dark = false
    injector.sync()
    expect(bar.querySelector('.bhx-marks')?.hasAttribute('data-bhx-dark')).toBe(false)
    ui.dark = true
    injector.sync()
    expect(bar.querySelector('.bhx-marks')?.hasAttribute('data-bhx-dark')).toBe(true)
    injector.dispose()
  })

  it('标记清空 → 摘除注入，零残留，回退标志复位', () => {
    const { bar } = nativeBar()
    playerContainer.append(bar)
    ui.marks = [AD]
    const { injector } = makeInjector()
    injector.sync()
    expect(bar.querySelector('.bhx-marks')).not.toBeNull()
    ui.marks = []
    ui.chapterMarks = []
    injector.sync()
    expect(bar.querySelector('.bhx-marks')).toBeNull()
    expect(document.getElementById('bili-helper-native-marks-style')).toBeNull()
    expect(ui.nativeMarksActive).toBe(false)
    injector.dispose()
  })

  it('B 站重建进度条（旧条被移除）→ 心跳后重注入新条', () => {
    const { bar } = nativeBar()
    playerContainer.append(bar)
    ui.marks = [AD]
    const { injector, timers } = makeInjector()
    injector.sync()
    expect(bar.querySelector('.bhx-marks')).not.toBeNull()

    const replacement = nativeBar()
    playerContainer.append(replacement.bar)
    bar.remove()
    injector.sync() // 心跳拍：发现旧容器失联，重建注入。
    expect(replacement.bar.querySelector('.bhx-marks')).not.toBeNull()
    expect(ui.nativeMarksActive).toBe(true)
    void timers
    injector.dispose()
  })

  it('找不到原生条 → 不注入、nativeMarksActive=false（Shadow 层回退接管），且只打一次回退日志', () => {
    ui.marks = [AD]
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const { injector } = makeInjector()
      injector.sync()
      injector.sync() // 心跳拍重复失败：日志只此一次。
      expect(document.querySelector('.bhx-marks')).toBeNull()
      expect(ui.nativeMarksActive).toBe(false)
      const fallbackLogs = infoSpy.mock.calls
        .map((args) => args.join(' '))
        .filter((text) => text.includes('回退浮层标记形态'))
      expect(fallbackLogs).toHaveLength(1)
      injector.dispose()
    } finally {
      infoSpy.mockRestore()
    }
  })

  it('dispose 后无任何注入残留', () => {
    const { bar } = nativeBar()
    playerContainer.append(bar)
    ui.marks = [AD]
    ui.chapterMarks = [CHAPTER]
    const { injector } = makeInjector()
    injector.sync()
    injector.dispose()
    expect(bar.querySelector('.bhx-marks')).toBeNull()
    expect(document.getElementById('bili-helper-native-marks-style')).toBeNull()
    expect(ui.nativeMarksActive).toBe(false)
  })

  describe('悬停提示', () => {
    function stubRects(bar: HTMLElement, width = 900): void {
      playerContainer.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width, height: 600, right: width, bottom: 600 }) as DOMRect
      bar.getBoundingClientRect = () =>
        ({ left: 0, top: 580, width, height: 4, right: width, bottom: 584 }) as DOMRect
    }

    it('悬停广告段 → 提示带商品名与「不是广告」入口', () => {
      const { bar } = nativeBar()
      playerContainer.append(bar)
      stubRects(bar)
      ui.marks = [AD]
      const { injector } = makeInjector()
      injector.sync()
      bar.dispatchEvent(new MouseEvent('mousemove', { clientX: 900 * 0.25, clientY: 582 }))
      expect(ui.barHover.active).toBe(true)
      expect(ui.barHover.ad?.key).toBe('ad:1')
      expect(ui.barHover.chapter).toBeNull()
      expect(ui.barHover.left).toBe(Math.round(900 * 0.25))
      injector.endHover()
      expect(ui.barHover.active).toBe(false)
      injector.dispose()
    })

    it('悬停章节刻度附近 → 提示章节；远离两者不提示', () => {
      const { bar } = nativeBar()
      playerContainer.append(bar)
      stubRects(bar)
      ui.chapterMarks = [CHAPTER]
      const { injector } = makeInjector()
      injector.sync()
      // 60% 处 ±8px 容差内。
      bar.dispatchEvent(new MouseEvent('mousemove', { clientX: 900 * 0.6 + 6, clientY: 582 }))
      expect(ui.barHover.active).toBe(true)
      expect(ui.barHover.chapter?.key).toBe('official:60')
      // 远离章节与广告：提示收起。
      bar.dispatchEvent(new MouseEvent('mousemove', { clientX: 900 * 0.45, clientY: 582 }))
      expect(ui.barHover.active).toBe(false)
      injector.dispose()
    })

    it('指针离开进度条 → 保活期内不闪没，到期收起', () => {
      const { bar } = nativeBar()
      playerContainer.append(bar)
      stubRects(bar)
      ui.marks = [AD]
      const { injector, timers } = makeInjector()
      injector.sync()
      bar.dispatchEvent(new MouseEvent('mousemove', { clientX: 900 * 0.25, clientY: 582 }))
      expect(ui.barHover.active).toBe(true)
      bar.dispatchEvent(new MouseEvent('mouseleave'))
      injector.keepHover() // 指针进入提示卡：取消隐藏。
      timers.flush(1_000)
      expect(ui.barHover.active).toBe(true)
      injector.endHover() // 指针离开提示卡：立即收起。
      expect(ui.barHover.active).toBe(false)
      injector.dispose()
    })

    it('同位置重复 mousemove 不重复写提示态（渲染节流）', () => {
      const { bar } = nativeBar()
      playerContainer.append(bar)
      stubRects(bar)
      ui.marks = [AD]
      const { injector } = makeInjector()
      injector.sync()
      const event = new MouseEvent('mousemove', { clientX: 900 * 0.25, clientY: 582 })
      bar.dispatchEvent(event)
      const first = { ...ui.barHover }
      bar.dispatchEvent(event)
      expect(ui.barHover).toEqual(first)
      injector.dispose()
    })
  })
})

describe('NATIVE_MARK_COLORS', () => {
  it('与 overlay.css token 同源（亮暗成对，theme-tokens 测试对账）', () => {
    expect(NATIVE_MARK_COLORS.adFillLight).toBe('#ff8fb1')
    expect(NATIVE_MARK_COLORS.adFillDark).toBe('#ffa0bd')
    expect(NATIVE_MARK_COLORS.tickOfficialLight).toBe('#7c5cfc')
    expect(NATIVE_MARK_COLORS.tickOfficialDark).toBe('#9c85ff')
    expect(NATIVE_MARK_COLORS.tickAiLight).toBe('#b47cf5')
    expect(NATIVE_MARK_COLORS.tickAiDark).toBe('#c29bf8')
  })
})
