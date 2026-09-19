// @vitest-environment happy-dom
// 功能增强组测试（Epic4）：无级倍速（注入/预设/持久化/回写/直播排除/停止恢复）、
// 换一换历史（快照/回放/上限/截断）、评论 IP（收集/清洗/影子注入/换 oid 清空）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFeatureConfig, setFeatureEnabled, writeFeatureConfig } from '../config'
import {
  RATE_PRESETS,
  createSteplessRateRuntime,
  formatRateLabel,
  isLivePage,
  normalizeRate,
} from './stepless-rate'
import { createRefreshHistoryRuntime, HISTORY_CAP } from './refresh-history'
import { cleanLocation, collectLocations, createCommentIpRuntime } from './comment-ip'

beforeEach(() => {
  document.body.innerHTML = ''
  document.head.querySelectorAll('style').forEach((el) => el.remove())
})

describe('无级倍速', () => {
  function makePlayer(): HTMLVideoElement {
    document.body.innerHTML = '<div class="bpx-player-ctrl-playbackrate-menu"><li class="bpx-player-ctrl-playbackrate-menu-item">1.0x</li></div><video></video>'
    return document.querySelector('video') as HTMLVideoElement
  }

  it('normalize：越界截断、两位小数、非法回落 1；标签 1x 显示「倍速」', () => {
    expect(normalizeRate(9.9)).toBe(5)
    expect(normalizeRate(0.01)).toBe(0.1)
    expect(normalizeRate(1.377)).toBe(1.38)
    expect(normalizeRate(Number.NaN)).toBe(1)
    expect(formatRateLabel(1)).toBe('倍速')
    expect(formatRateLabel(1.5)).toBe('1.5x')
  })

  it('直播间判定：hostname 或 .live-room-app', () => {
    document.body.innerHTML = '<div class="live-room-app"></div>'
    expect(isLivePage(document, 'www.bilibili.com')).toBe(true)
    document.body.innerHTML = ''
    expect(isLivePage(document, 'live.bilibili.com')).toBe(true)
    expect(isLivePage(document, 'www.bilibili.com')).toBe(false)
  })

  it('启动：菜单注入滑杆+预设，配置速率应用到 video；预设点击生效并持久化', async () => {
    const video = makePlayer()
    await writeFeatureConfig('steplessVideoRate', { rate: 1.5 })
    const runtime = createSteplessRateRuntime({ doc: document, hostname: 'www.bilibili.com' })
    await runtime.start()
    expect(video.playbackRate).toBe(1.5)
    expect(video.defaultPlaybackRate).toBe(1.5)

    const slider = document.querySelector('[data-bili-helper-rate-slider] input') as HTMLInputElement
    expect(slider).not.toBeNull()
    expect(document.querySelectorAll('[data-bili-helper-rate-preset]')).toHaveLength(RATE_PRESETS.length)

    const preset2x = [...document.querySelectorAll('[data-bili-helper-rate-preset]')].find(
      (el) => el.textContent === '2x',
    ) as HTMLElement
    preset2x.click()
    expect(video.playbackRate).toBe(2)
    await new Promise((resolve) => setTimeout(resolve, 10)) // 持久化走异步写链，落库后再读
    const stored = await readFeatureConfig('steplessVideoRate')
    expect((stored.config as { rate: number }).rate).toBe(2)
    runtime.stop()
  })

  it('外部改速被回写为配置值；停止恢复 1x 并移除注入', async () => {
    const video = makePlayer()
    const runtime = createSteplessRateRuntime({ doc: document, hostname: 'www.bilibili.com' })
    await runtime.start()
    try {
    video.playbackRate = 3 // 外部（B 站/其它脚本）改速
    video.dispatchEvent(new Event('ratechange'))
    expect(video.playbackRate).toBe(1) // 回写配置值（初始 1）
    } finally {
    runtime.stop()
    }
    expect(video.playbackRate).toBe(1)
    expect(document.querySelector('[data-bili-helper-rate-slider]')).toBeNull()
  })
})

