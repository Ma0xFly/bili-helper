// 主世界拦截运行时（Epic1-S1.3）：拦截器的注册表与判定核心，纯逻辑、可单测。
// 三条铁律：
//   ① 未命中零开销——URL 没被任何拦截器 match 时，既不解析响应也不进回调；
//   ② 回调抛错绝不影响页面——观察回调逐个 try/catch（记录 id+URL），短路回调抛错按未命中
//     处理（页面照常发真实请求）；
//   ③ 构建失败即全注销——setInterceptors 校验不通过（重复 id/缺 match）时清空全部并抛可读错误，
//     不留半启用状态。

import type {
  InterceptedEvent,
  NetworkInterceptor,
  SerializedFeatureConfigs,
  ShortCircuitEvent,
  ShortCircuitResponse,
} from './protocol'

export class InterceptRuntime {
  private interceptors: NetworkInterceptor[] = []

  /** 全量替换（配置变化的重建语义）。构建失败：清空并上抛，调用方负责记日志。
   * 被替换掉的拦截器先 dispose——有状态拦截器（筛选的样式/节点）不留半启用状态。 */
  setInterceptors(list: NetworkInterceptor[]): void {
    const seen = new Set<string>()
    for (const interceptor of list) {
      if (typeof interceptor?.id !== 'string' || interceptor.id === '') {
        this.disposeAll(list)
        this.interceptors = []
        throw new Error('拦截器缺少 id')
      }
      if (seen.has(interceptor.id)) {
        this.disposeAll(list)
        this.interceptors = []
        throw new Error(`拦截器 id 重复：${interceptor.id}`)
      }
      if (typeof interceptor.match !== 'function') {
        this.disposeAll(list)
        this.interceptors = []
        throw new Error(`拦截器 ${interceptor.id} 缺少 match(url)`)
      }
      seen.add(interceptor.id)
    }
    // 旧列表里不在新列表中的逐个 dispose（同 id 视为替换，也先 dispose 旧实例）。
    for (const old of this.interceptors) {
      if (!list.some((item) => item.id === old.id)) old.dispose?.()
    }
    this.interceptors = [...list].sort(
      (a, b) => a.priority - b.priority || a.id.localeCompare(b.id),
    )
  }

  private disposeAll(list: NetworkInterceptor[]): void {
    for (const interceptor of list) {
      try {
        interceptor?.dispose?.()
      } catch (error) {
        console.error(`[bili-helper:intercept] dispose 抛错 ${interceptor?.id}:`, String(error))
      }
    }
    for (const old of this.interceptors) {
      try {
        old.dispose?.()
      } catch (error) {
        console.error(`[bili-helper:intercept] dispose 抛错 ${old.id}:`, String(error))
      }
    }
  }

  get size(): number {
    return this.interceptors.length
  }

  /** 该 URL 是否有观察者（补丁层据此决定要不要 clone/解析响应——未命中零开销的闸门）。 */
  observesUrl(url: string): boolean {
    return this.interceptors.some(
      (interceptor) => interceptor.afterResponse !== undefined && this.safeMatch(interceptor, url),
    )
  }

  /**
   * 短路判定：按优先级找第一个返回非 null 的短路器。
   * 任一短路器抛错：记录并按未命中继续（页面照常请求——回放失败不能变成页面失败）。
   */
  findShortCircuit(url: string, method: string, body: unknown): ShortCircuitResponse | null {
    const event: ShortCircuitEvent = { url, method, body }
    for (const interceptor of this.interceptors) {
      if (interceptor.shortCircuit === undefined) continue
      if (!this.safeMatch(interceptor, url)) continue
      try {
        const response = interceptor.shortCircuit(event)
        if (response !== null && response !== undefined) return response
      } catch (error) {
        console.error(
          `[bili-helper:intercept] 短路拦截器 ${interceptor.id} 抛错（按未命中处理） ${url}:`,
          String(error),
        )
      }
    }
    return null
  }

  /** 响应分发：逐个 try/catch，单个回调挂了其余照常、页面不受影响。 */
  dispatchAfterResponse(url: string, method: string, status: number, responseJson: unknown): void {
    const event: InterceptedEvent = { url, method, status, responseJson }
    for (const interceptor of this.interceptors) {
      if (interceptor.afterResponse === undefined) continue
      if (!this.safeMatch(interceptor, url)) continue
      try {
        interceptor.afterResponse(event)
      } catch (error) {
        console.error(
          `[bili-helper:intercept] 响应回调 ${interceptor.id} 抛错 ${url}:`,
          String(error),
        )
      }
    }
  }

  private safeMatch(interceptor: NetworkInterceptor, url: string): boolean {
    try {
      return interceptor.match(url)
    } catch (error) {
      console.error(`[bili-helper:intercept] match 抛错 ${interceptor.id} ${url}:`, String(error))
      return false
    }
  }
}

/**
 * 拦截器工厂注册：功能（Epic 2/4）在主世界侧登记「featureId → 拦截器构造」；
 * build 返回 null 表示该配置下不需要拦截器（功能默认关 → 全部 null → 零拦截零开销）。
 */
export interface InterceptorFactoryRegistration {
  featureId: string
  build: (entry: {
    enabled: boolean
    config: Record<string, unknown>
  }) => NetworkInterceptor | null
}

/** 按配置构建全部拦截器：任何一个工厂抛错都视为整次构建失败（由调用方决定全注销）。 */
export function buildInterceptors(
  registrations: InterceptorFactoryRegistration[],
  configs: SerializedFeatureConfigs,
): NetworkInterceptor[] {
  const out: NetworkInterceptor[] = []
  for (const [id, entry] of Object.entries(configs)) {
    const registration = registrations.find((candidate) => candidate.featureId === id)
    if (!registration || !entry.enabled) continue
    const interceptor = registration.build(entry)
    if (interceptor !== null) out.push(interceptor)
  }
  return out
}
