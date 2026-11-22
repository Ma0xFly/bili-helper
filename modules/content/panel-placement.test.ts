// @vitest-environment happy-dom
// 落位/浮动 dock 状态机测试：happy-dom 驱动 tick——模式判定（video/list/none）、
// 视频页三重门与失位重插、列表页锚点+跳评论门、dock 触发/退场/与内联交接、
// dock 时钟仅 surface 变化复位、复位契约。DOM 用真实选择器搭建（默认查询面直查）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDefaultPanelPlacementDom,
  isWatchlaterSurfaceHref,
  PanelPlacementController,
  PANEL_COMMENTS_TIMEOUT_MS,
  PANEL_DOCK_FALLBACK_MS,
  PANEL_DOCK_ID,
  PANEL_HOST_CLASS,
  PANEL_HOST_ID,
  type PanelPlacementDeps,
} from './panel-placement'

// happy-dom 默认 readyState=interactive：就绪门（门 1）按用例显式钉住，测后还原原型 getter。
function setReadyState(value: 'loading' | 'complete'): void {
  Object.defineProperty(document, 'readyState', { configurable: true, get: () => value })
}

function restoreReadyState(): void {
  delete (document as unknown as { readyState?: unknown }).readyState
}

interface FixtureEnv {
  nowMs: number
  href: string
  surface: boolean
  video: HTMLVideoElement | null
  shown: boolean
  mounts: number
}

const activeControllers: PanelPlacementController[] = []

function makeFixture(overrides: Partial<PanelPlacementDeps> = {}) {
  const host = document.createElement('div') // WXT shadow 宿主替身
  host.style.display = 'none'
  const env: FixtureEnv = {
    nowMs: 1_000_000,
    href: 'https://www.bilibili.com/',
    surface: false,
    video: null,
    shown: true,
    mounts: 0,
  }
  const controller = new PanelPlacementController({
    timers: {
      setTimeout: (handler, ms) => setTimeout(handler, ms) as unknown as number,
      clearTimeout: (id) => clearTimeout(id),
      setInterval: (handler, ms) => setInterval(handler, ms) as unknown as number,
      clearInterval: (id) => clearInterval(id),
    },
    now: () => env.nowMs,
    doc: () => document,
    pageHref: () => env.href,
    dom: createDefaultPanelPlacementDom(() => document),
    findVideo: () => env.video,
    panelShown: () => env.shown,
    isWatchlaterSurface: () => env.surface,
    getHost: () => host,
    mountPanelApp: () => {
      env.mounts += 1
    },
    ...overrides,
  })
  activeControllers.push(controller)
  return { controller, host, env }
}

function buildVideoPage(): { column: HTMLElement; up: HTMLElement } {
  const up = document.createElement('div')
  up.className = 'up-panel-container'
  const column = document.createElement('div')
  column.className = 'right-container-inner'
  column.appendChild(up)
  document.body.appendChild(column)
  return { column, up }
}

function addCommentsProbe(): void {
  const app = document.createElement('div')
  app.id = 'commentapp'
  app.appendChild(document.createElement('bili-comments'))
  document.body.appendChild(app)
}

function buildListPage(): HTMLElement {
  const left = document.createElement('div')
  left.className = 'playlist-container--left'
  const anchor = document.createElement('div')
  anchor.className = 'playlist-container--right'
  anchor.appendChild(document.createElement('ul'))
  document.body.appendChild(left)
  document.body.appendChild(anchor)
  return anchor
}

/** 右栏插入一次子节点（触发静止观察器；happy-dom 的 MutationObserver 微任务派发）。 */
async function mutateColumn(column: Element): Promise<void> {
  column.appendChild(document.createElement('span'))
  await Promise.resolve()
  await Promise.resolve()
}

