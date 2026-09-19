// 广告视频拦截（Epic2-S2.1）：首页带「广告」标识的商业推广卡片整张移除。
// 判定沿旧产物口径：卡片统计文案元素 `.bili-video-card__stats--text` 的文本**全等**「广告」
// （trim 后）——「点赞」「弹幕数」这类正常统计不误伤；Shadow DOM 内同样穿透命中。
// 每批移除计数进「今日拦截」（bumpFeatureStat）+ 拦截明细落库（filter-log）。

import { bumpFeatureStat } from '../config'
import { appendFilterLogEntries } from '../filter/filter-log'
import { cardLogEventOf } from './card-log'
import { createCardBlocker, type CardBlocker } from './dom'

/** 统计文案元素选择器（卡片右下角的「广告 / 点赞 / 弹幕数」小字）。 */
const STATS_TEXT_SELECTOR = '.bili-video-card__stats--text'
/** 广告标识的精确文案：全等匹配，前缀后缀都不算。 */
const AD_MARKER_TEXT = '广告'

/** 命中判定：该元素是「广告」标识文案。导出供单测与真机探针复用。 */
export function isAdCardMarker(element: Element): boolean {
  if (typeof element.matches !== 'function') return false
  if (!element.matches(STATS_TEXT_SELECTOR)) return false
  return (element.textContent ?? '').trim() === AD_MARKER_TEXT
}

export function createAdVideoBlocker(options: { root?: ParentNode } = {}): CardBlocker {
  return createCardBlocker({
    root: options.root,
    logName: 'ad-video-blocker',
    match: isAdCardMarker,
    onBlocked: (count, _phase, cards) => {
      void bumpFeatureStat('adVideoBlocker', count)
      const events = cards
        .map((card) => cardLogEventOf(card, '广告标识'))
        .filter((event): event is NonNullable<typeof event> => event !== null)
      appendFilterLogEntries(events)
    },
  })
}
