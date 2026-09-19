// 拦截明细的卡片信息提取（广告/推广拦截器共用）：从已移除的卡片元素上读 BV 号与标题，
// 组装成 filter-log 事件。卡片已脱文档但 DOM 仍可查询；读不到 BV 的极少数卡片跳过不记。

import type { FilterLogEventPayload } from '../intercept/protocol'

const BV_IN_HREF = /BV[0-9A-Za-z]{10}/u
const TITLE_SELECTORS = ['.bili-video-card__info--tit', '.bili-video-card__info--bottom', 'h3']

/** 首页注入面固定；卡片拦截器只在首页跑。 */
const BLOCKER_SURFACE = '首页'

export function cardLogEventOf(card: Element, reason: string): FilterLogEventPayload | null {
  const href = card.querySelector('a[href*="/video/BV"]')?.getAttribute('href') ?? ''
  const bvid = href.match(BV_IN_HREF)?.[0]
  if (bvid === undefined) return null
  let title = ''
  for (const selector of TITLE_SELECTORS) {
    const text = card.querySelector(selector)?.textContent?.trim() ?? ''
    if (text !== '') {
      title = text
      break
    }
  }
  return { bvid, title, reason, surface: BLOCKER_SURFACE }
}
