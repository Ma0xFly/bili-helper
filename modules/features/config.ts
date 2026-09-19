// 功能配置单一来源（第二阶段：过滤视频 / 功能增强；布局优化与换一换历史按产品裁决移除）。
// 形状沿用旧产物验证过的两层结构：`biliHelperFeatures` 存 `{ [featureId]: { ...配置, enabled } }`、
// `biliHelperFeatureStats` 存 `{ [featureId]: { statsDate, totalBlocked } }`（跨日自动归零）。
// 纪律与 settings/user-corpus 一致：其他层禁止直接读写这两个键自造形状；
// 读侧一律归一（脏数据不落库、不炸功能），写侧读改写串行化（并发开关不互相覆盖），
// 写失败必须上抛——静默成功会让界面报「已保存」而实际什么都没存下。
// 全部功能默认关闭。历史存储里可能残留已移除功能的键：读侧只认注册表，残留被自然忽略。

export type FeatureGroupId = 'filter' | 'enhance'
export type FeatureAppliesTo = '首页' | '视频页' | '热门' | '搜索'

export const FEATURE_STORAGE_KEY = 'biliHelperFeatures'
export const FEATURE_STATS_STORAGE_KEY = 'biliHelperFeatureStats'

/** 功能配置写操作单步超时：扩展上下文失效时 storage promise 可能永不落定。 */
export const FEATURE_STORAGE_STEP_TIMEOUT_MS = 10_000

export const FEATURE_GROUPS: { id: FeatureGroupId; title: string }[] = [
  { id: 'filter', title: '过滤视频' },
  { id: 'enhance', title: '功能增强' },
]

/** 视频筛选的八维度取值形状（语义见 PRD FR-1；null = 不限）。 */
export interface VideoFilterConfig {
  titleKeywords: string[]
  authorBlacklist: string[]
  durationMinSeconds: number | null
  durationMaxSeconds: number | null
  danmakuMin: number | null
  danmakuMax: number | null
  likeMin: number | null
  likeMax: number | null
  viewMin: number | null
  viewMax: number | null
  likeRateMin: number | null
  likeRateMax: number | null
  pubdateMinDays: number | null
  pubdateMaxDays: number | null
}

export interface SteplessRateConfig {
  rate: number
}

/** 各功能配置的精确形状（enabled 由外层统一补，不进各 config 类型）。 */
export interface FeatureConfigShapes {
  videoFilter: VideoFilterConfig
  adVideoBlocker: Record<string, never>
  promotedVideoBlocker: Record<string, never>
  labelVideoBlocker: Record<string, never>
  steplessVideoRate: SteplessRateConfig
  commentIpLocation: Record<string, never>
}

export type FeatureId = keyof FeatureConfigShapes

export interface FeatureDefinition<K extends FeatureId = FeatureId> {
  id: K
  group: FeatureGroupId
  title: string
  description: string
  /** 适用注入面（可多面：视频筛选覆盖首页推荐 + 热门 + 搜索）。 */
  appliesTo: FeatureAppliesTo[]
  /** 该功能是否参与「今日拦截」类日统计（只有两个 DOM 拦截器参与）。 */
  counted: boolean
  defaults: FeatureConfigShapes[K]
  normalize: (raw: unknown) => FeatureConfigShapes[K]
}

// ---------- 归一化小工具 ----------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** 非负有限数（可为小数）；非法/负数 → fallback。 */
function asCount(value: unknown, fallback: number | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
  return value
}

/** 非负整数；非法 → fallback。 */
function asInt(value: unknown, fallback: number | null): number | null {
  const n = asCount(value, null)
  return n === null ? fallback : Math.round(n)
}

/** 文本列表：按换行/英文或中文逗号分割，trim、去空、去重、保序。 */
function asTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    for (const part of item.split(/[\n,，]/u)) {
      const text = part.trim()
      if (text === '' || seen.has(text)) continue
      seen.add(text)
      out.push(text)
    }
  }
  return out
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

// ---------- 功能注册表 ----------

const EMPTY_CONFIG_NORMALIZER = (): Record<string, never> => ({})

function normalizeVideoFilter(raw: unknown): VideoFilterConfig {
  const source = asRecord(raw)
  const num = (key: keyof VideoFilterConfig & string): number | null =>
    asCount(source[key], null)
  const int = (key: keyof VideoFilterConfig & string): number | null => asInt(source[key], null)
  return {
    titleKeywords: asTextList(source.titleKeywords),
    authorBlacklist: asTextList(source.authorBlacklist),
    durationMinSeconds: int('durationMinSeconds'),
    durationMaxSeconds: int('durationMaxSeconds'),
    danmakuMin: int('danmakuMin'),
    danmakuMax: int('danmakuMax'),
    likeMin: int('likeMin'),
    likeMax: int('likeMax'),
    viewMin: int('viewMin'),
    viewMax: int('viewMax'),
    likeRateMin: num('likeRateMin'),
    likeRateMax: num('likeRateMax'),
    pubdateMinDays: int('pubdateMinDays'),
    pubdateMaxDays: int('pubdateMaxDays'),
  }
}

