// 服务端入口：装 storage shim → 读环境变量 → 起 http 服务。
// 启动即体检：缺 AI_API_URL / AI_MODEL 直接拒绝启动并说清变量名，不留到第一个请求才报。

import { createServer } from 'node:http'
import { missingConfigReasons, readServerConfig } from './config'
import type { ServerConfig } from './config'
import { createRequestHandler } from './handler'
import { installStorageShim } from './storage'

// 构建期由 vite define 注入 package.json 的 version；直接跑源码时为 dev。
declare const __SERVER_VERSION__: string | undefined

const version = typeof __SERVER_VERSION__ === 'string' ? __SERVER_VERSION__ : 'dev'

function log(line: string): void {
  // 只记状态与原因：Key、Token、请求体（含字幕）一律不进日志。
  process.stdout.write(`[bili-helper-ai] ${line}\n`)
}

function exitWithError(message: string): never {
  process.stderr.write(`[bili-helper-ai] ${message}\n`)
  process.exit(1)
}

let config: ServerConfig
try {
  config = readServerConfig()
} catch (error) {
  // 目前只有 PORT 校验会走这里；变量名与原因已在 message 里。
  exitWithError(`配置无效：${error instanceof Error ? error.message : String(error)}`)
}

const storage = installStorageShim({
  file: config.storageFile,
  onError: (phase, error) => {
    log(
      `向量缓存${phase === 'read' ? '读取' : '写入'}失败（下次访问重算，不影响服务）：${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  },
})

const missing = missingConfigReasons(config)
if (missing.length > 0) {
  exitWithError(`缺少必要配置：${missing.join('、')}`)
}

const handler = createRequestHandler({
  settings: config.settings,
  token: config.token,
  allowOrigin: config.allowOrigin,
  maxBodyBytes: config.maxBodyBytes,
  onWarn: log,
  version,
})

const server = createServer(handler)

// 收请求阶段的超时保持 Node 默认（requestTimeout 300s / headersTimeout 60s）。
// 不要为了「长 LLM 调用」把它们关掉：这两个超时只管收完请求，与响应时长无关，SSE 长流不受影响；
// 关掉等于给 slow-loris 开门——半截 body 或半截 headers 挂着不收尾，连接永不释放，fd 耗尽即拒服。
// 响应侧的时长由上游模型端点自己的死线（modules/ai/llm/client 的 REQUEST_TIMEOUT_MS）管。

server.listen(config.port, config.host, () => {
  log(
    `已启动 http://${config.host}:${config.port} · 路径 /ai/{ad-detection,summary,chat,health} · 缓存${
      config.storageFile === '' ? '在内存（重启后重算）' : `落盘 ${config.storageFile}`
    }`,
  )
  if (config.token === '') {
    log('注意：未设置 AI_SERVER_TOKEN，任何能访问该端口的人都能调用，仅建议本机或内网使用')
  }
})

// 端口被占/地址不可绑这类启动失败：说出原因再退出，别让进程带着 unhandled 'error' 静默崩掉。
server.on('error', (error) => {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'EADDRINUSE') {
    exitWithError(`端口 ${config.port} 已被占用（换个 PORT，或停掉占用它的进程）`)
    return
  }
  exitWithError(`服务启动失败：${error.message}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log(`收到 ${signal}，关闭中`)
    // 契约「end 必然收尾」不因进程退出破例：先给进行中的 SSE 流补终止事件，
    // 再停收新连接、放掉空闲 keep-alive 连接；去抖中的缓存落盘冲出去再退。
    const closed = handler.shutdownStreams('服务正在关闭')
    if (closed > 0) log(`已向 ${closed} 条进行中的流补发收尾事件`)
    server.close(() => {
      void storage.flush().finally(() => process.exit(0))
    })
    server.closeIdleConnections?.()
    // 连接迟迟不放（对端挂起的长流）也要能退出去，别让进程挂着。
    setTimeout(() => process.exit(0), 3000).unref()
  })
}

// 兜底：漏网的异步错误记一条状态，不让进程静默死掉（只记 message，不记栈与请求内容）。
process.on('unhandledRejection', (reason) => {
  log(`未处理的 Promise 拒绝：${reason instanceof Error ? reason.message : String(reason)}`)
})
process.on('uncaughtException', (error) => {
  log(`未捕获异常，进程退出：${error.message}`)
  process.exit(1)
})
