// @vitest-environment happy-dom
// 广告跳过状态机执行级测试：假 video 元素推进到 ad.start−3 断言横幅出现，
// 归零自动 seek 到 ad.end，跳过按「实际节省秒数」写入统计；
// 总开关/页内开关 gate 全部跳转逻辑；SPA 换 bvid 整体复位并重跑管线。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdSkipController, MARKS_SYNC_INTERVAL_MS } from '../modules/content/ad-skip-controller'
import type { AdSkipControllerDeps } from '../modules/content/ad-skip-controller'
import { ui } from '../modules/content/ui-state'
import { DEFAULT_SETTINGS } from '../modules/settings'
import type { AiSettings } from '../modules/settings'
import type { AdSegment, DetectAdsResult } from '../modules/ai/port'

const AD: AdSegment = { start: 100, end: 130, product_name: '某降噪耳机', ad_content: '', confidence: 0.9 }

function makeVideo(): HTMLVideoElement {
  return document.createElement('video')
}

/** happy-dom 的 rect 全是 0：测试里按元素逐个打桩。 */
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

interface Harness {
  video: HTMLVideoElement
  container: HTMLElement
  recordSkipped: ReturnType<typeof vi.fn>
  detectAds: ReturnType<typeof vi.fn>
  controller: AdSkipController
  setHref: (href: string) => void
}

async function makeHarness(overrides: {
  settings?: Partial<AiSettings>
  ads?: AdSegment[]
  bar?: HTMLElement | null
  /** 初始观看进度：默认 30s（跨过 15s 观看门槛，检测立即放行）。 */
  watchedSeconds?: number
} = {}): Promise<Harness> {
  const video = makeVideo()
  video.currentTime = overrides.watchedSeconds ?? 30
  const container = document.createElement('div')
  container.appendChild(video)
  document.body.appendChild(container)

  const settings: AiSettings = {
    ...DEFAULT_SETTINGS,
    apiUrl: 'https://llm.example/v1',
    model: 'm-1',
    apiKey: 'k-1',
    adSkipEnabled: true,
    ...overrides.settings,
  }
  let href = 'https://www.bilibili.com/video/BV1xx411c7mD/'
  const recordSkipped = vi.fn(async () => 30)
  const detectAds = vi.fn(
    async (): Promise<DetectAdsResult> => ({
      ads: overrides.ads ?? [AD],
      source: 'rag',
    }),
  )

  const deps: AdSkipControllerDeps = {
    timers: {
      setTimeout: (handler, ms) => setTimeout(handler, ms) as unknown as number,
      clearTimeout: (id) => clearTimeout(id),
      setInterval: (handler, ms) => setInterval(handler, ms) as unknown as number,
      clearInterval: (id) => clearInterval(id),
    },
    now: () => 0,
    player: {
      findVideo: () => video,
      waitForVideo: async () => video,
      findPlayerContainer: () => container,
      findProgressElement: () => overrides.bar ?? null,
    },
    pageHref: () => href,
    isDark: () => false,
    collectVideoMeta: async () => ({
      // 跟随 href：SPA 换视频时 bvid 变化，检测结果缓存按 bvid:cid 区分。
      bvid: href.includes('BV2xx411c7mE') ? 'BV2xx411c7mE' : 'BV1xx411c7mD',
      cid: 1,
      title: '横评',
      duration: 600,
    }),
    collectSubtitles: async () => [],
    collectDanmaku: async () => [{ time: 500, text: '恰饭' }],
    collectComments: async () => [{ top: { text: '广告明显' } }],
    readSettings: async () => settings,
    createBackend: (_s, _hooks) => ({ detectAds }),
    recordSkipped,
    openOptions: vi.fn(),
  }
  const controller = new AdSkipController(deps)
  return { video, container, recordSkipped, detectAds, controller, setHref: (next) => (href = next) }
}