const VIDEO_HREF = 'https://www.bilibili.com/video/BV1xx411c7mD/'
const LIST_HREF = 'https://www.bilibili.com/list/watchlater?oid=1&bvid=BV1ZLht69E7b'
const HOME_WATCHLATER_HREF = 'https://www.bilibili.com/?page=WatchLater&bvid=BV1ZLht69E7b'

beforeEach(() => {
  setReadyState('complete')
})

afterEach(() => {
  for (const controller of activeControllers) controller.dispose()
  activeControllers.length = 0
  document.body.innerHTML = ''
  restoreReadyState()
  vi.useRealTimers()
})

describe('模式判定', () => {
  it('视频页：落位 up 卡之后（wrapper 父为右栏，宿主移入，首次落位挂应用）', () => {
    const { controller, host, env } = makeFixture()
    env.href = VIDEO_HREF
    const { column, up } = buildVideoPage()
    addCommentsProbe()
    controller.tick() // 锚点起始（就绪门计时起点）
    expect(controller.debugState().mode).toBe('video')
    expect(document.getElementById(PANEL_HOST_ID)).toBeNull()
    env.nowMs += 700
    controller.tick()
    const wrapper = document.getElementById(PANEL_HOST_ID)
    expect(wrapper).not.toBeNull()
    expect(wrapper!.parentElement).toBe(column)
    expect(wrapper!.previousElementSibling).toBe(up)
    expect(wrapper!.className).toBe(PANEL_HOST_CLASS)
    expect(wrapper!.contains(host)).toBe(true)
    expect(host.style.display).toBe('')
    expect(env.mounts).toBe(1)
  })

  it('列表页：锚 .playlist-container--right 内部最前（播放列表上方）', () => {
    const { controller, env } = makeFixture()
    env.href = LIST_HREF
    const anchor = buildListPage()
    controller.tick()
    expect(controller.debugState().mode).toBe('list')
    env.nowMs += 700
    controller.tick()
    const wrapper = document.getElementById(PANEL_HOST_ID)
    expect(wrapper).not.toBeNull()
    expect(wrapper!.parentElement).toBe(anchor)
    expect(anchor.firstElementChild).toBe(wrapper)
    expect(env.mounts).toBe(1)
  })

  it('pathname 非 /list/ 但存在 .playlist-container--left（列表形态）同样走列表模式', () => {
    const { controller, env } = makeFixture()
    env.href = 'https://www.bilibili.com/'
    buildListPage()
    controller.tick()
    expect(controller.debugState().mode).toBe('list')
    env.nowMs += 700
    controller.tick()
    expect(document.getElementById(PANEL_HOST_ID)).not.toBeNull()
  })

  it('普通首页（无已知容器）：休眠——无落位、无 dock、宿主隐藏、不挂应用', () => {
    const { controller, host, env } = makeFixture()
    env.href = 'https://www.bilibili.com/'
    env.video = document.createElement('video') // 首页也可能命中播放元素，仍须休眠
    document.body.appendChild(env.video)
    env.nowMs += 20_000
    controller.tick()
    expect(controller.debugState().mode).toBe('none')
    expect(document.getElementById(PANEL_HOST_ID)).toBeNull()
    expect(document.getElementById(PANEL_DOCK_ID)).toBeNull()
    expect(host.style.display).toBe('none')
    expect(env.mounts).toBe(0)
  })
})

