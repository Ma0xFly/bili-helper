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
