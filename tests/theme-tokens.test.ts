// 设计 token 防漂移测试：扩展页面（modules/shared/theme.css）与内容脚本浮层
// （entrypoints/content/ui/overlay.css）**同键名必须同取值**——两处各改一边是最容易发生的
// 设计退化（设置页和页内浮层慢慢变成两个产品）。uno.config.ts 的 utility 主题色同样对账。
//
// 只校验两边都登记的交集：各自专有的 token（浮层的 skeleton/tip、页面的 terminal 族）不比较。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const ROOT = new URL('..', import.meta.url).pathname

function read(relPath: string): string {
  return readFileSync(`${ROOT}${relPath}`, 'utf8')
}

/** 抽出某个 CSS 块内的 `--bh-k: v;` 声明（块用「起始行前缀」定位，取到首个顶格 `}` 为止）。 */
function tokensIn(css: string, blockStart: string): Map<string, string> {
  const lines = css.split('\n')
  const start = lines.findIndex((line) => line.trim().startsWith(blockStart))
  expect(start, `找不到块：${blockStart}`).toBeGreaterThanOrEqual(0)
  const out = new Map<string, string>()
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (line.trim() === '}') break
    const match = line.match(/^\s*(--bh-[a-z0-9-]+)\s*:\s*(.+?);\s*$/)
    if (match && match[1] && match[2]) out.set(match[1], match[2].trim().toLowerCase())
  }
  return out
}

const overlay = read('entrypoints/content/ui/overlay.css')
const theme = read('modules/shared/theme.css')
const uno = read('uno.config.ts')

const overlayLight = tokensIn(overlay, '.bh-root {')
const overlayDark = tokensIn(overlay, '.bh-root[data-dark] {')
const themeLight = tokensIn(theme, ':root {')
const themeDark = tokensIn(theme, '@media (prefers-color-scheme: dark)')

describe('token 登记处一致性', () => {
  it('两处登记处都能解析出足量 token（解析器失效时立刻暴露，而不是空集通过）', () => {
    expect(overlayLight.size).toBeGreaterThan(20)
    expect(overlayDark.size).toBeGreaterThan(20)
    expect(themeLight.size).toBeGreaterThan(40)
    expect(themeDark.size).toBeGreaterThan(40)
  })

  it('亮色：同名 token 取值一致', () => {
    const mismatches: string[] = []
    for (const [key, value] of overlayLight) {
      const pageValue = themeLight.get(key)
      if (pageValue !== undefined && pageValue !== value) {
        mismatches.push(`${key}: 浮层 ${value} ≠ 页面 ${pageValue}`)
      }
    }
    expect(mismatches).toEqual([])
  })

  it('暗色：同名 token 取值一致', () => {
    const mismatches: string[] = []
    for (const [key, value] of overlayDark) {
      const pageValue = themeDark.get(key)
      if (pageValue !== undefined && pageValue !== value) {
        mismatches.push(`${key}: 浮层 ${value} ≠ 页面 ${pageValue}`)
      }
    }
    expect(mismatches).toEqual([])
  })

  /**
   * 模式不变量：终端族刻意常暗（控制台在亮色下也是黑底），字体族与配色无关。
   * 它们必须在暗色块里**不被覆盖**——要改这条设计意图，先把它从这个清单里拿掉。
   */
  const MODE_INVARIANT = /^--bh-term-|^--bh-font-family$/

  it('亮暗成对：除模式不变量外，每个亮色 token 都有暗色对应（真诚的暗色，不是漏写）', () => {
    const missing = [...themeLight.keys()].filter(
      (key) => !themeDark.has(key) && !MODE_INVARIANT.test(key),
    )
    expect(missing).toEqual([])
  })

  it('模式不变量不被暗色块覆盖（终端在两种配色下都是同一套）', () => {
    const overridden = [...themeDark.keys()].filter((key) => MODE_INVARIANT.test(key))
    expect(overridden).toEqual([])
  })

  it('uno.config.ts 的 utility 主题色与主色 token 同值（第三处镜像也不能漂）', () => {
    const primaryLight = themeLight.get('--bh-primary')
    const primaryDark = themeDark.get('--bh-primary')
    expect(uno.toLowerCase()).toContain(`default: '${primaryLight}'`)
    expect(uno.toLowerCase()).toContain(`dark: '${primaryDark}'`)
  })
})