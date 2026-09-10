// @vitest-environment happy-dom
// 广告跳过状态机执行级测试：假 video 元素推进到 ad.start−3 断言横幅出现，
// 归零自动 seek 到 ad.end，跳过按「实际节省秒数」写入统计；
// 总开关/页内开关 gate 全部跳转逻辑；SPA 换 bvid 整体复位并重跑管线。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdSkipController } from '../modules/content/ad-skip-controller'
import type { AdSkipControllerDeps } from '../modules/content/ad-skip-controller'
import { ui } from '../modules/content/ui-state'
import { DEFAULT_SETTINGS } from '../modules/settings'
import type { AiSettings } from '../modules/settings'
import type { AdSegment, DetectAdsResult } from '../modules/ai/port'

const AD: AdSegment = { start: 100, end: 130, product_name: '某降噪耳机', ad_content: '', confidence: 0.9 }

function makeVideo(): HTMLVideoElement {
  return document.createElement('video')
}

interface Harness {
  video: HTMLVideoElement
  recordSkipped: ReturnType<typeof vi.fn>
  detectAds: ReturnType<typeof vi.fn>
  controller: AdSkipController
  setHref: (href: string) => void
}

async function makeHarness(overrides: {
  settings?: Partial<AiSettings>
  ads?: AdSegment[]
} = {}): Promise<Harness> {
  const video = makeVideo()
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
      findProgressElement: () => null,
    },
    pageHref: () => href,
    isDark: () => false,
    collectVideoMeta: async () => ({ bvid: 'BV1xx411c7mD', cid: 1, title: '横评', duration: 600 }),
    collectSubtitles: async () => [],
    collectDanmaku: async () => [{ time: 500, text: '恰饭' }],
    collectComments: async () => [{ top: { text: '广告明显' } }],
    readSettings: async () => settings,
    createBackend: (_s, _hooks) => ({ detectAds }),
    recordSkipped,
    openOptions: vi.fn(),
  }
  const controller = new AdSkipController(deps)
  return { video, recordSkipped, detectAds, controller, setHref: (next) => (href = next) }
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