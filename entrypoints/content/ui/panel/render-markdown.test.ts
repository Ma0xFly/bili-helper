// @vitest-environment jsdom
// Markdown 渲染管线安全回归：marked 渲染 → dompurify 白名单清洗。
// jsdom 的 HTML 解析与真实浏览器一致，能如实验证危险标签/属性被剔除（happy-dom 的
// 解析器会让 script/onerror 穿透清洗，不可作为安全断言环境）。
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './render-markdown'

describe('renderMarkdown（marked + dompurify）', () => {
  it('危险元素整体剔除：img/script/iframe/style', () => {
    const html = renderMarkdown(
      '<img src=x onerror="alert(1)">正文<script>alert(2)</script><iframe src="https://x"></iframe><style>*{}</style>尾部',
    )
    expect(html).toContain('正文')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('<style')
  })

  it('事件属性与危险协议剔除', () => {
    const html = renderMarkdown(
      '<a href="javascript:alert(1)" onclick="steal()">点我</a> 与 <span onmouseover="x()">词</span>',
    )
    expect(html).toContain('点我')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('onmouseover')
    expect(html).not.toContain('javascript:')
  })

  it('白名单基础排版保留：标题/加粗/列表/行内代码', () => {
    const html = renderMarkdown('## 小标题\n\n- 要点 **加粗** 与 `term`')
    expect(html).toContain('<h2>')
    expect(html).toContain('<strong>加粗</strong>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<code>term</code>')
  })

  it('链接统一外开：href 保留、target=_blank + rel=noopener noreferrer 补齐', () => {
    const html = renderMarkdown('[官网](https://example.com) 与 [官方](https://www.bilibili.com)')
    const anchors = html.match(/<a[^>]*>/g) ?? []
    expect(anchors).toHaveLength(2)
    for (const anchor of anchors) {
      expect(anchor).toContain('target="_blank"')
      expect(anchor).toContain('rel="noopener noreferrer"')
    }
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('href="https://www.bilibili.com"')
  })

  it('普通文本不受影响（不误伤）', () => {
    const html = renderMarkdown('一段话说 「onclick=」 关键字也没问题')
    expect(html).toContain('onclick=')
    expect(html).toContain('一段话说')
  })
})