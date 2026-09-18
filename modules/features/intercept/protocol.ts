// 主世界拦截协议（Epic1-S1.3）：隔离世界（读 chrome.storage）与主世界（跑拦截）之间的全部契约。
// 关键约束：postMessage 走结构化克隆，**函数过不去**——所以拦截器实现（match/afterResponse）
// 必须编进主世界脚本，隔离侧只广播**纯 JSON 配置**，主世界按配置构建/注销拦截规则。

/** 同步消息类型：隔离侧 → 主世界，携带全部功能配置（重建拦截规则的唯一输入）。 */
export const INTERCEPT_SYNC_MESSAGE = 'bili-helper:intercept-sync'

/** 配置的线协议形状（FeatureConfigMap 的可序列化子集；主世界不 import config 模块）。 */
export interface SerializedFeatureEntry {
  enabled: boolean
  config: Record<string, unknown>
}

export type SerializedFeatureConfigs = Record<string, SerializedFeatureEntry>

export interface InterceptSyncMessage {
  type: typeof INTERCEPT_SYNC_MESSAGE
  payload: SerializedFeatureConfigs
}

export function isInterceptSyncMessage(data: unknown): data is InterceptSyncMessage {
  if (typeof data !== 'object' || data === null) return false
  const message = data as Record<string, unknown>
  if (message.type !== INTERCEPT_SYNC_MESSAGE) return false
  const payload = message.payload
  if (typeof payload !== 'object' || payload === null) return false
  for (const entry of Object.values(payload as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) return false
    const record = entry as Record<string, unknown>
    if (typeof record.enabled !== 'boolean') return false
    if (typeof record.config !== 'object' || record.config === null) return false
  }
  return true
}

/** 隔离侧：广播功能配置（启动时 + 每次配置变化）。同源窗口定向，不做广播风暴。 */
export function pushInterceptConfigs(win: Window, configs: SerializedFeatureConfigs): void {
  win.postMessage({ type: INTERCEPT_SYNC_MESSAGE, payload: configs }, '*')
}

/**
 * 主世界侧：订阅配置广播。不做 source 等值校验（部分实现如 happy-dom 不回填 window、
 * 真实 Chrome 隔离世界与页面共享同一 window）——信任模型靠「唯一类型字符串 + 严格形状校验」：
 * 线协议只有我们自己的两个脚本会发，页面脚本伪造配置的后果也仅限于关闭过滤，不涉及凭据。
 */
export function onInterceptConfigs(
  win: Window,
  listener: (configs: SerializedFeatureConfigs) => void,
): () => void {
  const handler = (event: MessageEvent): void => {
    if (!isInterceptSyncMessage(event.data)) return
    listener(event.data.payload)
  }
  win.addEventListener('message', handler)
  return () => win.removeEventListener('message', handler)
}

// ---------- 拦截器契约（主世界内使用；隔离侧只见类型不见实现） ----------

/** 响应观察事件：请求照常发生，解析出的 JSON 交给回调；响应体不做任何修改。 */
export interface InterceptedEvent {
  url: string
  method: string
  status: number
  responseJson: unknown
}

/** 短路判定事件：真实请求发出前。 */
export interface ShortCircuitEvent {
  url: string
  method: string
  body: unknown
}

/** 短路响应：不发真实网络请求，直接以该 JSON 作为响应。 */
export interface ShortCircuitResponse {
  status?: number
  responseJson: unknown
}

/**
 * 网络拦截器：match 必须是同步纯函数（只看 URL）。
 * priority 升序参与判定；afterResponse 与 shortCircuit 可只实现其一。
 */
export interface NetworkInterceptor {
  id: string
  priority: number
  match(url: string): boolean
  /** observe-only：命中 URL 的响应解析成 JSON 后回调（解析失败静默——JSONP/文本属正常）。 */
  afterResponse?(event: InterceptedEvent): void
  /** 短路：返回非 null 即吞掉真实请求（换一换回放用）。抛错按未命中处理（页面照常请求）。 */
  shortCircuit?(event: ShortCircuitEvent): ShortCircuitResponse | null
}