describe('视频页三重门', () => {
  it('门 1：整页未 load 完成（readyState≠complete）不落位', () => {
    setReadyState('loading')
    const { controller, env } = makeFixture()
    env.href = VIDEO_HREF
    buildVideoPage()
    addCommentsProbe()
    controller.tick()
    expect(document.getElementById(PANEL_HOST_ID)).toBeNull()
    setReadyState('complete')
    controller.tick() // 锚点起始
    env.nowMs += 700
    controller.tick()
    expect(document.getElementById(PANEL_HOST_ID)).not.toBeNull()
  })

  it('门 2：评论区未挂载时不落位，8s 超时兜底放行', () => {
    const { controller, env } = makeFixture()
    env.href = VIDEO_HREF
    buildVideoPage() // 无评论探针
    controller.tick()
    env.nowMs += 1_000
    controller.tick() // 静止窗口已过（≥600ms），但评论门未过（1s < 8s）
    expect(document.getElementById(PANEL_HOST_ID)).toBeNull()
    env.nowMs += PANEL_COMMENTS_TIMEOUT_MS // 共 9s > 8s：评论门超时兜底
    controller.tick()
    expect(document.getElementById(PANEL_HOST_ID)).not.toBeNull()
  })

  it('门 2：评论探针中途挂出立即放行（不等超时）', () => {
    const { controller, env } = makeFixture()
    env.href = VIDEO_HREF
    buildVideoPage()
    controller.tick()
    env.nowMs += 2_000
    addCommentsProbe()
    controller.tick() // commentsSeen 置位 + 静止 2s ≥ 600ms
    expect(document.getElementById(PANEL_HOST_ID)).not.toBeNull()
  })

  it('门 3：右栏持续变动则一直不落位，12s 静止超时兜底放行', async () => {
    const { controller, env } = makeFixture()
    env.href = VIDEO_HREF
    const { column } = buildVideoPage()
    addCommentsProbe()
    controller.tick() // 锚点起始
    for (let elapsed = 1_000; elapsed <= 11_000; elapsed += 1_000) {
      env.nowMs += 1_000
      await mutateColumn(column) // quietAt 持续刷新 → 600ms 静止窗口永不满足
      controller.tick()
      expect(
        document.getElementById(PANEL_HOST_ID),
        `${elapsed}ms 时右栏仍在变动，不应落位`,
      ).toBeNull()
    }
    env.nowMs += 1_500 // 距锚点起始 >12s
    await mutateColumn(column)
    controller.tick() // 静止超时兜底放行
    expect(document.getElementById(PANEL_HOST_ID)).not.toBeNull()
  })

  it('宽屏模式：插在 #danmukuBox 之后', () => {
    const { controller, env } = makeFixture()
    env.href = VIDEO_HREF
    const { column, up } = buildVideoPage()
    const danmaku = document.createElement('div')
    danmaku.id = 'danmukuBox'
    column.appendChild(danmaku)
    const wide = document.createElement('div')
    wide.className = 'bpx-player-ctrl-wide bpx-state-entered'
    document.body.appendChild(wide)
    addCommentsProbe()
    controller.tick()
    env.nowMs += 700
    controller.tick()
    const wrapper = document.getElementById(PANEL_HOST_ID)!
    expect(wrapper.previousElementSibling).toBe(danmaku)
    expect(wrapper.previousElementSibling).not.toBe(up)
  })

  it('淡入：插入 800ms 后 opacity 才现身（原版淡入语义迁移）', () => {
    vi.useFakeTimers()
    const { controller, env } = makeFixture()
    env.href = VIDEO_HREF
    buildVideoPage()
    addCommentsProbe()
    controller.tick()
    env.nowMs += 700
    controller.tick()
    const wrapper = document.getElementById(PANEL_HOST_ID)!
    expect(wrapper.style.opacity).toBe('0')
    vi.advanceTimersByTime(800)
    expect(wrapper.style.opacity).toBe('1')
  })

  it('SPA 换视频（锚点更换）：先摘除重走就绪门，落位跟随新锚点', () => {
    const { controller, host, env } = makeFixture()
    env.href = VIDEO_HREF
    const { column, up } = buildVideoPage()
    addCommentsProbe()
    controller.tick()
    env.nowMs += 700
    controller.tick() // 已落位
    const up2 = document.createElement('div')
    up2.className = 'up-panel-container'
    up.replaceWith(up2)
    env.nowMs += 700
    controller.tick() // 新锚点：先摘除
    expect(document.getElementById(PANEL_HOST_ID)).toBeNull()
    expect(host.style.display).toBe('none')
    env.nowMs += 100
    controller.tick() // 新锚点静止窗口未过
    expect(document.getElementById(PANEL_HOST_ID)).toBeNull()
    env.nowMs += 600
    controller.tick()
    const wrapper = document.getElementById(PANEL_HOST_ID)!
    expect(wrapper.previousElementSibling).toBe(up2)
    expect(wrapper.parentElement).toBe(column)
  })

  it('失位重插：站点把 wrapper 摘掉后周期拍重新插入（应用不重复挂载）', () => {
    const { controller, host, env } = makeFixture()
    env.href = VIDEO_HREF
    buildVideoPage()
    addCommentsProbe()
    controller.tick()
    env.nowMs += 700
    controller.tick()
    const wrapper = document.getElementById(PANEL_HOST_ID)!
    wrapper.remove()
    controller.tick()
    const reinserted = document.getElementById(PANEL_HOST_ID)
    expect(reinserted).not.toBeNull()
    expect(reinserted).not.toBe(wrapper)
    expect(reinserted!.contains(host)).toBe(true)
  })
})

