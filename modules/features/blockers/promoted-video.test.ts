// @vitest-environment happy-dom
// 推广视频拦截测试（Epic2-S2.2）：双路判定精确性（类名/路径常量）、相似结构不误杀、
// 同卡双标记去重、统计接线。
import { beforeEach, describe, expect, it } from 'vitest'
import { readFeatureStats } from '../config'
import {
  ROCKET_ICON_PATH,
  createPromotedVideoBlocker,
  isPromotedCardMarker,
} from './promoted-video'

function cardWith(inner: string): HTMLElement {
  const card = document.createElement('div')
  card.className = 'feed-card'
  card.innerHTML = `<div class="bili-feed-card">${inner}</div>`
  return card
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('isPromotedCardMarker（双路精确判定）', () => {
  it('路径①：creative-ad 类名的 svg 命中', () => {
    const svg = document.createElement('svg')
    svg.className = 'bili-video-card__info--creative-ad'
    expect(isPromotedCardMarker(svg)).toBe(true)
  })

  it('路径②：.vui_icon 内与小火箭常量逐字节相等的 path 命中', () => {
    const host = document.createElement('span')
    host.className = 'vui_icon'
    host.innerHTML = `<svg><path d="${ROCKET_ICON_PATH}"></path></svg>`
    const path = host.querySelector('path') as Element
    expect(isPromotedCardMarker(path)).toBe(true)
  })

  it('相似结构不误杀：无类名 svg / 不同 path / 小火箭 path 不在 .vui_icon 内', () => {
    const plainSvg = document.createElement('svg')
    expect(isPromotedCardMarker(plainSvg)).toBe(false)

    const host = document.createElement('span')
    host.className = 'vui_icon'
    host.innerHTML = '<svg><path d="M1 1L2 2z"></path></svg>'
    expect(isPromotedCardMarker(host.querySelector('path') as Element)).toBe(false)

    const bare = document.createElement('div')
    bare.innerHTML = `<svg><path d="${ROCKET_ICON_PATH}"></path></svg>`
    expect(isPromotedCardMarker(bare.querySelector('path') as Element)).toBe(false)
  })
})

describe('createPromotedVideoBlocker', () => {
  it('两条路径的卡片都被移除；正常卡保留；同卡双标记只计一次', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const bothMarkers = cardWith(
      `<svg class="bili-video-card__info--creative-ad"></svg><span class="vui_icon"><svg><path d="${ROCKET_ICON_PATH}"></path></svg></span>`,
    )
    const creativeOnly = cardWith('<svg class="bili-video-card__info--creative-ad"></svg>')
    const normal = cardWith('<svg class="bui-icon"></svg>')
    root.append(bothMarkers, creativeOnly, normal)

    const blocker = createPromotedVideoBlocker({ root })
    blocker.start()
    expect(root.querySelectorAll('.feed-card')).toHaveLength(1) // 只剩 normal
    await settle()
    await new Promise((resolve) => setTimeout(resolve, 10))
    const stats = await readFeatureStats()
    expect(stats.promotedVideoBlocker?.totalBlocked).toBe(2) // 双标记去重：算 1 + 1 = 2
    blocker.stop()
  })

  it('滚动加载的新推广卡同样被移除并计数', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const blocker = createPromotedVideoBlocker({ root })
    blocker.start()
    root.append(cardWith(`<span class="vui_icon"><svg><path d="${ROCKET_ICON_PATH}"></path></svg></span>`))
    await settle()
    expect(root.querySelectorAll('.feed-card')).toHaveLength(0)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const stats = await readFeatureStats()
    expect(stats.promotedVideoBlocker?.totalBlocked).toBe(1)
    blocker.stop()
  })
})
