// @vitest-environment happy-dom
// 筛选拦截器测试（Epic2-S2.4/S2.5 + 三源扩展）：批次判定→卡片隐藏、行距补偿开关、
// 过严熔断（3 批全筛空→提示+停隐藏）、dispose 全清理、空/非法配置零拦截、
// 热门/搜索数据源归一与各自的 DOM 定位（2026-09 真机踏勘口径）。
import { beforeEach, describe, expect, it } from 'vitest'
import type { PageSurface } from '../surface'
import type { VideoFilterConfig } from '../config'
import {
  createVideoFilterInterceptor,
  normalizePopularItem,
  normalizeSearchItem,
  parseColonDuration,
  PROTECTION_THRESHOLD,
} from './feed-interceptor'
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

/** happy-dom 的 location 是 localhost（非注入面）：注入面判定统一经 hook 注入。 */
const HOME_HOOKS: { getDocument: () => Document; getSurface: () => PageSurface } = {
  getDocument: () => document,
  getSurface: () => 'home',
}

function eventOf(
  url: string,
  responseJson: unknown,
): { url: string; method: string; status: number; responseJson: unknown } {
  return { url, method: 'GET', status: 200, responseJson }
}

function feedEvent(items: FeedItem[]): { url: string; method: string; status: number; responseJson: unknown } {
  return eventOf('https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd', {
    data: { item: items },
  })
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
    expect(createVideoFilterInterceptor(empty, HOME_HOOKS)).toBeNull()
    const invalid = { ...CONFIG, viewMin: 100, viewMax: 1 }
    expect(createVideoFilterInterceptor(invalid, HOME_HOOKS)).toBeNull()
  })

  it('命中规则的卡片隐藏、未命中不动；有隐藏时 body class 开（行距补偿生效）', () => {
    const aside = feedContainer()
    aside.querySelector('.container')?.append(makeCard('BV18vY969EHJ'), makeCard('BV2xx411c7mE'))
    document.body.append(aside)
    const interceptor = createVideoFilterInterceptor(CONFIG, HOME_HOOKS)!
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
    const interceptor = createVideoFilterInterceptor(CONFIG, HOME_HOOKS)!
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
    const interceptor = createVideoFilterInterceptor(CONFIG, HOME_HOOKS)!
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
    const interceptor = createVideoFilterInterceptor(CONFIG, HOME_HOOKS)!
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
    const interceptor = createVideoFilterInterceptor(CONFIG, HOME_HOOKS)!
    interceptor.afterResponse?.(feedEvent([itemOf({ title: '带货' })]))
    expect(card.classList.contains(HIDDEN)).toBe(false)
    interceptor.dispose?.()
  })
})