const VIDEO_FILTER_DEFAULTS: VideoFilterConfig = {
  titleKeywords: [],
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

export const STEPLESS_RATE_MIN = 0.1
export const STEPLESS_RATE_MAX = 5

function normalizeSteplessRate(raw: unknown): SteplessRateConfig {
  const source = asRecord(raw)
  const rate = asCount(source.rate, 1) ?? 1
  const clamped = Math.min(STEPLESS_RATE_MAX, Math.max(STEPLESS_RATE_MIN, rate))
  return { rate: Math.round(clamped * 100) / 100 }
}

export const FEATURE_REGISTRY: { [K in FeatureId]: FeatureDefinition<K> } = {
  videoFilter: {
    id: 'videoFilter',
    group: 'filter',
    title: '视频筛选',
    description:
      '按标题、时长、互动数据（含点赞率）、发布日期和作者黑名单筛选首页推荐、热门与搜索结果里的普通视频。',
    appliesTo: ['首页', '热门', '搜索'],
    counted: false,
    defaults: VIDEO_FILTER_DEFAULTS,
    normalize: normalizeVideoFilter,
  },
  adVideoBlocker: {
    id: 'adVideoBlocker',
    group: 'filter',
    title: '广告视频',
    description: '过滤首页带「广告」标识的商业推广内容。',
    appliesTo: ['首页'],
    counted: true,
    defaults: {},
    normalize: EMPTY_CONFIG_NORMALIZER,
  },
  promotedVideoBlocker: {
    id: 'promotedVideoBlocker',
    group: 'filter',
    title: '推广视频',
    description: '过滤首页「小火箭」标识的推广/充电视频，还原真实推荐流。',
    appliesTo: ['首页'],
    counted: true,
    defaults: {},
    normalize: EMPTY_CONFIG_NORMALIZER,
  },
  labelVideoBlocker: {
    id: 'labelVideoBlocker',
    group: 'filter',
    title: '标签视频',
    description: '过滤首页直播、番剧、综艺、课堂等非普通视频卡片，让推荐流更纯粹。',
    appliesTo: ['首页'],
    counted: false,
    defaults: {},
    normalize: EMPTY_CONFIG_NORMALIZER,
  },
  steplessVideoRate: {
    id: 'steplessVideoRate',
    group: 'enhance',
    title: '无级倍速',
    description: '接管播放器倍速：0.1x–5.0x 无级滑杆，一次设置持续生效。',
    appliesTo: ['视频页'],
    counted: false,
    defaults: { rate: 1 },
    normalize: normalizeSteplessRate,
  },
  commentIpLocation: {
    id: 'commentIpLocation',
    group: 'enhance',
    title: '评论 IP 归属',
    description: '在视频评论区的用户名右侧显示用户 IP 归属地。',
    appliesTo: ['视频页'],
    counted: false,
    defaults: {},
    normalize: EMPTY_CONFIG_NORMALIZER,
  },
}

export const FEATURE_IDS = Object.keys(FEATURE_REGISTRY) as FeatureId[]

/** 单条配置项（配置体 + enabled），全部功能共用这一层形状。 */
export interface FeatureEntry<K extends FeatureId = FeatureId> {
  config: FeatureConfigShapes[K]
  enabled: boolean
}

export type FeatureConfigMap = { [K in FeatureId]: FeatureEntry<K> }

/** 读侧归一：脏值收敛到默认/合法域，enabled 非布尔回 defaultEnabled（全 false）。 */
export function normalizeFeatureEntry<K extends FeatureId>(id: K, raw: unknown): FeatureEntry<K> {
  const definition = FEATURE_REGISTRY[id]
  const source = asRecord(raw)
  const configSource = asRecord(source.config)
  return {
    config: { ...definition.defaults, ...definition.normalize(configSource) },
    enabled: asBool(source.enabled, false),
  }
}

function normalizeFeatureMap(raw: unknown): FeatureConfigMap {
  const source = asRecord(raw)
  // 中间用宽类型收集（mapped-type 的逐键赋值在 TS 里要过一次显式收敛），出口整体归到精确形状。
  const map: Record<string, FeatureEntry> = {}
  for (const id of FEATURE_IDS) {
    map[id] = normalizeFeatureEntry(id, source[id])
  }
  return map as FeatureConfigMap
}

// ---------- 读写（读侧不落库；写侧串行链 + 上抛失败） ----------

async function withTimeout<T>(step: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      step,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`功能配置存储操作超过 ${FEATURE_STORAGE_STEP_TIMEOUT_MS}ms 未响应`)),
          FEATURE_STORAGE_STEP_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 读全部功能配置：缺失功能回默认值且不写回存储。 */