describe('换一换历史', () => {
  function makeHome(): void {
    document.body.innerHTML = `
      <div class="recommended-container_floor-aside"><div class="container">
        <button class="feed-roll-btn">换一换</button>
        <div class="feed-card">第一批 A</div>
        <div class="feed-card">第一批 B</div>
      </div></div>`
  }

  it('pointerdown 快照当前批 → response 批次入史；页码与禁用态正确', async () => {
    makeHome()
    const runtime = createRefreshHistoryRuntime(() => document, () => 'https://www.bilibili.com/')
    runtime.startUi()
    try {
    // 首页轮询装配面板。
    await new Promise((resolve) => setTimeout(resolve, 1600))
    const panel = document.getElementById('bili-helper-homepage-refresh-history')
    expect(panel).not.toBeNull()
    expect(panel?.querySelector('.bili-helper-history-indicator')?.textContent).toBe('0/0')

    // 点「换一换」前快照 DOM 批。
    document.querySelector('.feed-roll-btn')?.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(panel?.querySelector('.bili-helper-history-indicator')?.textContent).toBe('1/1')
    // 接口响应入史：当前位置即最新批（2/2），后退可用、前进禁用。
    runtime.afterResponse!({ url: 'x', method: 'GET', status: 200, responseJson: { data: { item: [] } } })
    expect(panel?.querySelector('.bili-helper-history-indicator')?.textContent).toBe('2/2')

    // 后退可用（index 1 → 0），前进禁用。
    const [up, down] = [...panel!.querySelectorAll('button')] as [HTMLButtonElement, HTMLButtonElement]
    expect(up.disabled).toBe(false)
    expect(down.disabled).toBe(true)
    } finally {
      runtime.stopUi()
    }
  })

  it('DOM 回放恢复上一批内容；回放走短路缓存不发真实请求', async () => {
    makeHome()
    const runtime = createRefreshHistoryRuntime(() => document, () => 'https://www.bilibili.com/')
    runtime.startUi()
    try {
    await new Promise((resolve) => setTimeout(resolve, 1600))
    const cards = () => [...document.querySelectorAll('.feed-card')].map((c) => c.textContent)
    const first = cards()

    // 快照第一批 → DOM 换成第二批 → 后退应还原第一批。
    document.querySelector('.feed-roll-btn')?.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    for (const card of document.querySelectorAll('.feed-card')) card.textContent = '第二批'
    runtime.afterResponse!({ url: 'x', method: 'GET', status: 200, responseJson: { data: { item: [] } } })

    const panel = document.getElementById('bili-helper-homepage-refresh-history')!
    const up = panel.querySelector('button') as HTMLButtonElement
    up.click()
    expect(cards()).toEqual(first)

    // response 型回放：入 response 批（i=1）→ 后退（i=0）→ 前进回放该批 → 短路器交出缓存。
    runtime.afterResponse!({ url: 'x', method: 'GET', status: 200, responseJson: { cached: true } })
    up!.click()
    ;(panel.querySelectorAll('button')[1] as HTMLButtonElement)!.click()
    const shorted = runtime.shortCircuit!({ url: FEED, method: 'GET', body: null })
    expect(shorted).toMatchObject({ responseJson: { cached: true } })
    // 回放伪造的 pointerdown 不入史（页码不虚涨）。
    expect(panel.querySelector('.bili-helper-history-indicator')?.textContent).toBe('2/2')
    } finally {
      runtime.stopUi()
    }
  })

  it('上限 30 批淘汰最旧；后退后再换新截断后续', async () => {
    makeHome()
    const runtime = createRefreshHistoryRuntime(() => document, () => 'https://www.bilibili.com/')
    runtime.startUi()
    try {
    await new Promise((resolve) => setTimeout(resolve, 1600))
    const panel = document.getElementById('bili-helper-homepage-refresh-history')!
    for (let i = 0; i < HISTORY_CAP + 5; i += 1) {
      runtime.afterResponse!({ url: 'x', method: 'GET', status: 200, responseJson: { i } })
    }
    expect(panel.querySelector('.bili-helper-history-indicator')?.textContent).toBe(`${HISTORY_CAP}/${HISTORY_CAP}`)
    // 后退一步再入新批：截断后续（长度不变），当前位置回到末尾前一位处推进。
    ;(panel.querySelector('button') as HTMLButtonElement)!.click()
    expect(panel.querySelector('.bili-helper-history-indicator')?.textContent).toBe(`${HISTORY_CAP - 1}/${HISTORY_CAP}`)
    runtime.afterResponse!({ url: 'x', method: 'GET', status: 200, responseJson: { fresh: true } })
    expect(panel.querySelector('.bili-helper-history-indicator')?.textContent).toBe(`${HISTORY_CAP - 1}/${HISTORY_CAP}`)
    } finally {
      runtime.stopUi()
    }
  })
})