describe('列表页锚点与跳评论门', () => {
  it('列表页无 #commentapp：600ms 静止即落位（评论探针门跳过）', () => {
    const { controller, env } = makeFixture()
    env.href = LIST_HREF
    buildListPage() // 全文档无 #commentapp
    controller.tick()
    env.nowMs += 300
    controller.tick() // 静止窗口未过
    expect(document.getElementById(PANEL_HOST_ID)).toBeNull()
    env.nowMs += 400
    controller.tick() // 700ms ≥ 600ms：静态窗口放行（视频页同刻会卡评论门）
    expect(document.getElementById(PANEL_HOST_ID)).not.toBeNull()
  })

  it('SPA 换列表（锚点更换）：重走静止门，落位跟随新锚点', () => {
    const { controller, env } = makeFixture()
    env.href = LIST_HREF
    const anchor = buildListPage()
    controller.tick()
    env.nowMs += 700
    controller.tick() // 已落位
    const anchor2 = document.createElement('div')
    anchor2.className = 'playlist-container--right'
    anchor2.appendChild(document.createElement('ul'))
    anchor.replaceWith(anchor2)
    env.nowMs += 100
    controller.tick() // 新锚点：先摘除
    expect(document.getElementById(PANEL_HOST_ID)).toBeNull()
    env.nowMs += 600
    controller.tick()
    const wrapper = document.getElementById(PANEL_HOST_ID)!
    expect(wrapper.parentElement).toBe(anchor2)
    expect(anchor2.firstElementChild).toBe(wrapper)
  })
})

