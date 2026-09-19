// @vitest-environment happy-dom
// 标记盒几何跟踪器测试：多消费方互踩防护（isRelevant=false 整拍跳过不写盒子）、
// 隐藏两拍确认/恢复立即、几何取整写入、start/stop 生命周期。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarksBoxTracker } from './marks-box'
import { ui } from './ui-state'

const PLAYER = { left: 0, top: 0, width: 800, height: 450 } // bottom = 450
const BAR = { left: 20, top: 400, width: 760, height: 6 } // 中心线 y = 403

function stubRect(
  el: Element,
  r: { left: number; top: number; width: number; height: number },
): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    left: r.left,
    top: r.top,
    width: r.width,
    height: r.height,
    right: r.left + r.width,
    bottom: r.top + r.height,
    x: r.left,
    y: r.top,
    toJSON: () => ({}),
  } as DOMRect)
}

function makeDeps(overrides: { relevant?: boolean } = {}) {
  const video = document.createElement('video')
  const container = document.createElement('div')
  container.appendChild(video)
  document.body.appendChild(container)
  const bar = document.createElement('div')
  container.appendChild(bar)
  stubRect(container, PLAYER)
  stubRect(bar, BAR)
  const timers = {
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id),
    setInterval: (handler: () => void, ms: number) => setInterval(handler, ms) as unknown as number,
    clearInterval: (id: number) => clearInterval(id),
  }
  let relevant = overrides.relevant ?? true
  const tracker = new MarksBoxTracker({
    timers,
    player: {
      findPlayerContainer: () => container,
      findProgressElement: () => bar,
    },
    getVideo: () => video,
    isRelevant: () => relevant,
    intervalMs: 250,
  })
  return {
    tracker,
    bar,
    container,
    setRelevant: (value: boolean) => (relevant = value),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  ui.marksBox = { visible: false, left: 0, top: 0, width: 0 }
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('MarksBoxTracker', () => {
  it('相关时：盒子锚进度条几何（取整）；start 立即同步一拍', () => {
    const { tracker } = makeDeps()
    tracker.start()
    expect(ui.marksBox).toEqual({ visible: true, left: 20, top: 403, width: 760 })
    tracker.stop()
  })

  it('不相关的消费方整拍跳过：不写盒子（归属其他跟踪器），恢复相关后继续同步', () => {
    const { tracker, setRelevant } = makeDeps({ relevant: false })
    tracker.start()
    expect(ui.marksBox.visible).toBe(false) // start 的立即拍被 isRelevant 拦下

    // 另一个「消费方」把盒子置为可见（章节标记在管）。
    ui.marksBox = { visible: true, left: 20, top: 403, width: 760 }
    vi.advanceTimersByTime(1000)
    expect(ui.marksBox.visible).toBe(true) // 不相关消费方没有把它拍灭

    setRelevant(true)
    vi.advanceTimersByTime(250)
    expect(ui.marksBox).toEqual({ visible: true, left: 20, top: 403, width: 760 })
    tracker.stop()
  })

  it('收起（进度条移出播放器）连续两拍确认才隐藏；滑回立即恢复', () => {
    const { tracker, bar } = makeDeps()
    tracker.start()
    expect(ui.marksBox.visible).toBe(true)

    stubRect(bar, { left: 20, top: 700, width: 760, height: 6 })
    vi.advanceTimersByTime(250)
    expect(ui.marksBox.visible).toBe(true) // 第一拍：不闪
    vi.advanceTimersByTime(250)
    expect(ui.marksBox.visible).toBe(false)

    stubRect(bar, BAR)
    vi.advanceTimersByTime(250)
    expect(ui.marksBox.visible).toBe(true)
    tracker.stop()
  })

  it('stop 后不再同步（interval 清理），盒子状态留给接管方', () => {
    const { tracker, bar } = makeDeps()
    tracker.start()
    expect(ui.marksBox.visible).toBe(true)
    tracker.stop()
    stubRect(bar, { left: 20, top: 700, width: 760, height: 6 })
    vi.advanceTimersByTime(1000)
    expect(ui.marksBox.visible).toBe(true) // 已停：没人再动盒子
  })

  it('找不到视频元素：走隐藏确认路径', () => {
    const video = document.createElement('video')
    const container = document.createElement('div')
    container.appendChild(video)
    document.body.appendChild(container)
    stubRect(container, PLAYER)
    let hasVideo = true
    const timers = {
      setTimeout: (h: () => void, ms: number) => setTimeout(h, ms) as unknown as number,
      clearTimeout: (id: number) => clearTimeout(id),
      setInterval: (h: () => void, ms: number) => setInterval(h, ms) as unknown as number,
      clearInterval: (id: number) => clearInterval(id),
    }
    const tracker = new MarksBoxTracker({
      timers,
      player: { findPlayerContainer: () => container, findProgressElement: () => null },
      getVideo: () => (hasVideo ? video : null),
      isRelevant: () => true,
    })
    tracker.start()
    expect(ui.marksBox.visible).toBe(false) // 无进度条：首拍进入隐藏确认
    hasVideo = false
    expect(tracker.running).toBe(true)
    tracker.stop()
  })
})