const FEED = 'https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?fresh_type=3'

describe('评论 IP 属地', () => {
  it('属地清洗与递归收集（replies/top_replies/top.upper）', () => {
    expect(cleanLocation('IP属地：上海')).toBe('上海')
    expect(cleanLocation('IP 属地: 北京')).toBe('北京')
    expect(cleanLocation(undefined as unknown as string)).toBe('')
    const map = collectLocations({
      data: {
        oid: 1,
        replies: [{ mid: 1, reply_control: { location: 'IP属地：上海' } }],
        top_replies: [{ mid_str: '22', reply_control: { location: '广东' } }],
        top: { upper: { mid: 3, reply_control: { location: 'IP属地：四川' } } },
      },
    })
    expect(map.get('1')).toBe('上海')
    expect(map.get('22')).toBe('广东')
    expect(map.get('3')).toBe('四川')
  })

  it('接口数据 → 用户名内追加小标签；缺数据移除；换 oid 清空', () => {
    document.body.innerHTML = '<div id="user-name" data-user-profile-id="42">小明</div>'
    const runtime = createCommentIpRuntime(() => document)
    runtime.interceptor.afterResponse({
      url: 'main',
      responseJson: { data: { oid: 1, replies: [{ mid: 42, reply_control: { location: 'IP属地：重庆' } }] } },
    })
    runtime.sync()
    const label = document.querySelector('[data-bili-helper-comment-ip-location]')
    expect(label?.textContent).toBe('重庆')

    // 同 oid 后续分页没有该 mid：缓存仍在，标签保留（旧版口径——只有换 oid 才清）。
    runtime.interceptor.afterResponse({ url: 'main', responseJson: { data: { oid: 1, replies: [] } } })
    runtime.sync()
    expect(document.querySelector('[data-bili-helper-comment-ip-location]')?.textContent).toBe('重庆')
    // 从未有数据的 mid：不显示占位。
    const stranger = document.createElement('div')
    stranger.id = 'user-name'
    stranger.setAttribute('data-user-profile-id', '999')
    stranger.textContent = '路人'
    document.body.append(stranger)
    runtime.sync()
    expect(stranger.querySelector('[data-bili-helper-comment-ip-location]')).toBeNull()

    // 换视频（oid 变）→ 清空。
    runtime.interceptor.afterResponse({
      url: 'main',
      responseJson: { data: { oid: 2, replies: [{ mid: 42, reply_control: { location: '天津' } }] } },
    })
    runtime.sync()
    expect(document.querySelector('[data-bili-helper-comment-ip-location]')?.textContent).toBe('天津')
    runtime.stop()
    expect(document.querySelector('[data-bili-helper-comment-ip-location]')).toBeNull()
  })

  it('Shadow DOM 内的用户名同样被注入', () => {
    const host = document.createElement('bili-comments')
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<div id="user-name" data-user-profile-id="7">UP</div>'
    document.body.append(host)
    const runtime = createCommentIpRuntime(() => document)
    runtime.interceptor.afterResponse({
      url: 'main',
      responseJson: { data: { oid: 1, replies: [{ mid: 7, reply_control: { location: '浙江' } }] } },
    })
    runtime.sync()
    expect(shadow.querySelector('[data-bili-helper-comment-ip-location]')?.textContent).toBe('浙江')
    runtime.stop()
  })
})
