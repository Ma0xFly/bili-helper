# 转发服务端（参考实现）

让扩展设置页里的「我有自己的服务器」真正可用的服务端。**它跑的是与浏览器端完全相同的那套识别逻辑**——`modules/ai` 里的混合检索 RAG、提示词、LLM 客户端被直接复用，不是另写一份，所以两种模式的识别结果口径一致。

## 为什么要用它

| | 浏览器直连（默认） | 走服务器 |
| --- | --- | --- |
| CORS | 模型端点必须放行 `bilibili.com`，否则请求发不出去 | 无此限制，服务端直连任意端点 |
| API Key | 存在浏览器 `chrome.storage.sync`，只发给你填的地址 | 只存在服务端环境变量里，浏览器完全看不到 |
| 向量缓存 | 每个浏览器各存一份，换机器重算 | 服务端集中一份，所有客户端共享 |
| 词库 | 内置 md + 用户补录两层 | 内置 md（用户补录不同步，见下） |

## 快速开始

```bash
# 1. 构建（产物是单文件、零运行时依赖）
pnpm server:build            # → server/dist/server.mjs

# 2. 配置并启动
export AI_API_URL="https://your-endpoint/v1"
export AI_MODEL="gpt-4o-mini"
export AI_API_KEY="sk-…"
export AI_SERVER_TOKEN="随便一串足够长的随机字符"
node server/dist/server.mjs
# [bili-helper-ai] 已启动 http://127.0.0.1:8787 · 路径 /ai/{ad-detection,summary,chat,health}

# 3. 验证
curl -s http://127.0.0.1:8787/ai/health
# {"ok":true,"service":"bili-helper-ai","version":"0.0.0","configured":true}
```

然后在扩展设置页打开「我有自己的服务器」，填 `http://127.0.0.1:8787` 与同一个 token，点「一键体检」应当报绿灯。

> 缺 `AI_API_URL` / `AI_MODEL` 时进程直接拒绝启动并点名缺哪个变量，不会等第一个请求进来才报「还没配置端点」。`AI_API_KEY` 可以为空（本地 Ollama 这类无鉴权端点）。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `AI_API_URL` | ✅ | — | 对话端点 Base URL（OpenAI 兼容） |
| `AI_MODEL` | ✅ | — | 对话模型名 |
| `AI_API_KEY` | | 空 | 对话端点 Key |
| `AI_EMBED_BASE_URL` | | 继承对话端点 | 向量端点（想拆分时才填，例如对话走一家、embedding 走另一家） |
| `AI_EMBED_MODEL` | | 继承对话模型 | 嵌入模型名 |
| `AI_EMBED_API_KEY` | | 继承对话 Key | 向量端点 Key |
| `AI_SERVER_TOKEN` | | 空 | 扩展端要填同一个值；**为空等于不鉴权**，只建议本机/内网 |
| `AI_SERVER_HOST` | | `127.0.0.1` | 容器/远程部署改 `0.0.0.0` |
| `PORT` | | `8787` | 监听端口 |
| `AI_SERVER_ORIGIN` | | `*` | CORS 放行来源，收紧就填 `https://www.bilibili.com` |
| `AI_SERVER_MAX_BODY_BYTES` | | 25165824 (24MB) | 请求体上限（超长视频的字幕+弹幕全量上传） |
| `AI_SERVER_STORAGE_FILE` | | 空=内存 | 向量缓存落盘路径，如 `/var/lib/bili-helper/rag-cache.json`；不填则每次重启重算向量 |

## 契约

三条业务路径都是 `POST`，请求体是扩展端采集好的原始 context，响应与浏览器端同形：

| 路径 | 请求体 | 响应 |
| --- | --- | --- |
| `/ai/ad-detection` | `{video, subtitles, danmaku, comments, strategy}` | `{ads:[{start,end,product_name,ad_content,confidence}], source:"rag"\|"llm"\|"none"}` |
| `/ai/summary` | `{video, subtitles, danmaku, comments}` | `{summary, segments:[{start,end,label}]}` |
| `/ai/chat` | `{messages:[{role,content}], context:{video,…}}` | SSE：`data: {"type":"start"}` → `{"type":"message","chunk":"…"}`* → `{"type":"end"}`（失败时 `end.error` 带 `{kind,message,status?}`），最后 `data: [DONE]` |
| `/ai/health` | `GET`，不鉴权 | `{ok, service, version, configured}` |

鉴权：`Authorization: Bearer ⟨AI_SERVER_TOKEN⟩`。错误一律 `{error:{kind,message,status?}}`，状态码按失败性质映射：`400` 请求体不合法、`401` token 不对、`404/405` 路径或方法不对、`413` 请求体超限、`500` 服务端自己没配好、`502` 上游模型端点鉴权/HTTP 失败、`504` 上游连不上或超时。

时间单位一律是**秒**（number）。

## 部署注意

- **反向代理要关缓冲**：响应头已带 `X-Accel-Buffering: no`，nginx 侧仍建议显式 `proxy_buffering off;`，否则 SSE 会被攒到结束才下发，流式效果全失。同时把 `proxy_read_timeout` 调大（长视频总结可能几十秒）。
- **公网暴露必须设 token**：不设 token 等于把你的模型额度开放给任何人。建议再叠一层 TLS 与 IP 白名单。
- **缓存落盘**：设 `AI_SERVER_STORAGE_FILE` 后，语料向量与每个视频的字幕窗口向量都会跨重启复用；缓存键含「嵌入模型 + 端点 + 语料内容哈希」，改词库或换模型会自动失效重算，不需要手动清。
- **多个服务进程不要共用同一个 `AI_SERVER_STORAGE_FILE`**：落盘是「整份快照」写入，两个进程各持一份内存态，互相整份覆盖——谁后写谁说了算，不报错、不合并，表现为缓存时灵时不灵。要么每进程一份文件，要么只跑一个进程（systemd 等守护工具记得配去重）。
- **多人共用一个服务端时的缓存行为**（诚实说明当前限制）：字幕窗口向量的清理策略沿用浏览器端假设——「同一时间只在看一个视频」，每次识别会清掉*其他* `bvid:cid` 的窗口缓存，且清理范围不按端点/模型分组。因此多用户并发时，窗口缓存基本不会跨视频复用（识别结果不受影响，只是每个视频重新嵌入一次字幕），而且缓存文件越大、每次落盘的整份写入越重。**语料向量缓存是真正共享的那一份收益**（所有用户共用，按 `model:baseUrl` 前缀分组清理）。单人自用或小规模部署无感；要做多租户，建议每个用户一份 `AI_SERVER_STORAGE_FILE`，或后续把窗口缓存改成按端点分组 + LRU 上限。
- **词库**：服务端用的是仓库里 `modules/ai/rag/corpus/*.md` 那一份（构建期内联进产物）。扩展端用户补录的词条**不会**同步到服务器——设置页在该模式下会如实提示，用户需要「导出入库 patch」，把导出的 md 追加进对应 `corpus/*.md` 再重新构建部署即可。
- **日志**：只输出状态与原因，Key、token、请求体（含字幕内容）一律不进日志。

## 开发与测试

```bash
pnpm test server/            # 54 条：路由/鉴权/CORS/错误映射/断连中止 + 与扩展端适配器的契约互通
pnpm typecheck
```

`server/handler.test.ts` 里有一组**契约互通测试**：用扩展端真实的 `createServerBackend` 打这个服务，逐条验证 detectAds / summarize / chat(SSE) 的请求与响应能被双方正确解析——服务端序列化器和客户端解析器对不上时这里会先红。
