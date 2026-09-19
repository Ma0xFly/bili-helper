// @vitest-environment happy-dom
// 布局组测试（Epic3）：分屏迁移/还原与模式互斥、右侧评论搬迁/还原/互斥、极简首页装卸。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SPLIT_BODY_CLASS, createSplitScreenRuntime, inConflictingPlayerMode } from './split-screen'
import { computeCommentHeight, createRightSideCommentRuntime } from './right-comment'
import { MINIMAL_BODY_CLASS, createMinimalHomepageRuntime } from './minimal-homepage'

/** 造一个最小可用的视频页结构（分屏/右侧评论需要的宿主骨架）。 */
function makeVideoPage(): void {
  document.body.innerHTML = `
    <div id="mirror-vdcon" class="video-container-v1">
      <div class="left-container">
        <div id="playerWrap"><div id="bilibili-player"><div class="bpx-player-container"></div></div></div>
      </div>
      <div class="right-container"><div class="right-container-inner">
        <div class="up-panel-container">UP 信息</div>
        <div id="commentapp">评论区</div>
        <div id="danmukuBox">弹幕</div>
        <div class="recommend-list-container">推荐</div>
      </div></div>
    </div>
    <div class="bpx-player-control-bottom-right"><button class="bpx-player-ctrl-pip">pip</button></div>
  `
}

beforeEach(() => {
  document.body.innerHTML = ''
  document.head.querySelectorAll('style').forEach((el) => el.remove())
  document.body.className = ''
})

describe('左右分屏', () => {
  it('冲突模式判定：pip/宽屏/网页全屏/全屏任一即冲突', () => {
    makeVideoPage()
    expect(inConflictingPlayerMode(document)).toBe(false)
    const pip = document.querySelector('.bpx-player-ctrl-pip') as HTMLElement
    pip.classList.add('bpx-state-entered')
    expect(inConflictingPlayerMode(document)).toBe(true)
    pip.classList.remove('bpx-state-entered')
    expect(inConflictingPlayerMode(document)).toBe(false)
    document.querySelector('.bpx-player-container')?.setAttribute('data-screen', 'full')
    expect(inConflictingPlayerMode(document)).toBe(true)
  })

  it('激活：右栏标签壳就位、原生节点迁入对应面板；停止：按原位置还原、页面回原样', () => {
    makeVideoPage()
    const comment = document.getElementById('commentapp') as HTMLElement
    const danmaku = document.getElementById('danmukuBox') as HTMLElement
    const upPanel = document.querySelector('.up-panel-container') as HTMLElement
    const commentParent = comment.parentElement

    const runtime = createSplitScreenRuntime({ doc: document })
    runtime.start()
    expect(document.body.classList.contains(SPLIT_BODY_CLASS)).toBe(false) // 未点按钮不激活

    // 点击注入的按钮激活。
    const button = document.querySelector('.bili-helper-split-button') as HTMLButtonElement
    expect(button).not.toBeNull()
    button.click()
    expect(runtime.isActive()).toBe(true)
    expect(document.body.classList.contains(SPLIT_BODY_CLASS)).toBe(true)
    expect(document.querySelector('.bili-helper-split-shell')).not.toBeNull()
    // 评论/弹幕/推荐已迁入面板（不再是右栏原位置的直接子节点）。
    expect(comment.closest('.bili-helper-split-shell')).not.toBeNull()
    expect(danmaku.closest('.bili-helper-split-shell')).not.toBeNull()
    expect(upPanel.closest('.bili-helper-split-shell')).not.toBeNull()
    // 标签切换：默认第一个有内容的标签，点「弹幕」后弹幕面板可见其余隐藏。
    const tabs = [...document.querySelectorAll('.bili-helper-split-shell-tab')] as HTMLElement[]
    const danmakuTab = tabs.find((tab) => tab.dataset.tab === 'danmaku') as HTMLElement
    danmakuTab.click()
    const panels = [...document.querySelectorAll('.bili-helper-split-shell-panel')] as HTMLElement[]
    expect(panels.find((p) => p.dataset.panel === 'danmaku')?.hidden).toBe(false)
    expect(panels.find((p) => p.dataset.panel === 'comment')?.hidden).toBe(true)

    // 停止：节点回到原父容器原位置，class 与样式全清。
    runtime.stop()
    expect(runtime.isActive()).toBe(false)
    expect(document.querySelector('.bili-helper-split-shell')).toBeNull()
    expect(comment.parentElement).toBe(commentParent)
    expect(document.body.classList.contains(SPLIT_BODY_CLASS)).toBe(false)
    expect(document.getElementById('commentapp')).toBe(comment)
  })

  it('缺失宿主（非视频页骨架）时激活安全失败，不带崩', () => {
    document.body.innerHTML = '<div>什么都没有</div>'
    const runtime = createSplitScreenRuntime({ doc: document })
    runtime.start()
    const button = document.querySelector('.bili-helper-split-button') as HTMLButtonElement | null
    expect(button).toBeNull() // 控制栏都不在 → 按钮重试中，不激活
    expect(runtime.isActive()).toBe(false)
    runtime.stop()
  })
})

