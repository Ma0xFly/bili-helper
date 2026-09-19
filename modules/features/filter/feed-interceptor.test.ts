// @vitest-environment happy-dom
// 首页筛选拦截器测试（Epic2-S2.4/S2.5）：批次判定→卡片隐藏、行距补偿开关、
// 过严熔断（3 批全筛空→提示+停隐藏）、dispose 全清理、空/非法配置零拦截。
import { beforeEach, describe, expect, it } from 'vitest'
import type { VideoFilterConfig } from '../config'
import { createVideoFilterInterceptor, PROTECTION_THRESHOLD } from './feed-interceptor'
import type { FeedItem } from './rules'

const HIDDEN = 'bili-helper-video-filter-hidden'
const BODY = 'bili-helper-video-filter-active'
const CARD_LINK = '.bili-video-card__image--link'

function itemOf(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    bvid: 'BV18vY969EHJ',
    title: '普通内容',
    owner: { name: 'UP', mid: 1 },
    duration: 600,
    goto: 'av',
    stat: { danmaku: 1, like: 1, view: 1 },
    pubdate: Math.floor(Date.now() / 1000),
    ...overrides,
  }
}

/** 首页卡片容器结构（拦截器的卡片选择器限定在 .recommended-container_floor-aside .container 内）。 */
function feedContainer(): HTMLElement {
  const aside = document.createElement('div')
  aside.className = 'recommended-container_floor-aside'
  const container = document.createElement('div')
  container.className = 'container'
  aside.append(container)
  return aside
}

function makeCard(bvid: string): HTMLElement {
  const card = document.createElement('div')
  card.className = 'feed-card'
  card.innerHTML = `<a class="bili-video-card__image--link" href="//www.bilibili.com/video/${bvid}"></a>`
  return card
}

function feedEvent(items: FeedItem[]): { url: string; method: string; status: number; responseJson: unknown } {
  return {
    url: 'https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd',
    method: 'GET',
    status: 200,
    responseJson: { data: { item: items } },
  }
}

const CONFIG: VideoFilterConfig = {
  titleKeywords: ['带货'],
  authorBlacklist: [],
  durationMinSeconds: null,
  durationMaxSeconds: null,
  danmakuMin: null,
  danmakuMax: null,
  likeMin: null,
  likeMax: null,
  viewMin: null,
  viewMax: null,
  likeRateMin: null,
  likeRateMax: null,
  pubdateMinDays: null,
  pubdateMaxDays: null,
}

beforeEach(() => {
  document.body.innerHTML = ''
  document.head.querySelectorAll('style').forEach((el) => el.remove())
})

describe('createVideoFilterInterceptor', () => {
  it('空配置或校验失败 → 返回 null（拦截器不构建）', () => {
    const empty = { ...CONFIG, titleKeywords: [] }
    expect(createVideoFilterInterceptor(empty, { getDocument: () => document })).toBeNull()
    const invalid = { ...CONFIG, viewMin: 100, viewMax: 1 }
    expect(createVideoFilterInterceptor(invalid, { getDocument: () => document })).toBeNull()
  })

  it('命中规则的卡片隐藏、未命中不动；有隐藏时 body class 开（行距补偿生效）', () => {
    const aside = feedContainer()
    aside.querySelector('.container')?.append(makeCard('BV18vY969EHJ'), makeCard('BV2xx411c7mE'))
    document.body.append(aside)
    const interceptor = createVideoFilterInterceptor(CONFIG, { getDocument: () => document })!
    interceptor.afterResponse?.(
      feedEvent([itemOf({ title: '疯狂带货' }), itemOf({ title: '正常内容', bvid: 'BV2xx411c7mE' })]),
    )
    const cards = document.querySelectorAll('.feed-card')
    expect(cards[0]?.classList.contains(HIDDEN)).toBe(true)
    expect(cards[1]?.classList.contains(HIDDEN)).toBe(false)
    expect(document.body.classList.contains(BODY)).toBe(true)
    expect(document.getElementById('bili-helper-video-filter-style')).not.toBeNull()
    interceptor.dispose?.()
  })

  it('过严保护：连续 3 批全筛空 → 熔断提示 + 后续批次不再隐藏', () => {
    const aside = feedContainer()
    aside.querySelector('.container')?.append(makeCard('BV18vY969EHJ'))
    document.body.append(aside)
    const interceptor = createVideoFilterInterceptor(CONFIG, { getDocument: () => document })!
    const allFiltered = () => feedEvent([itemOf({ title: '带货一号' })])
    for (let i = 0; i < PROTECTION_THRESHOLD; i += 1) interceptor.afterResponse?.(allFiltered())
    expect(document.getElementById('bili-helper-video-filter-protection-notice')).not.toBeNull()
    // 第 4 批（熔断后）：不再写入隐藏集。
    aside.querySelector('.container')?.append(makeCard('BV3xx411c7mF'))
    interceptor.afterResponse?.(feedEvent([itemOf({ title: '带货二号', bvid: 'BV3xx411c7mF' })]))
    const cards = document.querySelectorAll('.feed-card')
    expect(cards[1]?.classList.contains(HIDDEN)).toBe(false)
    interceptor.dispose?.()
  })

  it('非全筛空的批次不清零连续计数？不——普通批重置计数', () => {
    const aside = feedContainer()
    aside.querySelector('.container')?.append(makeCard('BV18vY969EHJ'))
    document.body.append(aside)
    const interceptor = createVideoFilterInterceptor(CONFIG, { getDocument: () => document })!
    interceptor.afterResponse?.(feedEvent([itemOf({ title: '带货' })]))
    interceptor.afterResponse?.(feedEvent([itemOf({ title: '正常' })])) // 混合批 → 计数归零
    interceptor.afterResponse?.(feedEvent([itemOf({ title: '带货' })]))
    expect(document.getElementById('bili-helper-video-filter-protection-notice')).toBeNull()
    interceptor.dispose?.()
  })

  it('dispose：样式/body class/隐藏 class/提示全清理', () => {
    const aside = feedContainer()
    aside.querySelector('.container')?.append(makeCard('BV18vY969EHJ'))
    document.body.append(aside)
    const interceptor = createVideoFilterInterceptor(CONFIG, { getDocument: () => document })!
    for (let i = 0; i < PROTECTION_THRESHOLD; i += 1) {
      interceptor.afterResponse?.(feedEvent([itemOf({ title: '带货' })]))
    }
    expect(document.querySelector(`.${HIDDEN}`)).not.toBeNull()
    interceptor.dispose?.()
    expect(document.querySelector(`.${HIDDEN}`)).toBeNull()
    expect(document.body.classList.contains(BODY)).toBe(false)
    expect(document.getElementById('bili-helper-video-filter-style')).toBeNull()
    expect(document.getElementById('bili-helper-video-filter-protection-notice')).toBeNull()
  })

  it('卡片无 BV 链接时不隐藏（定位不到就不动）', () => {
    const card = document.createElement('div')
    card.className = 'feed-card'
    card.textContent = '没有链接的卡片'
    document.body.append(card)
    const interceptor = createVideoFilterInterceptor(CONFIG, { getDocument: () => document })!
    interceptor.afterResponse?.(feedEvent([itemOf({ title: '带货' })]))
    expect(card.classList.contains(HIDDEN)).toBe(false)
    interceptor.dispose?.()
  })
})
