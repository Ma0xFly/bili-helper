import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFileStorage, createMemoryStorage, installStorageShim } from './storage'

const originalChrome = (globalThis as { chrome?: unknown }).chrome

afterEach(() => {
  ;(globalThis as { chrome?: unknown }).chrome = originalChrome
  vi.restoreAllMocks()
})

function tempFile(): { file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bh-server-storage-'))
  return { dir, file: join(dir, 'cache.json') }
}

describe('createMemoryStorage（get 四种入参语义）', () => {
  it('字符串键：命中回显、未命中不回显', async () => {
    const storage = createMemoryStorage()
    await storage.set({ a: 1 })
    expect(await storage.get('a')).toEqual({ a: 1 })
    expect(await storage.get('missing')).toEqual({})
  })

  it('键数组：只回显存在的键', async () => {
    const storage = createMemoryStorage({ a: 1, b: 2 })
    expect(await storage.get(['a', 'zz'])).toEqual({ a: 1 })
  })

  it('对象形：默认值打底，已存键覆盖，不回显未请求键', async () => {
    const storage = createMemoryStorage({ a: 'stored' })
    expect(await storage.get({ a: 'fallback', b: 'fallback-b' })).toEqual({
      a: 'stored',
      b: 'fallback-b',
    })
  })

  it('null/undefined：全量回显（pruneStaleWindowVectors 依赖这个语义）', async () => {
    const storage = createMemoryStorage({ a: 1, b: 2 })
    expect(await storage.get(null)).toEqual({ a: 1, b: 2 })
    expect(await storage.get()).toEqual({ a: 1, b: 2 })
  })

  it('remove 支持单键与数组，clear 清空', async () => {
    const storage = createMemoryStorage({ a: 1, b: 2, c: 3 })
    await storage.remove('a')
    await storage.remove(['b'])
    expect(await storage.get(null)).toEqual({ c: 3 })
    await storage.clear()
    expect(await storage.get(null)).toEqual({})
  })

  it('set 非对象入参报错，不静默吞掉', async () => {
    const storage = createMemoryStorage()
    await expect(storage.set('nope' as unknown as Record<string, unknown>)).rejects.toThrow()
  })
})

describe('createFileStorage（落盘与重启）', () => {
  it('flush 后落盘，重新打开能读回（去抖窗口里的变更不丢）', async () => {
    const { file, dir } = tempFile()
    try {
      const first = createFileStorage({ file })
      await first.set({ 'biliHelperRagVectorCache:corpus:m:b:h': { vectors: [[1, 0]] } })
      await first.flush()
      expect(existsSync(file)).toBe(true)

      const reopened = createFileStorage({ file })
      expect(await reopened.get(null)).toEqual({
        'biliHelperRagVectorCache:corpus:m:b:h': { vectors: [[1, 0]] },
      })
      // 临时文件不该残留（写完即 rename）。
      expect(existsSync(`${file}.tmp`)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('落盘是去抖异步的：set 后立刻查盘还没写，等过窗口才落', async () => {
    const { file, dir } = tempFile()
    try {
      const storage = createFileStorage({ file, persistDebounceMs: 20 })
      await storage.set({ k: 'v' })
      expect(existsSync(file)).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ k: 'v' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flush 不等去抖窗口：立即把待写变更冲出去', async () => {
    const { file, dir } = tempFile()
    try {
      const storage = createFileStorage({ file, persistDebounceMs: 60_000 })
      await storage.set({ k: 'v' })
      await storage.flush()
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ k: 'v' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('目录不存在时自动创建', async () => {
    const { dir } = tempFile()
    const nested = join(dir, 'a', 'b', 'cache.json')
    try {
      const storage = createFileStorage({ file: nested })
      await storage.set({ k: 'v' })
      await storage.flush()
      expect(JSON.parse(readFileSync(nested, 'utf8'))).toEqual({ k: 'v' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('文件损坏/非对象 → 当空缓存启动，不让服务起不来', async () => {
    const { file, dir } = tempFile()
    try {
      writeFileSync(file, '{"截断的 JSON', 'utf8')
      const onError = vi.fn()
      const storage = createFileStorage({ file, onError })
      expect(await storage.get(null)).toEqual({})
      expect(onError).toHaveBeenCalledTimes(1)
      expect(onError.mock.calls[0]?.[0]).toBe('read')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('首次启动无文件不报错（ENOENT 不算异常）', async () => {
    const { file, dir } = tempFile()
    try {
      const onError = vi.fn()
      const storage = createFileStorage({ file, onError })
      expect(await storage.get(null)).toEqual({})
      expect(onError).not.toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('落盘失败只上报不抛（缓存写不进的代价是下次重算，不该带崩链路）', async () => {
    const onError = vi.fn()
    // 指向一个不可能写入的路径（把已存在的文件当目录用）：读与写都会失败，但都不该抛出。
    const { file, dir } = tempFile()
    try {
      writeFileSync(file, '{}', 'utf8')
      const storage = createFileStorage({ file: join(file, 'nested.json'), onError })
      await expect(storage.set({ k: 'v' })).resolves.toBeUndefined()
      await storage.flush()
      expect(onError.mock.calls.map((call) => call[0])).toContain('write')
      // 内存态仍然可用：本次进程内缓存照常命中。
      expect(await storage.get('k')).toEqual({ k: 'v' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('installStorageShim', () => {
  it('装上 chrome.storage 三个区，local 按 file 选项决定落盘或内存，返回值带 flush', async () => {
    const { file, dir } = tempFile()
    try {
      const local = installStorageShim({ file })
      const chrome = (globalThis as unknown as { chrome: { storage: Record<string, unknown> } }).chrome
      expect(chrome.storage.local).toBe(local)
      expect(chrome.storage.sync).toBeDefined()
      expect(chrome.storage.session).toBeDefined()

      await local.set({ k: 'v' })
      await local.flush()
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ k: 'v' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('未给 file 时用内存存储（重启后重算，不写盘），flush 是无操作', async () => {
    const local = installStorageShim()
    await local.set({ k: 'v' })
    await expect(local.flush()).resolves.toBeUndefined()
    expect(await local.get('k')).toEqual({ k: 'v' })
  })
})
