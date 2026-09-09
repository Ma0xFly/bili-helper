import { beforeEach, vi } from 'vitest'

// chrome.storage mock —— 对象形 get 只返回「请求键 + 默认值」，贴合 Chrome StorageArea.get
// 的真实语义（未请求键不回显），避免 mock 语义污染单测断言。运行环境为 Node，扩展 API 需显式注入。

type StorageKeys = string | string[] | Record<string, unknown> | null | undefined

function createStorageArea() {
  const store = new Map<string, unknown>()

  const get = vi.fn(async (keys?: StorageKeys): Promise<Record<string, unknown>> => {
    if (keys == null) return Object.fromEntries(store)
    if (typeof keys === 'string') return store.has(keys) ? { [keys]: store.get(keys) } : {}
    if (Array.isArray(keys)) {
      const out: Record<string, unknown> = {}
      for (const key of keys) if (store.has(key)) out[key] = store.get(key)
      return out
    }
    // 对象形：默认值打底，已存键覆盖，不返回未请求键。
    const out: Record<string, unknown> = { ...keys }
    for (const key of Object.keys(keys)) if (store.has(key)) out[key] = store.get(key)
    return out
  })

  const set = vi.fn(async (items: Record<string, unknown>): Promise<void> => {
    for (const [key, value] of Object.entries(items)) store.set(key, value)
  })

  const remove = vi.fn(async (keys: string | string[]): Promise<void> => {
    for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key)
  })

  const clear = vi.fn(async (): Promise<void> => {
    store.clear()
  })

  return { get, set, remove, clear, _store: store }
}

const sync = createStorageArea()
const local = createStorageArea()
const session = createStorageArea()

;(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: { sync, local, session },
}

// 每个用例前清空存储与 mock 调用历史，避免用例间状态与调用次数串扰；
// 已安装的 storage 对象引用保持不变。
beforeEach(() => {
  vi.clearAllMocks()
  sync._store.clear()
  local._store.clear()
  session._store.clear()
})