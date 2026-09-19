// @vitest-environment happy-dom
// 标签视频隐藏测试（Epic2-S2.3）：样式与 body class 两件套的装卸语义、重入安全。
// （:has() 的实际隐藏效果在真机 E2E 验证——happy-dom 不做选择器求值。）
import { beforeEach, describe, expect, it } from 'vitest'
import { createLabelVideoBlocker } from './label-video'

const STYLE_ID = 'bili-helper-label-video-blocker-style'
const BODY_CLASS = 'bili-helper-label-video-blocker'

beforeEach(() => {
  document.body.innerHTML = ''
  document.head.querySelectorAll(`#${STYLE_ID}`).forEach((el) => el.remove())
  document.body.classList.remove(BODY_CLASS)
})

describe('createLabelVideoBlocker（纯 CSS 隐藏）', () => {
  it('start：样式进 head（含 PGC 楼层卡与内嵌直播卡两条规则）+ body class', () => {
    const blocker = createLabelVideoBlocker()
    blocker.start()
    const style = document.head.querySelector(`#${STYLE_ID}`) as HTMLStyleElement | null
    expect(style).not.toBeNull()
    expect(style?.textContent).toContain('.floor-single-card')
    expect(style?.textContent).toContain('.bili-feed-card:has(.bili-live-card)')
    expect(document.body.classList.contains(BODY_CLASS)).toBe(true)
    blocker.stop()
  })

  it('stop：样式与 class 全移除，页面即回原样', () => {
    const blocker = createLabelVideoBlocker()
    blocker.start()
    blocker.stop()
    expect(document.head.querySelector(`#${STYLE_ID}`)).toBeNull()
    expect(document.body.classList.contains(BODY_CLASS)).toBe(false)
  })

  it('重复 start 不重复注入；stop 后可再 start（开关来回切）', () => {
    const blocker = createLabelVideoBlocker()
    blocker.start()
    blocker.start()
    expect(document.head.querySelectorAll(`#${STYLE_ID}`)).toHaveLength(1)
    blocker.stop()
    blocker.start()
    expect(document.head.querySelectorAll(`#${STYLE_ID}`)).toHaveLength(1)
    expect(document.body.classList.contains(BODY_CLASS)).toBe(true)
    blocker.stop()
  })
})
