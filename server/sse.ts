// SSE 事件序列化：与扩展端 relayChatStream 的解析规则严格对应——
// 行首 `data:`、`[DONE]` 等价 end、start 事件客户端会跳过（它自己补发），
// 所以这里发不发 start 都安全，发出来是为了让 curl/第三方消费者看到完整三段。

import type { AiChatEvent } from '../modules/ai/port'

export function sseEvent(event: AiChatEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

export function sseDone(): string {
  return 'data: [DONE]\n\n'
}

export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  // 不硬编码 Connection：客户端发 Connection: close 时必须照办（RFC 7230），
  // 写死 keep-alive 会让对方收完 [DONE] 后一直挂着等关连接。交给 Node 自行协商。
  // 反向代理（nginx 等）默认会缓冲响应，流式会被攒到结束才下发，必须显式关掉。
  'X-Accel-Buffering': 'no',
}