/** 把挂起微任务全部结算（runPipeline 等 async 链不带定时器时足够）。 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  ui.banner.visible = false
  ui.chip.visible = false
  ui.vectorHint.visible = false
  ui.marks = []
  ui.marksBox = { visible: false, left: 0, top: 0, width: 0 }
  ui.ads = []
  ui.dark = false
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('AdSkipController 状态机', () => {
  it('推进到 ad.start−3：横幅出现带倒计时；归零自动 seek 到 ad.end；统计按实际节省记账', async () => {
    const { video, controller, recordSkipped, detectAds } = await makeHarness()
    await controller.start()
    expect(detectAds).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'smart', danmaku: [{ time: 500, text: '恰饭' }] }),
    )
    // 生产侧唯一写入点：检测结果镜像进 ui.ads（AI 面板合并打标的数据源）。
    expect(ui.ads).toEqual([AD])

    // 播放到 ad.start−3 秒：提示条出现，倒计时 3 起步。
    video.currentTime = 96.5
    controller.onTimeUpdate()
    expect(ui.banner.visible).toBe(false) // 还没进窗口
    video.currentTime = 97.2
    controller.onTimeUpdate()
    expect(ui.banner.visible).toBe(true)
    expect(ui.banner.copy).toBe('前方恰饭：某降噪耳机，3 秒后带你跳过～')
    expect(ui.banner.countdown).toBe(3)

    // 起跳瞬间：倒计时归零自动 seek 到段尾并记账（实际节省 = 130 − 100）。
    video.currentTime = 100
    await vi.advanceTimersByTimeAsync(150) // countdown tick → performSkip（seek + 250ms 验证 sleep）
    expect(video.currentTime).toBe(130)
    await vi.advanceTimersByTimeAsync(300) // seek 验证窗口
    await endpoint()
    expect(recordSkipped).toHaveBeenCalledWith('100:130', 30)
    expect(ui.chip.visible).toBe(true)
    expect(ui.chip.text).toBe('今天帮你省了 30 秒')
    expect(ui.banner.visible).toBe(false)
  })

  it('手动拖入段内（剩余 > 2s）：提示条出现并立即跳过，按剩余时长记账', async () => {
    const { video, controller, recordSkipped } = await makeHarness()
    await controller.start()

    video.currentTime = 110 // 段内，剩余 20s
    controller.onTimeUpdate()
    expect(ui.banner.visible).toBe(true)
    expect(ui.banner.countdown).toBeNull() // 手动态：静态环

    await vi.advanceTimersByTimeAsync(400) // MANUAL_BANNER_MS 后跳过
    expect(video.currentTime).toBe(130)
    await vi.advanceTimersByTimeAsync(300)
    await endpoint()
    expect(recordSkipped).toHaveBeenCalledWith('100:130', 20) // 中部拖入不按整段夸大
  })

  it('总开关关闭（storage 同步进来）gate 全部跳转逻辑；重开恢复', async () => {
    const { video, controller, recordSkipped } = await makeHarness()
    await controller.start()

    controller.syncMasterEnabled(false)
    expect(ui.marks).toEqual([])
    expect(ui.ads).toEqual([]) // 总开关关：广告镜像清空（不外露给 AI 面板）
    video.currentTime = 97.5
    controller.onTimeUpdate()
    expect(ui.banner.visible).toBe(false)
    video.currentTime = 110
    controller.onTimeUpdate()
    expect(ui.banner.visible).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(recordSkipped).not.toHaveBeenCalled()

    controller.syncMasterEnabled(true)
    video.currentTime = 97.5
    controller.onTimeUpdate()
    expect(ui.banner.visible).toBe(true)
  })

  it('页内快开关：非布尔 enabled 回 ok:false；关闭后不弹不跳，重开恢复', async () => {
    const { video, controller, recordSkipped } = await makeHarness()
    await controller.start()

    expect(controller.handleToggleMessage('yes')).toMatchObject({ ok: false })
    expect(
      controller.handleToggleMessage(false),
    ).toMatchObject({ ok: true, state: { pageEnabled: false } })
    expect(ui.ads).toEqual([]) // 页内开关关：广告镜像清空
    video.currentTime = 97.5
    controller.onTimeUpdate()
    expect(ui.banner.visible).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(recordSkipped).not.toHaveBeenCalled()

    expect(
      controller.handleToggleMessage(true),
    ).toMatchObject({ ok: true, state: { pageEnabled: true } })
    video.currentTime = 97.5
    controller.onTimeUpdate()
    expect(ui.banner.visible).toBe(true)
  })

  it('「这段想看」反悔出口：本段不再打扰', async () => {
    const { video, controller, recordSkipped } = await makeHarness()
    await controller.start()

    video.currentTime = 97.5
    controller.onTimeUpdate()
    expect(ui.banner.visible).toBe(true)
    ui.actions.onStay()
    expect(ui.banner.visible).toBe(false)

    video.currentTime = 101 // 越过起点后：不跳过
    controller.onTimeUpdate()
    await vi.advanceTimersByTimeAsync(500)
    expect(video.currentTime).toBe(101)
    expect(recordSkipped).not.toHaveBeenCalled()
  })

  it('SPA 换视频：bvid 变化复位（清标记/提示/页内反悔状态）并重跑管线', async () => {
    const { video, controller, detectAds, setHref } = await makeHarness()
    await controller.start()
    expect(detectAds).toHaveBeenCalledTimes(1)

    // 旧视频识别到恰饭段：横幅在播，且用户对旧段点了「这段想看」。
    video.currentTime = 97.5
    controller.onTimeUpdate()
    expect(ui.banner.visible).toBe(true)
    ui.actions.onStay()
    expect(ui.banner.visible).toBe(false)

    // SPA 换视频（pushState）：bvid 变化 → 复位并重跑。
    setHref('https://www.bilibili.com/video/BV2xx411c7mE/')
    controller.checkNavigation()
    expect(ui.banner.visible).toBe(false)
    expect(ui.marks).toEqual([])
    expect(ui.ads).toEqual([]) // SPA 复位：旧视频广告清空（不并入新视频时间线）
    await flushMicrotasks()
    expect(detectAds).toHaveBeenCalledTimes(2)
    expect(ui.ads).toEqual([AD]) // 新视频管线重跑后重新镜像

    // 新视频的同一时间点重新可弹（旧页内状态已复位）。
    video.currentTime = 97.5
    controller.onTimeUpdate()
    expect(ui.banner.visible).toBe(true)
  })
})

/** recordSkipped 矢量化结算：微任务 + 一次零延迟 timer。 */
async function endpoint(): Promise<void> {
  await flushMicrotasks()
  await vi.advanceTimersByTimeAsync(0)
}