describe('浮动 dock 兜底', () => {
  function armDockSurface(env: FixtureEnv, controller: PanelPlacementController): void {
    env.href = HOME_WATCHLATER_HREF
    env.surface = true
    env.video = document.createElement('video')
    document.body.appendChild(env.video)
    controller.tick() // 首次进入稍后看面：dock 时钟起点
  }

  it('已知稍后看面 + 内联容器持续缺失 12s 后浮出（挂 body、宿主移入、挂应用）', () => {
    const { controller, host, env } = makeFixture()
    armDockSurface(env, controller)
    env.nowMs += PANEL_DOCK_FALLBACK_MS - 1_500
    controller.tick() // 差 1.5s 不浮出
    expect(document.getElementById(PANEL_DOCK_ID)).toBeNull()
    env.nowMs += 3_000
    controller.tick()
    const dock = document.getElementById(PANEL_DOCK_ID)!
    expect(dock.parentElement).toBe(document.body)
    expect(dock.contains(host)).toBe(true)
    expect(host.style.display).toBe('')
    expect(env.mounts).toBe(1)
    expect(controller.debugState().dockConnected).toBe(true)
    controller.tick() // 已浮出：下一拍不重复创建
    expect(document.body.querySelectorAll(`#${PANEL_DOCK_ID}`)).toHaveLength(1)
  })

  it('内联接管后 dock 退场（宿主移交内联 wrapper，可见性由落位逻辑管理）', () => {
    const { controller, host, env } = makeFixture()
    armDockSurface(env, controller)
    env.nowMs += PANEL_DOCK_FALLBACK_MS + 1_000
    controller.tick() // dock 浮出
    env.href = LIST_HREF
    buildListPage()
    controller.tick() // 列表锚点起始（dock 仍在：内联未接管）
    expect(document.getElementById(PANEL_DOCK_ID)).not.toBeNull()
    env.nowMs += 700
    controller.tick() // 内联落位接管 → dock 退场
    const wrapper = document.getElementById(PANEL_HOST_ID)!
    expect(wrapper.contains(host)).toBe(true)
    expect(host.style.display).toBe('')
    expect(document.getElementById(PANEL_DOCK_ID)).toBeNull()
  })

  it('离开稍后看面（surface 变化）：dock 即刻退场，内联接管前宿主隐藏', () => {
    const { controller, host, env } = makeFixture()
    armDockSurface(env, controller)
    env.nowMs += PANEL_DOCK_FALLBACK_MS + 1_000
    controller.tick() // dock 浮出
    env.surface = false
    env.href = VIDEO_HREF
    controller.tick()
    expect(document.getElementById(PANEL_DOCK_ID)).toBeNull()
    expect(host.style.display).toBe('none')
  })

  it('显隐 gate 暂关：dock 暂歇退场，时钟保留（恢复即现身）', () => {
    const { controller, env } = makeFixture()
    armDockSurface(env, controller)
    env.nowMs += PANEL_DOCK_FALLBACK_MS + 1_000
    controller.tick() // dock 浮出
    env.shown = false
    controller.tick()
    expect(document.getElementById(PANEL_DOCK_ID)).toBeNull()
    env.shown = true
    env.nowMs += 1_500
    controller.tick() // 时钟未被 gate 暂关清零：立即恢复
    expect(document.getElementById(PANEL_DOCK_ID)).not.toBeNull()
  })

  it('视频页永不触发 dock（surface 判定挡住），落位照常', () => {
    const { controller, env } = makeFixture()
    env.href = VIDEO_HREF
    const { column } = buildVideoPage()
    addCommentsProbe()
    env.video = document.createElement('video')
    column.appendChild(env.video)
    controller.tick()
    env.nowMs += PANEL_DOCK_FALLBACK_MS + 5_000
    controller.tick()
    expect(document.getElementById(PANEL_HOST_ID)).not.toBeNull() // 内联落位照常
    expect(document.getElementById(PANEL_DOCK_ID)).toBeNull()
  })

  it('内联锚点待门期间暂不浮出（时钟已熟也不抢跑，避免先浮一拍再移交的闪跳）', () => {
    const { controller, env } = makeFixture()
    env.href = HOME_WATCHLATER_HREF
    env.surface = true
    env.video = document.createElement('video')
    document.body.appendChild(env.video)
    controller.tick() // 时钟起点（mode none，anchor null）
    env.nowMs += 2_000
    env.video = null
    controller.tick() // 播放器瞬时缺失：跳过本拍，时钟不清
    env.nowMs += 11_000 // t0+13s：时钟已熟，但播放器仍缺失 → 未浮出
    controller.tick()
    expect(document.getElementById(PANEL_DOCK_ID)).toBeNull()
    // 列表容器出现（anchor 待静止门）+ 播放器就绪：若无待门闸，这里会浮出 dock、下一拍又移交内联
    env.video = document.createElement('video')
    document.body.appendChild(env.video)
    env.href = LIST_HREF
    buildListPage()
    controller.tick()
    expect(document.getElementById(PANEL_DOCK_ID)).toBeNull()
    env.nowMs += 700
    controller.tick() // 静止门过 → 内联落位接管，dock 全程未现身
    expect(document.getElementById(PANEL_HOST_ID)).not.toBeNull()
    expect(document.getElementById(PANEL_DOCK_ID)).toBeNull()
  })

  it('dock 首浮同样带 800ms 淡入（与内联落位同语义）', () => {
    vi.useFakeTimers()
    const { controller, env } = makeFixture()
    armDockSurface(env, controller)
    env.nowMs += PANEL_DOCK_FALLBACK_MS + 1_000
    controller.tick() // dock 浮出
    const dock = document.getElementById(PANEL_DOCK_ID)!
    expect(dock.style.opacity).toBe('0')
    vi.advanceTimersByTime(800)
    expect(dock.style.opacity).toBe('1')
  })
})