describe('热门/搜索数据源', () => {
  it('热门：/popular 响应的 data.list 归一（补 goto）后照常判定隐藏', () => {
    const list = document.createElement('ul')
    list.className = 'card-list'
    const card = document.createElement('div')
    card.className = 'video-card'
    card.innerHTML = '<div class="video-card__content"><a href="//www.bilibili.com/video/BV18vY969EHJ"></a></div>'
    list.append(card)
    document.body.append(list)
    const interceptor = createVideoFilterInterceptor(CONFIG, {
      getDocument: () => document,
      getSurface: (): PageSurface => 'popular',
    })!
    interceptor.afterResponse?.(
      eventOf('https://api.bilibili.com/x/web-interface/popular?pn=1&ps=20', {
        data: {
          list: [
            {
              bvid: 'BV18vY969EHJ',
              title: '疯狂带货',
              duration: 600,
              pubdate: Math.floor(Date.now() / 1000),
              owner: { mid: 1, name: 'UP' },
              stat: { view: 1, like: 1, danmaku: 1 },
            },
          ],
        },
      }),
    )
    expect(card.classList.contains(HIDDEN)).toBe(true)
    interceptor.dispose?.()
  })

  it('搜索：扁平 search/type 响应归一（剥 <em>、mm:ss 时长、play→view）后命中标题关键词', () => {
    const grid = document.createElement('div')
    grid.className = 'video-list row'
    const col = document.createElement('div')
    col.className = 'col_3 col_md_2'
    const card = document.createElement('div')
    card.className = 'bili-video-card'
    card.innerHTML = '<div class="bili-video-card__wrap"><a href="//www.bilibili.com/video/BV18vY969EHJ"></a></div>'
    col.append(card)
    grid.append(col)
    document.body.append(grid)
    const interceptor = createVideoFilterInterceptor(CONFIG, {
      getDocument: () => document,
      getSurface: (): PageSurface => 'search',
    })!
    interceptor.afterResponse?.(
      eventOf('https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=video&keyword=x', {
        data: {
          result: [
            {
              bvid: 'BV18vY969EHJ',
              title: '限时<em class="keyword">带货</em>大赏',
              author: 'UP',
              mid: 1,
              play: 9,
              video_review: 3,
              duration: '10:30',
              pubdate: Math.floor(Date.now() / 1000),
            },
          ],
        },
      }),
    )
    // 隐藏目标上溯到网格单元格（.col_3），不留空卡。
    expect(col.classList.contains(HIDDEN)).toBe(true)
    expect(card.classList.contains(HIDDEN)).toBe(false)
    interceptor.dispose?.()
  })

  it('搜索 all/v2 分块形态（result_type=video）同样兼容', () => {
    const grid = document.createElement('div')
    grid.className = 'video-list row'
    const col = document.createElement('div')
    col.className = 'col_3'
    const card = document.createElement('div')
    card.className = 'bili-video-card'
    card.innerHTML = '<a href="//www.bilibili.com/video/BV18vY969EHJ?from=search"></a>'
    col.append(card)
    grid.append(col)
    document.body.append(grid)
    const interceptor = createVideoFilterInterceptor(CONFIG, {
      getDocument: () => document,
      getSurface: (): PageSurface => 'search',
    })!
    interceptor.afterResponse?.(
      eventOf('https://api.bilibili.com/x/web-interface/wbi/search/all/v2?keyword=x', {
        data: {
          result: [
            { result_type: 'bangumi', data: [{ keyword: 'x' }] },
            {
              result_type: 'video',
              data: [
                {
                  arcurl: 'https://www.bilibili.com/video/BV18vY969EHJ',
                  title: '带货',
                  author: 'UP',
                  mid: 1,
                  play: 9,
                  video_review: 3,
                  duration: '03:05',
                  pubdate: Math.floor(Date.now() / 1000),
                },
              ],
            },
          ],
        },
      }),
    )
    expect(col.classList.contains(HIDDEN)).toBe(true)
    interceptor.dispose?.()
  })

  it('未知注入面（分区/动态等）：数据照记目录，但不动 DOM（宁可不动，不可乱动）', () => {
    const interceptor = createVideoFilterInterceptor(CONFIG, {
      getDocument: () => document,
      getSurface: (): PageSurface => 'other',
    })!
    interceptor.afterResponse?.(feedEvent([itemOf({ title: '带货' })]))
    expect(document.querySelectorAll(`.${HIDDEN}`).length).toBe(0)
    interceptor.dispose?.()
  })
})

describe('normalize 归一化纯函数', () => {
  it('parseColonDuration：mm:ss 与 h:mm:ss；非法输入 undefined', () => {
    expect(parseColonDuration('10:30')).toBe(630)
    expect(parseColonDuration('1:02:03')).toBe(3723)
    expect(parseColonDuration('0:59')).toBe(59)
    expect(parseColonDuration('abc')).toBeUndefined()
    expect(parseColonDuration('10')).toBeUndefined()
    expect(parseColonDuration(600)).toBeUndefined()
  })

  it('normalizeSearchItem：标题剥 <em>、bvid 缺失时从 arcurl 提取、duration 字符串转秒', () => {
    const item = normalizeSearchItem({
      title: '耳机<em class="keyword">评测</em>',
      arcurl: 'https://www.bilibili.com/video/BV18vY969EHJ/?p=1',
      author: 'UP',
      mid: 42,
      play: 100,
      video_review: 7,
      duration: '12:34',
      pubdate: 1700000000,
    })
    expect(item).toMatchObject({
      bvid: 'BV18vY969EHJ',
      title: '耳机评测',
      owner: { mid: 42, name: 'UP' },
      stat: { view: 100, danmaku: 7 },
      duration: 754,
      pubdate: 1700000000,
      goto: 'av',
    })
  })

  it('normalizePopularItem：补 goto=av，owner/stat 子集搬运', () => {
    expect(
      normalizePopularItem({
        bvid: 'BV18vY969EHJ',
        title: '热门视频',
        owner: { mid: 1, name: 'UP' },
        stat: { view: 10, like: 5, danmaku: 2 },
        duration: 300,
        pubdate: 1700000000,
      }),
    ).toMatchObject({ goto: 'av', owner: { mid: 1, name: 'UP' }, stat: { view: 10, like: 5, danmaku: 2 } })
  })
})
