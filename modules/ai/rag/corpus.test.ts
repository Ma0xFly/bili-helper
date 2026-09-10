// 语料体检：md 词库单一事实源的格式/去重/迁移回归校验。
// 防止改词库时丢词、加脏词、或构建期打包与磁盘源漂移。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AD_SIGNAL_CORPUS,
  corpusContentHash,
  corpusFileMeta,
  parseCorpusLine,
  parseCorpusSource,
} from './corpus'
import type { CorpusFileMeta } from './corpus'

/** 迁移回归基准：原 corpus.ts 内嵌的 77 条种子词，一条都不能丢。 */
const LEGACY_77 = [
  // script 29
  '恰饭', '恰饭时间', '恰个饭', '感谢赞助', '感谢金主', '金主爸爸', '本期视频由', '赞助播出',
  '赞助商', '商业推广', '广告时间', '广告来了', '广告植入', '带货', '带货时间', '种草',
  '安利一下', '推荐一下', '软广', '口播广告', '植入广告', '恰饭环节', '粉丝专属价', '粉丝优惠',
  '专属优惠', '内部价', '促销活动', '好物分享', '福利来了',
  // brand 26
  '华为', '小米', '苹果', 'iPhone', 'iPad', '三星', 'OPPO', 'vivo', '一加', '荣耀', '联想',
  '华硕', '戴尔', '惠普', '罗技', '机械键盘', '降噪耳机', '蓝牙耳机', '显示器', '扫地机器人',
  '充电宝', '投影仪', '游戏本', '智能手表', '会员', '联名款',
  // deal 22
  '优惠券', '优惠码', '领券', '满减', '折扣', '限时优惠', '评论区置顶', '下单链接', '购买链接',
  '链接在评论区', '橱窗', '小黄车', '团购', '拼团', '佣金', '返现', '双十一', '618', '大促',
  '秒杀', '预售', '定金',
]

const CORPUS_DIR = join(__dirname, 'corpus')

/** 从磁盘直接解析全部 md 词库（不经过构建期打包），与打包产物交叉核对。 */
function parseAllFromDisk(): ReturnType<typeof parseCorpusSource> {
  return readdirSync(CORPUS_DIR)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .flatMap((file) => {
      const meta = corpusFileMeta(file)
      return meta ? parseCorpusSource(readFileSync(join(CORPUS_DIR, file), 'utf8'), meta) : []
    })
}

describe('语料体检', () => {
  it('构建期打包产物与磁盘词库一致（打包不漂移）', () => {
    expect(parseAllFromDisk()).toEqual([...AD_SIGNAL_CORPUS])
  })

  it('全部词条非空、权重为正、品类归属合法', () => {
    for (const signal of AD_SIGNAL_CORPUS) {
      expect(signal.text.trim()).not.toBe('')
      expect(signal.weight).toBeGreaterThan(0)
      expect(signal.category).toMatch(/^(scripts|slang|deals|brands-)/)
    }
  })

  it('注释与空行不被当词，权重覆盖生效', () => {
    const meta: CorpusFileMeta = { category: 't', kind: 'brand', defaultWeight: 1 }
    expect(parseCorpusSource('# 注释\n\n词A|3\n词B\n', meta)).toEqual([
      { text: '词A', weight: 3, kind: 'brand', category: 't' },
      { text: '词B', weight: 1, kind: 'brand', category: 't' },
    ])
    expect(parseCorpusLine('   ', 1)).toBeNull()
    expect(parseCorpusLine('# 注释', 1)).toBeNull()
    expect(parseCorpusLine('|', 1)).toBeNull()
    expect(parseCorpusLine('|3', 1)).toBeNull()
    expect(parseCorpusLine('词|', 1)).toBeNull()
  })

  it('全库跨文件无重复词条', () => {
    const seen = new Set<string>()
    for (const signal of AD_SIGNAL_CORPUS) {
      expect(seen.has(signal.text), `重复词条: ${signal.text}`).toBe(false)
      seen.add(signal.text)
    }
  })

  it('迁移回归：原 77 条种子词全部保留', () => {
    const texts = new Set(AD_SIGNAL_CORPUS.map((signal) => signal.text))
    for (const legacy of LEGACY_77) {
      expect(texts.has(legacy), `迁移丢失: ${legacy}`).toBe(true)
    }
  })

  it('哈希确定；语料内容变化哈希必变（缓存失效依据）', () => {
    expect(corpusContentHash()).toMatch(/^[0-9a-f]{8}$/)
    expect(corpusContentHash()).toBe(corpusContentHash())
    const meta: CorpusFileMeta = { category: 't', kind: 'script', defaultWeight: 2 }
    const a = parseCorpusSource('词A\n', meta)
    const b = parseCorpusSource('词A\n词B\n', meta)
    expect(corpusContentHash(a)).not.toBe(corpusContentHash(b))
  })
})