describe('dock 时钟仅 surface 变化复位', () => {
  it('findVideo 瞬时缺失只跳过本拍，不清零时钟', () => {
    const { controller, env } = makeFixture()
    env.href = HOME_WATCHLATER_HREF
    env.surface = true
    env.video = document.createElement('video')
    document.body.appendChild(env.video)
    controller.tick() // 时钟起点
    env.nowMs += PANEL_DOCK_FALLBACK_MS + 1_000
    env.video = null
    controller.tick() // 播放器瞬时缺失（画质切换换元素）：跳过本拍
    expect(document.getElementById(PANEL_DOCK_ID)).toBeNull()
    env.video = document.createElement('video')
    document.body.appendChild(env.video)
    env.nowMs += 1_500
    controller.tick() // 若时钟被清零，这里仅过 1.5s 不会浮出
    expect(document.getElementById(PANEL_DOCK_ID)).not.toBeNull()
  })

  it('surface 抖动（true→false→true）复位时钟：重进稍后看面重新计满 12s', () => {
    const { controller, env } = makeFixture()
    env.href = HOME_WATCHLATER_HREF
    env.surface = true
    env.video = document.createElement('video')
    document.body.appendChild(env.video)
    controller.tick() // 时钟起点 t0
    env.nowMs += 5_000
    env.surface = false
    controller.tick() // surface 变化：时钟清零 + dock 退场
    env.nowMs += 1_000
    env.surface = true
    controller.tick() // 时钟重启于 t0+6s
    env.nowMs += 5_500 // t0+11.5s：距重启仅 5.5s
    controller.tick()
    expect(document.getElementById(PANEL_DOCK_ID)).toBeNull()
    env.nowMs += 7_000 // 距重启 12.5s
    controller.tick()
    expect(document.getElementById(PANEL_DOCK_ID)).not.toBeNull()
  })
})

describe('复位契约', () => {
  it('resetPanelAnchorState 复位锚点/时间戳/评论门/quiet 时间戳（连带复位 quiet）', () => {
    const { controller, env } = makeFixture()
    env.href = VIDEO_HREF
    buildVideoPage()
    addCommentsProbe()
    controller.tick()
    const before = controller.debugState()
    expect(before.anchor).not.toBeNull()
    expect(before.anchorAt).not.toBeNull()
    expect(before.commentsSeen).toBe(true)
    expect(before.quietAt).not.toBeNull()
    controller.resetPanelAnchorState()
    expect(controller.debugState()).toMatchObject({
      anchor: null,
      anchorAt: null,
      commentsSeen: false,
      quietAt: null,
    })
  })

  it('reset 后下一拍重走就绪门：陈旧的 12s 超时不直接放行', () => {
    const { controller, env } = makeFixture()
    env.href = VIDEO_HREF
    buildVideoPage()
    addCommentsProbe()
    controller.tick() // 锚点起始
    env.nowMs += 700
    controller.tick() // 已落位
    document.getElementById(PANEL_HOST_ID)!.remove() // 失位
    controller.resetPanelAnchorState()
    controller.tick() // 同一时刻：新锚点重走门（quiet 窗口从零起算）
    expect(document.getElementById(PANEL_HOST_ID)).toBeNull()
    env.nowMs += 700
    controller.tick()
    expect(document.getElementById(PANEL_HOST_ID)).not.toBeNull()
  })
})

