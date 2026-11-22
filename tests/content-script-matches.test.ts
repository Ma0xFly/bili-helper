// 内容脚本 matches 防回归断言：三个入口脚本的注入面是纯配置（删错一行静默失效，
// 运行时无任何报错），这里读源码文本做结构化断言（仿 theme-tokens 源码检查风格）。
// 语义背景：Chrome match pattern 用 path+query 参与匹配——裸 / 只匹配无 query 的首页；
// 带 query 的深链必须显式列出，且参数序不定（/?spm_id_from=x&page=WatchLater）要通配。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// fileURLToPath 而非 .pathname：路径含空格/编码字符时 URL pathname 会坏。
const ROOT = fileURLToPath(new URL('..', import.meta.url))

function read(relPath: string): string {
  return readFileSync(`${ROOT}${relPath}`, 'utf8')
}

/** 从入口脚本源码抽出 matches 数组里的 pattern 字符串（解析器失效时空集会立刻暴露）。 */
function matchesIn(source: string, label: string): string[] {
  const start = source.indexOf('matches: [')
  expect(start, `${label} 缺少 matches 数组`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(']', start)
  expect(end, `${label} matches 数组未闭合`).toBeGreaterThan(start)
  const block = source.slice(start, end)
  const patterns = [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]!)
  expect(patterns.length, `${label} matches 数组解析为空`).toBeGreaterThan(0)
  return patterns
}

const aiScript = matchesIn(read('entrypoints/content/index.ts'), 'AI 脚本')
const featuresScript = matchesIn(read('entrypoints/features.content.ts'), '功能组脚本')
const interceptScript = matchesIn(read('entrypoints/intercept.content.ts'), '主世界拦截脚本')

/** AI 脚本（稍后再看两入口 + 视频页）：列表播放页、首页深链（含 index.html 变体）与 SPA 入口。 */
const AI_PATTERNS = [
  'https://www.bilibili.com/video/*',
  'https://www.bilibili.com/list/*',
  'https://www.bilibili.com/',
  'https://www.bilibili.com/index.html',
  'https://www.bilibili.com/?*page=WatchLater*',
  'https://www.bilibili.com/index.html?*page=WatchLater*',
]

/** 功能组/主世界拦截脚本：首页 query 深链任意参数序 + index.html 变体 + 既有注入面。 */
const HOME_SURFACE_PATTERNS = [
  'https://www.bilibili.com/',
  'https://www.bilibili.com/index.html',
  'https://www.bilibili.com/?*page=*',
  'https://www.bilibili.com/index.html?*page=*',
  'https://www.bilibili.com/video/*',
  'https://www.bilibili.com/list/*',
  'https://www.bilibili.com/v/popular/*',
  'https://search.bilibili.com/*',
]

describe('content script matches 关键 pattern（配置防回归）', () => {
  it('AI 脚本：视频页 + 列表播放页 + 首页 WatchLater 深链/SPA 入口全覆盖', () => {
    for (const pattern of AI_PATTERNS) {
      expect(aiScript, `AI 脚本 matches 缺少 ${pattern}`).toContain(pattern)
    }
  })

  it('功能组脚本：首页 query 深链（任意参数序）与 index.html 变体注入', () => {
    for (const pattern of HOME_SURFACE_PATTERNS) {
      expect(featuresScript, `功能组脚本 matches 缺少 ${pattern}`).toContain(pattern)
    }
  })

  it('主世界拦截脚本：与功能组脚本同注入面', () => {
    for (const pattern of HOME_SURFACE_PATTERNS) {
      expect(interceptScript, `拦截脚本 matches 缺少 ${pattern}`).toContain(pattern)
    }
  })

  it('三脚本 matches 均无重复 pattern（重复项是编辑事故信号）', () => {
    for (const [label, patterns] of [
      ['AI 脚本', aiScript],
      ['功能组脚本', featuresScript],
      ['拦截脚本', interceptScript],
    ] as const) {
      expect(new Set(patterns).size, `${label} matches 存在重复项`).toBe(patterns.length)
    }
  })
})
