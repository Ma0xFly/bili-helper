// RAG 检索内置信号语料：恰饭/赞助/带货话术 + 常见品牌/产品词 + 橱窗/优惠/团购等字面信号。
// 词表精确匹配与向量召回的共用语料库；语料向量缓存键取「语料内容哈希」（非手写版本号），
// 语料内容一经改动哈希随之变化，向量层据此全量重算。

export interface CorpusSignal {
  /** 信号短语，词表精确匹配与向量召回的检索单元。 */
  text: string
  /** 信号类别：话术 / 品牌产品词 / 交易信号。 */
  kind: 'script' | 'brand' | 'deal'
  /** 词表精确匹配命中时的加分权重。 */
  weight: number
}

/** 恰饭话术：口播/植入的典型开场与措辞。 */
const SCRIPT_SIGNALS: CorpusSignal[] = [
  { text: '恰饭', kind: 'script', weight: 2 },
  { text: '恰饭时间', kind: 'script', weight: 3 },
  { text: '恰个饭', kind: 'script', weight: 2 },
  { text: '感谢赞助', kind: 'script', weight: 3 },
  { text: '感谢金主', kind: 'script', weight: 3 },
  { text: '金主爸爸', kind: 'script', weight: 3 },
  { text: '本期视频由', kind: 'script', weight: 3 },
  { text: '赞助播出', kind: 'script', weight: 3 },
  { text: '赞助商', kind: 'script', weight: 2 },
  { text: '商业推广', kind: 'script', weight: 2 },
  { text: '广告时间', kind: 'script', weight: 2 },
  { text: '广告来了', kind: 'script', weight: 2 },
  { text: '广告植入', kind: 'script', weight: 2 },
  { text: '带货', kind: 'script', weight: 2 },
  { text: '带货时间', kind: 'script', weight: 2 },
  { text: '种草', kind: 'script', weight: 2 },
  { text: '安利一下', kind: 'script', weight: 2 },
  { text: '推荐一下', kind: 'script', weight: 1 },
  { text: '软广', kind: 'script', weight: 2 },
  { text: '口播广告', kind: 'script', weight: 2 },
  { text: '植入广告', kind: 'script', weight: 2 },
  { text: '恰饭环节', kind: 'script', weight: 2 },
  { text: '粉丝专属价', kind: 'script', weight: 2 },
  { text: '粉丝优惠', kind: 'script', weight: 2 },
  { text: '专属优惠', kind: 'script', weight: 2 },
  { text: '内部价', kind: 'script', weight: 2 },
  { text: '促销活动', kind: 'script', weight: 1 },
  { text: '好物分享', kind: 'script', weight: 1 },
  { text: '福利来了', kind: 'script', weight: 1 },
]

/** 品牌/产品词：常见数码/消费品牌与产品词（词表召回的补充面，语义路由交给向量层兜底）。 */
const BRAND_SIGNALS: CorpusSignal[] = [
  { text: '华为', kind: 'brand', weight: 1 },
  { text: '小米', kind: 'brand', weight: 1 },
  { text: '苹果', kind: 'brand', weight: 1 },
  { text: 'iPhone', kind: 'brand', weight: 1 },
  { text: 'iPad', kind: 'brand', weight: 1 },
  { text: '三星', kind: 'brand', weight: 1 },
  { text: 'OPPO', kind: 'brand', weight: 1 },
  { text: 'vivo', kind: 'brand', weight: 1 },
  { text: '一加', kind: 'brand', weight: 1 },
  { text: '荣耀', kind: 'brand', weight: 1 },
  { text: '联想', kind: 'brand', weight: 1 },
  { text: '华硕', kind: 'brand', weight: 1 },
  { text: '戴尔', kind: 'brand', weight: 1 },
  { text: '惠普', kind: 'brand', weight: 1 },
  { text: '罗技', kind: 'brand', weight: 1 },
  { text: '机械键盘', kind: 'brand', weight: 1 },
  { text: '降噪耳机', kind: 'brand', weight: 1 },
  { text: '蓝牙耳机', kind: 'brand', weight: 1 },
  { text: '显示器', kind: 'brand', weight: 1 },
  { text: '扫地机器人', kind: 'brand', weight: 1 },
  { text: '充电宝', kind: 'brand', weight: 1 },
  { text: '投影仪', kind: 'brand', weight: 1 },
  { text: '游戏本', kind: 'brand', weight: 1 },
  { text: '智能手表', kind: 'brand', weight: 1 },
  { text: '会员', kind: 'brand', weight: 1 },
  { text: '联名款', kind: 'brand', weight: 1 },
]

/** 交易/橱窗信号：评论区、口播里常见的成交字面信号。 */
const DEAL_SIGNALS: CorpusSignal[] = [
  { text: '优惠券', kind: 'deal', weight: 3 },
  { text: '优惠码', kind: 'deal', weight: 3 },
  { text: '领券', kind: 'deal', weight: 2 },
  { text: '满减', kind: 'deal', weight: 2 },
  { text: '折扣', kind: 'deal', weight: 1 },
  { text: '限时优惠', kind: 'deal', weight: 2 },
  { text: '评论区置顶', kind: 'deal', weight: 3 },
  { text: '下单链接', kind: 'deal', weight: 2 },
  { text: '购买链接', kind: 'deal', weight: 2 },
  { text: '链接在评论区', kind: 'deal', weight: 2 },
  { text: '橱窗', kind: 'deal', weight: 2 },
  { text: '小黄车', kind: 'deal', weight: 2 },
  { text: '团购', kind: 'deal', weight: 2 },
  { text: '拼团', kind: 'deal', weight: 2 },
  { text: '佣金', kind: 'deal', weight: 2 },
  { text: '返现', kind: 'deal', weight: 2 },
  { text: '双十一', kind: 'deal', weight: 2 },
  { text: '618', kind: 'deal', weight: 2 },
  { text: '大促', kind: 'deal', weight: 1 },
  { text: '秒杀', kind: 'deal', weight: 1 },
  { text: '预售', kind: 'deal', weight: 1 },
  { text: '定金', kind: 'deal', weight: 1 },
]

export const AD_SIGNAL_CORPUS: readonly CorpusSignal[] = [
  ...SCRIPT_SIGNALS,
  ...BRAND_SIGNALS,
  ...DEAL_SIGNALS,
]

/** 语料文本（向量化的输入与哈希的基数）；顺序不可乱动，改动即视为语料版本变化。 */
export function corpusDocuments(): string[] {
  return AD_SIGNAL_CORPUS.map((signal) => signal.text)
}

/** 语料内容哈希（FNV-1a 32 位，同步纯函数）：语料内容变则哈希变，向量缓存随之全量失效。 */
export function corpusContentHash(): string {
  const serialized = JSON.stringify(AD_SIGNAL_CORPUS)
  let hash = 0x811c9dc5
  for (let i = 0; i < serialized.length; i += 1) {
    hash ^= serialized.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}