describe('dispose（扩展失效清理）', () => {
  it('内联落位在场：wrapper 从宿主 DOM 摘除', () => {
    const { controller, host, env } = makeFixture()
    env.href = VIDEO_HREF
    buildVideoPage()
    addCommentsProbe()
    controller.tick()
    env.nowMs += 700
    controller.tick()
    expect(document.getElementById(PANEL_HOST_ID)).not.toBeNull()
    controller.dispose()
    expect(document.getElementById(PANEL_HOST_ID)).toBeNull()
    expect(host.isConnected).toBe(false) // 宿主随 wrapper 一起摘除
  })

  it('dock 在场：dock wrapper 从宿主 DOM 摘除', () => {
    const { controller, host, env } = makeFixture()
    env.href = HOME_WATCHLATER_HREF
    env.surface = true
    env.video = document.createElement('video')
    document.body.appendChild(env.video)
    controller.tick()
    env.nowMs += PANEL_DOCK_FALLBACK_MS + 1_000
    controller.tick()
    expect(document.getElementById(PANEL_DOCK_ID)).not.toBeNull()
    controller.dispose()
    expect(document.getElementById(PANEL_DOCK_ID)).toBeNull()
    expect(host.isConnected).toBe(false)
  })

  it('dispose 后再 tick：周期拍不再落位/浮 dock（getHost 仍非 null 也不能重新插回）', () => {
    const { controller, host, env } = makeFixture()
    env.href = VIDEO_HREF
    buildVideoPage()
    addCommentsProbe()
    controller.tick()
    env.nowMs += 700
    controller.tick() // 已落位
    controller.dispose() // 摘除 wrapper + 复位锚点（模拟 onInvalidated 清理）
    env.nowMs += 700
    controller.tick()
    controller.tick() // 无 disposed 守卫时第二拍会重新插入 wrapper
    expect(document.getElementById(PANEL_HOST_ID)).toBeNull()
    expect(document.getElementById(PANEL_DOCK_ID)).toBeNull()
    expect(host.isConnected).toBe(false)
  })
})

describe('isWatchlaterSurfaceHref（已知稍后看面判定）', () => {
  it('列表播放页与首页 WatchLater tab（任意参数序 / index.html 变体 / 前缀容错）命中', () => {
    expect(isWatchlaterSurfaceHref('https://www.bilibili.com/list/watchlater?oid=1&bvid=BV1ZLht69E7b')).toBe(true)
    expect(isWatchlaterSurfaceHref('https://www.bilibili.com/?page=WatchLater&bvid=BV1ZLht69E7b')).toBe(true)
    expect(isWatchlaterSurfaceHref('https://www.bilibili.com/?spm_id_from=x&page=WatchLater')).toBe(true)
    expect(isWatchlaterSurfaceHref('https://www.bilibili.com/index.html?page=WatchLater')).toBe(true)
    // matches 通配 ?page=WatchLater* 的前缀宽松度在运行时判定里同款保留。
    expect(isWatchlaterSurfaceHref('https://www.bilibili.com/?page=WatchLaterPip')).toBe(true)
  })

  it('裸首页 / 其他 tab（如 ?page=Rank）不命中', () => {
    expect(isWatchlaterSurfaceHref('https://www.bilibili.com/')).toBe(false)
    expect(isWatchlaterSurfaceHref('https://www.bilibili.com/?page=Rank')).toBe(false)
    expect(isWatchlaterSurfaceHref('https://www.bilibili.com/video/BV1xx411c7mD/')).toBe(false)
  })
})
