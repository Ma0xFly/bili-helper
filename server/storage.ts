// chrome.storage 的服务端替身：RAG 向量缓存（modules/ai/rag/cache.ts）与用户层词库
// 都经这个全局对象读写。做成「显式安装一个 shim」而不是把 cache.ts 抽象成存储接口，
// 是为了让端上与服务端跑同一份缓存代码路径——键构造、命中判定、清理策略零分叉。
//
// 语义对齐 Chrome StorageArea.get 的四种入参：字符串键、键数组、对象形（带默认值）、null（全量）。
// cache.ts 的 pruneStaleWindowVectors 依赖 null 全量读，必须支持。

import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

type Store = Record<string, unknown>
type GetKeys = string | string[] | Record<string, unknown> | null | undefined

export interface StorageAreaShim {
  get(keys?: GetKeys): Promise<Record<string, unknown>>
  set(items: Store): Promise<void>
  remove(keys: string | string[]): Promise<void>
  clear(): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pick(store: Store, keys: GetKeys): Record<string, unknown> {
  if (keys == null) return { ...store }
  if (typeof keys === 'string') return keys in store ? { [keys]: store[keys] } : {}
  if (Array.isArray(keys)) {
    const out: Record<string, unknown> = {}
    for (const key of keys) if (key in store) out[key] = store[key]
    return out
  }
  // 对象形：默认值打底，已存键覆盖，不回显未请求的键。
  const out: Record<string, unknown> = { ...keys }
  for (const key of Object.keys(keys)) if (key in store) out[key] = store[key]
  return out
}

/**
 * 内存存储：测试与「不落盘」部署用。flush 是无操作——统一两个实现的接口形状，
 * 调用方（index.ts 的退出钩子）不必按落盘与否分支。
 */
export function createMemoryStorage(initial: Store = {}): FileStorage {
  const store: Store = { ...initial }
  return {
    async get(keys) {
      return pick(store, keys)
    },
    async set(items) {
      if (!isRecord(items)) throw new Error('storage.set 需要对象入参')
      Object.assign(store, items)
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]
    },
    async clear() {
      for (const key of Object.keys(store)) delete store[key]
    },
    async flush() {
      /* 内存存储没有落盘窗口，无可冲刷 */
    },
  }
}

export interface FileStorageOptions {
  file: string
  /** 读写盘失败的上报口（只报状态与原因，绝不带值——缓存里可能有向量与词条，日志里不要）。 */
  onError?: (phase: 'read' | 'write', error: unknown) => void
  /** 落盘去抖窗口：一次识别会连着写语料向量与窗口向量，合并成一轮写。 */
  persistDebounceMs?: number
}

/** 可等待落盘的存储：进程退出前要把去抖窗口里的变更冲出去，否则白算一次向量。 */
export interface FileStorage extends StorageAreaShim {
  /** 立即落盘并等待完成（关闭钩子与测试用）。 */
  flush(): Promise<void>
}

const DEFAULT_PERSIST_DEBOUNCE_MS = 500

/**
 * 文件存储：整份 JSON 落盘，写入走「临时文件 + rename」保证原子性
 * （进程在写一半时被杀不会留下截断的 JSON 让下次启动全量重算）。
 *
 * 落盘是**异步 + 去抖 + 单飞**的：缓存值是 MB 级向量，同步整份写会把事件循环卡住几十到几百毫秒，
 * 期间所有并发 SSE 流与请求一起停摆。去抖把一次识别里的多次写合并成一轮，
 * 单飞保证并发写不互相交叠，退出前用 flush() 兜住最后一轮。
 */
export function createFileStorage(options: FileStorageOptions): FileStorage {
  const store: Store = loadFromDisk(options)
  const debounceMs = options.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  let drainPromise: Promise<void> | null = null
  let pendingWrite = false

  async function writeSnapshot(): Promise<void> {
    const snapshot = JSON.stringify(store)
    try {
      await mkdir(dirname(options.file), { recursive: true })
      const tmp = `${options.file}.tmp`
      await writeFile(tmp, snapshot, 'utf8')
      await rename(tmp, options.file)
    } catch (error) {
      // 落盘失败只上报不抛：缓存写不进去的代价是下次重算，不该把检索链路带崩
      // （与端上 cache.ts 的「写失败静默」语义一致）。
      options.onError?.('write', error)
    }
  }

  function drain(): Promise<void> {
    if (drainPromise) return drainPromise
    drainPromise = (async () => {
      try {
        while (pendingWrite) {
          pendingWrite = false
          await writeSnapshot()
        }
      } finally {
        drainPromise = null
      }
    })()
    return drainPromise
  }

  function schedulePersist(): void {
    pendingWrite = true
    // 已有写入在跑：它会在循环里带走这次变更，不必再排定时器。
    if (timer !== undefined || drainPromise !== null) return
    timer = setTimeout(() => {
      timer = undefined
      void drain()
    }, debounceMs)
    // 别让落盘定时器吊住进程退出。
    timer.unref?.()
  }

  return {
    async get(keys) {
      return pick(store, keys)
    },
    async set(items) {
      if (!isRecord(items)) throw new Error('storage.set 需要对象入参')
      Object.assign(store, items)
      schedulePersist()
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]
      schedulePersist()
    },
    async clear() {
      for (const key of Object.keys(store)) delete store[key]
      schedulePersist()
    },
    async flush() {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      if (drainPromise !== null) await drainPromise
      // 上一轮可能在本次变更之前就开始了，这里再排一轮把余量带走。
      if (pendingWrite) await drain()
    },
  }
}

function loadFromDisk(options: FileStorageOptions): Store {
  try {
    const raw = readFileSync(options.file, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch (error) {
    // 首次启动没有文件是正常的；损坏/不可读也只当空缓存（重算即可），不让服务起不来。
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') options.onError?.('read', error)
    return {}
  }
}

export interface StorageShimOptions {
  /** 落盘文件；为空则用内存存储。 */
  file?: string
  onError?: (phase: 'read' | 'write', error: unknown) => void
}

/** 安装全局 chrome.storage 替身（local 真实存储，sync/session 内存占位）。返回值带 flush，退出钩子用。 */
export function installStorageShim(options: StorageShimOptions = {}): FileStorage {
  const local =
    options.file && options.file !== ''
      ? createFileStorage({ file: options.file, onError: options.onError })
      : createMemoryStorage()
  const target = globalThis as { chrome?: unknown }
  target.chrome = {
    storage: {
      local,
      // 服务端不从 storage 读设置（配置来自环境变量），sync/session 只为形状完整。
      sync: createMemoryStorage(),
      session: createMemoryStorage(),
    },
  }
  return local
}
