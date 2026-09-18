// @vitest-environment happy-dom
// 广告视频拦截测试（Epic2-S2.1）：精确文案判定、初始扫描/增量捕获、Shadow DOM 穿透、
// 批量单次上报、stop 停观察、统计入「今日拦截」。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFeatureStats } from '../config'
import { createAdVideoBlocker, isAdCardMarker } from './ad-video'
import { createCardBlocker } from './dom'

/** 造一张首页卡片：外层 .feed-card 槽位 + 内层 .bili-feed-card 视觉卡 + 统计小字。 */
function makeCard(markerText: string): HTMLElement {
  const card = document.createElement('div')
  card.className = 'feed-card'
  const inner = document.createElement('div')
  inner.className = 'bili-feed-card'
  const stats = document.createElement('div')
  stats.className = 'bili-video-card__stats'
  const text = document.createElement('span')
  text.className = 'bili-video-card__stats--text'
  text.textContent = markerText
  stats.append(text)
  inner.append(stats)
  card.append(inner)
  return card
}

/** 等观察器批处理跑完（微任务链 + 一个宏任务兜底）。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('isAdCardMarker（文案全等判定）', () => {
  it('只有统计小字文本全等「广告」才命中', () => {
    const hit = makeCard('广告').querySelector('.bili-video-card__stats--text') as Element
    const padded = makeCard('  广告  ').querySelector('.bili-video-card__stats--text') as Element
    const like = makeCard('点赞').querySelector('.bili-video-card__stats--text') as Element
    const adish = makeCard('品牌广告投放').querySelector('.bili-video-card__stats--text') as Element
    expect(isAdCardMarker(hit)).toBe(true)
    expect(isAdCardMarker(padded)).toBe(true)
    expect(isAdCardMarker(like)).toBe(false)
    expect(isAdCardMarker(adish)).toBe(false)
    // 非统计小字元素：文本一样也不命中。
    const other = document.createElement('div')
    other.textContent = '广告'
    expect(isAdCardMarker(other)).toBe(false)
  })
})

describe('createCardBlocker（拦截底座）', () => {
  it('初始扫描：广告卡整张（含外层槽位）移除，正常卡不动，一批只报一次', () => {
    const root = document.createElement('div')
    document.body.append(root)
    root.append(makeCard('广告'), makeCard('点赞'), makeCard('广告'), makeCard('弹幕数'))
    const blocked: Array<{ count: number; phase: string }> = []
    const blocker = createCardBlocker({
      root,
      logName: 'test-blocker',
      match: isAdCardMarker,
      onBlocked: (count, phase) => blocked.push({ count, phase }),
    })
    blocker.start()
    expect(root.querySelectorAll('.feed-card')).toHaveLength(2) // 只剩两张正常卡
    expect(root.textContent).not.toContain('广告')
    expect(blocked).toEqual([{ count: 2, phase: 'initial' }])
    blocker.stop()
  })

  it('滚动加载：新增广告卡被移除并计数；正常卡保留', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const blocked: Array<{ count: number; phase: string }> = []
    const blocker = createCardBlocker({
      root,
      logName: 'test-blocker',
      match: isAdCardMarker,
      onBlocked: (count, phase) => blocked.push({ count, phase }),
    })
    blocker.start()
    root.append(makeCard('点赞'))
    root.append(makeCard('广告'))
    await settle()
    expect(root.querySelectorAll('.feed-card')).toHaveLength(1)
    expect(blocked).toEqual([{ count: 1, phase: 'mutation' }])
    blocker.stop()
  })

  it('同批多张只上报一次（count 汇总）', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const blocked: Array<{ count: number; phase: string }> = []
    const blocker = createCardBlocker({
      root,
      logName: 'test-blocker',
      match: isAdCardMarker,
      onBlocked: (count, phase) => blocked.push({ count, phase }),
    })
    blocker.start()
    root.append(makeCard('广告'), makeCard('广告'), makeCard('广告'))
    await settle()
    // 启动时 root 为空（无 initial 上报）；同批三张 → 一次 mutation 上报、count=3。
    expect(blocked).toEqual([{ count: 3, phase: 'mutation' }])
    expect(root.querySelectorAll('.feed-card')).toHaveLength(0)
    blocker.stop()
  })

  it('Shadow DOM：既有影子树穿透命中；晚加入影子树的卡片同样被观察移除', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const host = document.createElement('div')
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.append(makeCard('广告'))
    root.append(host, makeCard('点赞'))

    const blocker = createCardBlocker({
      root,
      logName: 'test-blocker',
      match: isAdCardMarker,
    })
    blocker.start()
    // 既有影子树：初始扫描已穿透。
    expect(shadow.querySelectorAll('.feed-card')).toHaveLength(0)

    // 晚加入：影子树已被挂上观察器。
    shadow.append(makeCard('广告'))
    await settle()
    expect(shadow.querySelectorAll('.feed-card')).toHaveLength(0)
    expect(root.querySelectorAll('.feed-card')).toHaveLength(1)
    blocker.stop()
  })

  it('stop 后不再拦截（已移除的不回溯恢复）', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const blocker = createCardBlocker({ root, logName: 'test-blocker', match: isAdCardMarker })
    blocker.start()
    root.append(makeCard('广告'))
    await settle()
    expect(root.querySelectorAll('.feed-card')).toHaveLength(0)
    blocker.stop()
    root.append(makeCard('广告'))
    await settle()
    expect(root.querySelectorAll('.feed-card')).toHaveLength(1)
  })
})

describe('createAdVideoBlocker（统计接线）', () => {
  it('每批移除计入「今日拦截」', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    root.append(makeCard('广告'), makeCard('广告'), makeCard('点赞'))
    const blocker = createAdVideoBlocker({ root })
    blocker.start()
    root.append(makeCard('广告'))
    await settle()
    await new Promise((resolve) => setTimeout(resolve, 10)) // 等 bumpFeatureStat 落库
    const stats = await readFeatureStats()
    expect(stats.adVideoBlocker?.totalBlocked).toBe(3)
    blocker.stop()
  })
})
