// 检测结果缓存测试：指纹失效（端点/模型/语料变化即未命中）、负缓存、LRU 淘汰、脏数据容错。
import { beforeEach, describe, expect, it } from 'vitest'
import type { AiSettings } from '../../settings'
import { DEFAULT_SETTINGS } from '../../settings'
import {
  DETECT_CACHE_MAX_ENTRIES,
  detectCacheFingerprint,
  detectCacheKey,
  readDetectCache,
  writeDetectCache,
} from './result-cache'
import type { AdSegment } from '../port'

const ADS: AdSegment[] = [
  { start: 10, end: 30, product_name: 'X', ad_content: '', confidence: 0.9 },
]

function settingsOf(overrides: Partial<AiSettings> = {}): AiSettings {
  return {
    ...DEFAULT_SETTINGS,
    apiUrl: 'https://llm.example/v1',
    model: 'm-1',
    embedBaseUrl: 'https://emb.example',
    embedModel: 'emb-m',
    ...overrides,
  }
}

beforeEach(async () => {
  await chrome.storage.local.clear()
})

describe('检测结果缓存', () => {
  it('写入后同指纹命中；换模型/换端点/换语料 → 指纹不同 → 未命中', async () => {
    const base = await detectCacheFingerprint(settingsOf())
    const changedModel = await detectCacheFingerprint(settingsOf({ model: 'm-2' }))
    const changedDetectModel = await detectCacheFingerprint(settingsOf({ detectModel: 'cheap' }))
    const changedEmbed = await detectCacheFingerprint(settingsOf({ embedModel: 'emb-2' }))
    const changedMode = await detectCacheFingerprint(settingsOf({ mode: 'server' }))
    expect(new Set([base, changedModel, changedDetectModel, changedEmbed, changedMode]).size).toBe(5)

    await writeDetectCache('BV1', 1, { ads: ADS, source: 'rag', fingerprint: base })
    const hit = await readDetectCache('BV1', 1, base)
    expect(hit?.ads).toEqual(ADS)
    expect(await readDetectCache('BV1', 1, changedModel)).toBeNull()
    expect(await readDetectCache('BV1', 1, changedDetectModel)).toBeNull()

    // 用户补录改变生效语料 → 指纹变化（语料哈希入指纹）。
    await chrome.storage.local.set({
      biliHelperUserCorpus: [{ text: '某新品牌', category: 'brands-digital' }],
    })
    expect(await detectCacheFingerprint(settingsOf())).not.toBe(base)
  })

  it('负缓存同样可读：「没广告」的结论也缓存', async () => {
    const fingerprint = await detectCacheFingerprint(settingsOf())
    await writeDetectCache('BV2', 2, { ads: [], source: 'none', fingerprint })
    const hit = await readDetectCache('BV2', 2, fingerprint)
    expect(hit?.ads).toEqual([])
    expect(hit?.source).toBe('none')
  })

  it('LRU 淘汰：超过上限后最旧条目被清，最新保留', async () => {
    const fingerprint = await detectCacheFingerprint(settingsOf())
    for (let i = 0; i < DETECT_CACHE_MAX_ENTRIES + 10; i += 1) {
      await writeDetectCache(`BV${i}`, 1, { ads: [], source: 'none', fingerprint })
      // savedAt 同毫秒会打乱 LRU 顺序：逐条写 + 下一条触发淘汰时已可分辨先后。
    }
    const all = (await chrome.storage.local.get(null)) as Record<string, unknown>
    const keys = Object.keys(all).filter((key) => key.startsWith('biliHelperDetectCache:'))
    expect(keys.length).toBeLessThanOrEqual(DETECT_CACHE_MAX_ENTRIES)
    // 最新的（最后写入的 BV209）必须在场；最早的（BV0）应被淘汰。
    expect(all[detectCacheKey('BV209', 1)]).toBeDefined()
    expect(all[detectCacheKey('BV0', 1)]).toBeUndefined()
  })

  it('脏数据容错：形状不符/字段缺失按未命中，绝不带崩主链路', async () => {
    await chrome.storage.local.set({
      [detectCacheKey('BV3', 3)]: { ads: 'not-an-array', fingerprint: 'f', savedAt: 1 },
      [detectCacheKey('BV4', 4)]: { ads: [{ start: 5, end: 1 }], source: 'rag', fingerprint: 'f', savedAt: 1 },
      [detectCacheKey('BV5', 5)]: null,
    })
    expect(await readDetectCache('BV3', 3, 'f')).toBeNull()
    expect(await readDetectCache('BV4', 4, 'f')).toBeNull() // 起止颠倒的段判脏
    expect(await readDetectCache('BV5', 5, 'f')).toBeNull()
  })
})
