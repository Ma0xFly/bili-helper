// chrome.storage 的服务端替身：RAG 向量缓存（modules/ai/rag/cache.ts）与用户层词库
// 都经这个全局对象读写。做成「显式安装一个 shim」而不是把 cache.ts 抽象成存储接口，
// 是为了让端上与服务端跑同一份缓存代码路径——键构造、命中判定、清理策略零分叉。
//
// 语义对齐 Chrome StorageArea.get 的四种入参：字符串键、键数组、对象形（带默认值）、null（全量）。
// cache.ts 的 pruneStaleWindowVectors 依赖 null 全量读，必须支持。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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

/** 内存存储：测试与「不落盘」部署用。 */
export function createMemoryStorage(initial: Store = {}): StorageAreaShim {
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
  }
}

export interface FileStorageOptions {
  file: string
  /** 读写盘失败的上报口（只报状态与原因，绝不带值——缓存里可能有向量与词条，日志里不要）。 */
  onError?: (phase: 'read' | 'write', error: unknown) => void
}

/**
 * 文件存储：整份 JSON 落盘，写入走「临时文件 + rename」保证原子性
 * （进程在写一半时被杀不会留下截断的 JSON 让下次启动全量重算）。
 * 落盘是同步的：向量缓存写入本身很低频（语料/窗口各算一次才写一次），
 * 换来的是「写完即退出」不丢数据，以及调用方 await 之后文件必然已更新。
 */
export function createFileStorage(options: FileStorageOptions): StorageAreaShim {
  const store: Store = loadFromDisk(options)

  function persist(): void {
    try {
      mkdirSync(dirname(options.file), { recursive: true })
      const tmp = `${options.file}.tmp`
      writeFileSync(tmp, JSON.stringify(store), 'utf8')
      renameSync(tmp, options.file)
    } catch (error) {
      // 落盘失败只上报不抛：缓存写不进去的代价是下次重算，不该把检索链路带崩
      // （与端上 cache.ts 的「写失败静默」语义一致）。
      options.onError?.('write', error)
    }
  }

  return {
    async get(keys) {
      return pick(store, keys)
    },
    async set(items) {
      if (!isRecord(items)) throw new Error('storage.set 需要对象入参')
      Object.assign(store, items)
      persist()
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]
      persist()
    },
    async clear() {
      for (const key of Object.keys(store)) delete store[key]
      persist()
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

/** 安装全局 chrome.storage 替身（local 真实存储，sync/session 内存占位）。 */
export function installStorageShim(options: StorageShimOptions = {}): StorageAreaShim {
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
