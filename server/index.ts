// 服务端入口：装 storage shim → 读环境变量 → 起 http 服务。
// 启动即体检：缺 AI_API_URL / AI_MODEL 直接拒绝启动并说清变量名，不留到第一个请求才报。

import { createServer } from 'node:http'
import { missingConfigReasons, readServerConfig } from './config'
import { createRequestHandler } from './handler'
import { installStorageShim } from './storage'

// 构建期由 vite define 注入 package.json 的 version；直接跑源码时为 dev。
declare const __SERVER_VERSION__: string | undefined

const version = typeof __SERVER_VERSION__ === 'string' ? __SERVER_VERSION__ : 'dev'

function log(line: string): void {
  // 只记状态与原因：Key、Token、请求体（含字幕）一律不进日志。
  process.stdout.write(`[bili-helper-ai] ${line}\n`)
}

const config = readServerConfig()

installStorageShim({
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
  process.stderr.write(`[bili-helper-ai] 缺少必要配置：${missing.join('、')}\n`)
  process.exit(1)
}

const server = createServer(
  createRequestHandler({
    settings: config.settings,
    token: config.token,
    allowOrigin: config.allowOrigin,
    maxBodyBytes: config.maxBodyBytes,
    onWarn: log,
    version,
  }),
)

// 长 LLM 调用（尤其 SSE 流式）不能被 Node 默认的请求/头超时掐断。
server.requestTimeout = 0
server.headersTimeout = 0

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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log(`收到 ${signal}，关闭中`)
    server.close(() => process.exit(0))
    // 连接迟迟不放（长流）也要能退出去，别让进程挂着。
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