describe('进度条广告标记跟随', () => {
  const PLAYER = { left: 100, top: 200, width: 800, height: 450 } // bottom = 650
  const BAR = { left: 120, top: 600, width: 760, height: 6 } // 中心线 y = 603

  async function marksHarness(bar: HTMLElement | null) {
    const harness = await makeHarness({ bar })
    if (bar) harness.container.appendChild(bar)
    stubRect(harness.container, PLAYER)
    if (bar) stubRect(bar, BAR)
    await harness.controller.start()
    return harness
  }

  it('标记盒锚在进度条本体实时几何上；条被收起（下移出界）需连续两拍确认才隐藏，滑回立即恢复', async () => {
    const bar = document.createElement('div')
    await marksHarness(bar)

    expect(ui.marks.length).toBe(1)
    // AD 100–130s / 总长 600s → 条内百分比定位；盒子 = 进度条相对播放器的几何。
    expect(ui.marks[0]).toMatchObject({ leftPct: (100 / 600) * 100, widthPct: (30 / 600) * 100 })
    expect(ui.marksBox).toEqual({ visible: true, left: 20, top: 403, width: 760 })

    // B 站控制层收起：进度条随动画移出播放器下界。淡出动画中间态只观察到一拍不可见——
    // 标记不许闪没（这正是"一直刷新闪烁"的来源），连续两拍确认后才隐藏。
    stubRect(bar, { left: 120, top: 700, width: 760, height: 6 })
    await vi.advanceTimersByTimeAsync(MARKS_SYNC_INTERVAL_MS)
    expect(ui.marksBox.visible).toBe(true)
    await vi.advanceTimersByTimeAsync(MARKS_SYNC_INTERVAL_MS)
    expect(ui.marksBox.visible).toBe(false)

    stubRect(bar, BAR)
    await vi.advanceTimersByTimeAsync(MARKS_SYNC_INTERVAL_MS)
    expect(ui.marksBox.visible).toBe(true)
  })

  it('防闪烁：几何取整写入，亚像素抖动不再产生新样式值', async () => {
    const bar = document.createElement('div')
    await marksHarness(bar)
    expect(ui.marksBox).toEqual({ visible: true, left: 20, top: 403, width: 760 })

    // 进度条几何抖动（播放中的常见现象）：取整后落回同一组值，不触发重渲染。
    stubRect(bar, { left: 120.3, top: 600.2, width: 759.7, height: 6.2 })
    await vi.advanceTimersByTimeAsync(MARKS_SYNC_INTERVAL_MS)
    expect(ui.marksBox).toEqual({ visible: true, left: 20, top: 403, width: 760 })
  })

  it('控制层 opacity 淡出：连续两拍确认后隐藏；淡入立即恢复', async () => {
    const bar = document.createElement('div')
    await marksHarness(bar)
    expect(ui.marksBox.visible).toBe(true)

    const styleSpy = vi
      .spyOn(window, 'getComputedStyle')
      .mockReturnValue({ display: '', visibility: '', opacity: '0' } as CSSStyleDeclaration)
    await vi.advanceTimersByTimeAsync(MARKS_SYNC_INTERVAL_MS)
    expect(ui.marksBox.visible).toBe(true) // 第一拍：动画中间态，不闪
    await vi.advanceTimersByTimeAsync(MARKS_SYNC_INTERVAL_MS)
    expect(ui.marksBox.visible).toBe(false)

    styleSpy.mockReturnValue({ display: '', visibility: '', opacity: '1' } as CSSStyleDeclaration)
    await vi.advanceTimersByTimeAsync(MARKS_SYNC_INTERVAL_MS)
    expect(ui.marksBox.visible).toBe(true)
    styleSpy.mockRestore()
  })

  it('找不到进度条本体：标记隐藏，不再退回按播放器高度猜的固定位置', async () => {
    await marksHarness(null)
    expect(ui.marks.length).toBe(1) // 数据在，但无处可挂
    expect(ui.marksBox.visible).toBe(false)
  })

  it('低置信段（极速匹配兜底 ≤0.6）：只上进度条标记，不弹横幅不自动跳', async () => {
    const LOW_CONF: AdSegment = { ...AD, confidence: 0.5 }
    const harness = await makeHarness({ ads: [LOW_CONF] })
    await harness.controller.start()

    expect(ui.ads).toEqual([LOW_CONF]) // 面板镜像保留全量（含低置信段）
    harness.video.currentTime = 97.5
    harness.controller.onTimeUpdate()
    expect(ui.banner.visible).toBe(false) // 不弹「带你跳过」横幅
    harness.video.currentTime = 110
    harness.controller.onTimeUpdate()
    expect(ui.banner.visible).toBe(false) // 拖入段内也不接管播放器
    await vi.advanceTimersByTimeAsync(1000)
    expect(harness.video.currentTime).toBe(110) // 没有自动 seek
  })

  it('高置信段（LLM 定界 ≥0.7）照常弹横幅并自动跳过', async () => {
    const harness = await makeHarness() // AD confidence 0.9
    await harness.controller.start()
    harness.video.currentTime = 97.5
    harness.controller.onTimeUpdate()
    expect(ui.banner.visible).toBe(true)
  })

  it('观看门槛：看不够 15 秒不花检测 token；继续观看后周期重试放行', async () => {
    const { video, controller, detectAds } = await makeHarness({ watchedSeconds: 0 })
    await controller.start()
    expect(detectAds).not.toHaveBeenCalled() // 秒退/划走的视频零 token

    video.currentTime = 16
    controller.retryIfNeeded()
    await flushMicrotasks()
    expect(detectAds).toHaveBeenCalledTimes(1)
  })

  it('结果缓存：同视频再次进入命中缓存（0 token），负缓存同样生效', async () => {
    const { controller, detectAds, setHref } = await makeHarness()
    await controller.start()
    await flushMicrotasks()
    expect(detectAds).toHaveBeenCalledTimes(1)
    expect(ui.ads).toEqual([AD])

    // SPA 换到新视频：照常检测（第二次调用）。
    setHref('https://www.bilibili.com/video/BV2xx411c7mE/')
    controller.checkNavigation()
    await flushMicrotasks()
    expect(detectAds).toHaveBeenCalledTimes(2)

    // 再回到旧视频：命中缓存，零检测调用，结果照常镜像。
    setHref('https://www.bilibili.com/video/BV1xx411c7mD/')
    controller.checkNavigation()
    await flushMicrotasks()
    expect(detectAds).toHaveBeenCalledTimes(2)
    expect(ui.ads).toEqual([AD])
    // 开销记录里能看到「缓存命中」这次零成本检测。
    const stored = (await chrome.storage.local.get(null)) as Record<string, unknown>
    const costs = stored.aiDetectCostLog as { path: string }[] | undefined
    expect(costs?.some((entry) => entry.path === 'cache')).toBe(true)
  })

  it('无广告结果也入负缓存：第二次进入同样零检测调用', async () => {
    const { controller, detectAds, setHref } = await makeHarness({ ads: [] })
    await controller.start()
    await flushMicrotasks()
    expect(detectAds).toHaveBeenCalledTimes(1)
    expect(ui.ads).toEqual([])

    setHref('https://www.bilibili.com/video/BV2xx411c7mE/')
    controller.checkNavigation()
    await flushMicrotasks()
    setHref('https://www.bilibili.com/video/BV1xx411c7mD/')
    controller.checkNavigation()
    await flushMicrotasks()
    expect(detectAds).toHaveBeenCalledTimes(2) // 第二次是 BV2 的检测；回到 BV1 走负缓存
    expect(ui.ads).toEqual([])
  })

  it('播放器几何变化（resize/滚动）后盒子重挂到新位置的进度条上', async () => {
    const bar = document.createElement('div')
    const harness = await marksHarness(bar)
    expect(ui.marksBox).toEqual({ visible: true, left: 20, top: 403, width: 760 })

    // 页面下滚 300px：播放器与进度条一起移动。
    stubRect(harness.container, { ...PLAYER, top: -100 })
    stubRect(bar, { ...BAR, top: 300 })
    await vi.advanceTimersByTimeAsync(MARKS_SYNC_INTERVAL_MS)
    expect(ui.marksBox).toEqual({ visible: true, left: 20, top: 403, width: 760 })
  })
})