export async function readFeatureConfigs(): Promise<FeatureConfigMap> {
  const result = await withTimeout(chrome.storage.local.get(FEATURE_STORAGE_KEY))
  return normalizeFeatureMap((result as Record<string, unknown>)[FEATURE_STORAGE_KEY])
}

export async function readFeatureConfig<K extends FeatureId>(id: K): Promise<FeatureEntry<K>> {
  const result = await withTimeout(chrome.storage.local.get(FEATURE_STORAGE_KEY))
  const raw = (result as Record<string, unknown>)[FEATURE_STORAGE_KEY]
  const map = normalizeFeatureMap(raw)
  return map[id]
}

// 写链：读改写必须串行（设置页连点两次开关不能互相覆盖）。
let writeChain: Promise<unknown> = Promise.resolve()

export async function writeFeatureConfig<K extends FeatureId>(
  id: K,
  patch: Partial<FeatureConfigShapes[K]> & { enabled?: boolean },
): Promise<FeatureEntry<K>> {
  const run = async (): Promise<FeatureEntry<K>> => {
    const result = await withTimeout(chrome.storage.local.get(FEATURE_STORAGE_KEY))
    const raw = asRecord((result as Record<string, unknown>)[FEATURE_STORAGE_KEY])
    const current = normalizeFeatureEntry(id, raw[id])
    const nextConfig = { ...current.config, ...patch }
    const next: FeatureEntry<K> = {
      config: { ...FEATURE_REGISTRY[id].defaults, ...FEATURE_REGISTRY[id].normalize(nextConfig) },
      enabled: patch.enabled === undefined ? current.enabled : patch.enabled === true,
    }
    await withTimeout(
      chrome.storage.local.set({
        [FEATURE_STORAGE_KEY]: { ...raw, [id]: { config: next.config, enabled: next.enabled } },
      }),
    )
    return next
  }
  const chained = writeChain.then(run, run)
  writeChain = chained.catch(() => undefined)
  return chained
}

export async function setFeatureEnabled(id: FeatureId, enabled: boolean): Promise<FeatureEntry> {
  return writeFeatureConfig(id, { enabled } as never)
}

// ---------- 日统计（「今日拦截」，跨日自动归零） ----------

export interface FeatureStatEntry {
  statsDate: string
  totalBlocked: number
}

function todayKey(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 读日统计：跨日条目在读取时归零并写回（沿用旧产物的读取时重置语义）。 */
export async function readFeatureStats(): Promise<Partial<Record<FeatureId, FeatureStatEntry>>> {
  const result = await withTimeout(chrome.storage.local.get(FEATURE_STATS_STORAGE_KEY))
  const raw = asRecord((result as Record<string, unknown>)[FEATURE_STATS_STORAGE_KEY])
  const today = todayKey()
  const out: Partial<Record<FeatureId, FeatureStatEntry>> = {}
  let dirty = false
  for (const id of FEATURE_IDS) {
    if (!(id in raw)) continue
    const entry = asRecord(raw[id])
    const statsDate = typeof entry.statsDate === 'string' ? entry.statsDate : ''
    const totalBlocked = asInt(entry.totalBlocked, 0) ?? 0
    if (statsDate !== today) {
      out[id] = { statsDate: today, totalBlocked: 0 }
      raw[id] = out[id]
      dirty = true
    } else {
      out[id] = { statsDate, totalBlocked }
    }
  }
  if (dirty) {
    try {
      await withTimeout(chrome.storage.local.set({ [FEATURE_STATS_STORAGE_KEY]: raw }))
    } catch {
      // 归零写回失败不阻塞读取（下次读取会再次尝试）。
    }
  }
  return out
}

/** 拦截计数 +N（默认 1；跨日先归零），返回今日累计。 */
export async function bumpFeatureStat(id: FeatureId, by = 1, now = new Date()): Promise<number> {
  const increment = Math.max(1, Math.round(by))
  const run = async (): Promise<number> => {
    const result = await withTimeout(chrome.storage.local.get(FEATURE_STATS_STORAGE_KEY))
    const raw = asRecord((result as Record<string, unknown>)[FEATURE_STATS_STORAGE_KEY])
    const today = todayKey(now)
    const entry = asRecord(raw[id])
    const current =
      typeof entry.statsDate === 'string' && entry.statsDate === today ? (asInt(entry.totalBlocked, 0) ?? 0) : 0
    const next = { statsDate: today, totalBlocked: current + increment }
    await withTimeout(
      chrome.storage.local.set({ [FEATURE_STATS_STORAGE_KEY]: { ...raw, [id]: next } }),
    )
    return next.totalBlocked
  }
  const chained = writeChain.then(run, run)
  writeChain = chained.catch(() => undefined)
  return chained
}

/** 清空功能配置与统计（测试/排障用）。 */
export async function clearFeatureStorage(): Promise<void> {
  await chrome.storage.local.remove([FEATURE_STORAGE_KEY, FEATURE_STATS_STORAGE_KEY])
}
