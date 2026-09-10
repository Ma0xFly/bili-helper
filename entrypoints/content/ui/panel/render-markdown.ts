// 面板内 Markdown 渲染统一出口：marked 渲染 → dompurify 清洗（AI 输出不可信），
// 清洗不掉的危险内容随 sanitize 剔除。两个 tab 共用，禁止绕过直接 innerHTML 直插。

import { marked } from 'marked'
import DOMPurify from 'dompurify'

// 链接一律外开：AI 回答里的外链点击不得把 bilibili 整页导航走。
const LINK_PATTERN_HOOK = 'afterSanitizeAttributes'
DOMPurify.addHook(LINK_PATTERN_HOOK, (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

/** marked 渲染后经 dompurify 清洗的安全 HTML 字符串（供 v-html 使用）。 */
export function renderMarkdown(markdown: string): string {
  const raw = marked.parse(markdown, { async: false, gfm: true, breaks: false }) as string
  return DOMPurify.sanitize(raw, {
    // 面板内只需基础排版标签；样式/事件/脚本一律剥离。
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'b', 'i', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4',
      'blockquote', 'code', 'pre', 'hr', 'a', 'span', 'del', 'table', 'thead', 'tbody',
      'tr', 'th', 'td',
    ],
    // target/rel 由 afterSanitizeAttributes 钩子统一补齐；alt 备图片无障碍（当前不放开 img）。
    ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'alt'],
  })
}