describe('右侧评论', () => {
  it('评论区搬到 UP 面板之后，可折叠；停止还原原位', () => {
    makeVideoPage()
    const comment = document.getElementById('commentapp') as HTMLElement
    const originalNext = comment.nextElementSibling

    const runtime = createRightSideCommentRuntime({ doc: document })
    runtime.start()
    const upPanel = document.querySelector('.up-panel-container') as HTMLElement
    expect(comment.previousElementSibling).toBe(upPanel)
    expect(document.body.classList.contains('bili-helper-side-comment-active')).toBe(true)

    // 折叠按钮挂载 + 点击折叠/展开。
    const toggle = document.querySelector('.bili-helper-side-comment-toggle') as HTMLButtonElement
    expect(toggle).not.toBeNull()
    toggle.click()
    expect(comment.getAttribute('data-bili-helper-comments-collapsed')).toBe('true')
    toggle.click()
    expect(comment.hasAttribute('data-bili-helper-comments-collapsed')).toBe(false)

    runtime.stop()
    expect(comment.parentElement?.querySelector(':scope > #commentapp')).toBe(comment)
    expect(comment.nextElementSibling).toBe(originalNext)
    expect(document.body.classList.contains('bili-helper-side-comment-active')).toBe(false)
  })

  it('高度计算：视频区+发送栏+工具栏−40，低于 300 取 600', () => {
    makeVideoPage()
    expect(computeCommentHeight(document)).toBe(600) // 空骨架（rect 全 0）→ 兜底
    // happy-dom 的 getBoundingClientRect 不反映样式：对参与计算的元素打桩。
    // 高度计算首选 .bpx-player-video-area，其次 .video-container-v1（本骨架即 #mirror-vdcon）。
    const videoArea = document.querySelector('#mirror-vdcon') as HTMLElement
    const toolbar = document.createElement('div')
    toolbar.id = 'arc_toolbar_report'
    document.body.append(toolbar)
    vi.spyOn(videoArea, 'getBoundingClientRect').mockReturnValue({ height: 500 } as DOMRect)
    vi.spyOn(toolbar, 'getBoundingClientRect').mockReturnValue({ height: 100 } as DOMRect)
    expect(computeCommentHeight(document)).toBe(560)
  })

  it('与分屏互斥：分屏 body class 存在时不挂载', () => {
    makeVideoPage()
    document.body.classList.add(SPLIT_BODY_CLASS)
    const runtime = createRightSideCommentRuntime({ doc: document })
    runtime.start()
    expect(document.querySelector('.bili-helper-side-comment-toggle')).toBeNull()
    expect(document.getElementById('commentapp')?.classList.contains('bili-helper-side-comment')).toBe(false)
    runtime.stop()
  })
})

describe('极简首页', () => {
  it('装卸：样式与 body class、placeholder 还原、切换按钮仅 URL 来源', async () => {
    document.body.innerHTML = '<input class="nav-search-input" placeholder="搜索" title="搜索">'
    const runtime = createMinimalHomepageRuntime({
      doc: document,
      config: { backgroundSource: 'url', backgroundUrl: 'https://example.test/bg', backgroundVersion: 0 },
    })
    runtime.start()
    expect(document.body.classList.contains(MINIMAL_BODY_CLASS)).toBe(true)
    expect(document.getElementById('bili-helper-minimal-homepage-style')).not.toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 0)) // 背景读取后才挂切换按钮
    expect(document.getElementById('bili-helper-minimal-homepage-refresh-background')).not.toBeNull()
    expect((document.querySelector('.nav-search-input') as HTMLInputElement).placeholder).toContain('搜索你感兴趣')

    runtime.stop()
    expect(document.body.classList.contains(MINIMAL_BODY_CLASS)).toBe(false)
    expect(document.getElementById('bili-helper-minimal-homepage-style')).toBeNull()
    expect((document.querySelector('.nav-search-input') as HTMLInputElement).placeholder).toBe('搜索')
  })

  it('本地背景来源：不显示切换按钮', () => {
    document.body.innerHTML = ''
    const runtime = createMinimalHomepageRuntime({
      doc: document,
      config: { backgroundSource: 'local', backgroundUrl: '', backgroundVersion: 0 },
    })
    runtime.start()
    expect(document.getElementById('bili-helper-minimal-homepage-refresh-background')).toBeNull()
    runtime.stop()
  })
})
