// 网络补丁安装层（Epic1-S1.3，主世界）：patch fetch 与 XMLHttpRequest 两个入口
// （旧产物只 patch 了 XHR——B 站部分请求走 fetch，必须双打）。
// 语义：
//   observe-only —— 命中 URL 才 clone/解析响应；原响应对象原样交给页面，字节与状态码不变；
//   短路 —— 真实请求发出前命中即吞掉，不发网络，直接以缓存 JSON 交付（换一换回放）。
// 全部实现可注入（win/fetchImpl/xhrClass），单测不需要真网络。

import type { ShortCircuitResponse } from './protocol'
import type { InterceptRuntime } from './runtime'

export function resolveRequestUrl(input: RequestInfo | URL, win?: Window): string {
  try {
    if (typeof input === 'string') {
      return new URL(input, win?.location?.href).href
    }
    if (input instanceof URL) return input.href
    return input.url
  } catch {
    return String(input)
  }
}

function resolveMethod(input: RequestInfo | URL, init?: RequestInit): string {
  const fromInit = init?.method
  if (typeof fromInit === 'string' && fromInit !== '') return fromInit
  if (typeof Request !== 'undefined' && input instanceof Request) return input.method
  return 'GET'
}

function syntheticResponse(response: ShortCircuitResponse): Response {
  return new Response(JSON.stringify(response.responseJson ?? null), {
    status: response.status ?? 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** patch win.fetch；返回还原函数（恢复原引用，便于反复装卸）。fetchImpl 缺省用当前 win.fetch。 */
export function installFetchPatch(
  runtime: InterceptRuntime,
  win: Window,
  fetchImpl: typeof fetch = win.fetch.bind(win),
): () => void {
  const previousFetch = win.fetch
  const patched = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = resolveRequestUrl(input, win)
    const method = resolveMethod(input, init)
    const shorted = runtime.findShortCircuit(url, method, init?.body ?? null)
    if (shorted) return Promise.resolve(syntheticResponse(shorted))
    const request = fetchImpl(input as RequestInfo, init)
    if (!runtime.observesUrl(url)) return request
    // observe-only：克隆一份自己读，原响应对象原样交给页面；解析异步进行，不拖慢页面。
    return request.then((response) => {
      try {
        const clone = response.clone()
        void clone
          .json()
          .then((json) => runtime.dispatchAfterResponse(url, method, response.status, json))
          .catch(() => {
            // 非 JSON 响应体（JSONP/文本）：解析失败是正常场景，静默。
          })
      } catch {
        // clone 失败（罕见）：放弃本次观察，不影响页面。
      }
      return response
    })
  }
  win.fetch = patched as typeof fetch
  return () => {
    win.fetch = previousFetch
  }
}

// ---------- XHR ----------

interface XhrMeta {
  method: string
  url: string
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function dispatchXhrObservation(
  runtime: InterceptRuntime,
  xhr: XMLHttpRequest,
  meta: XhrMeta,
): void {
  try {
    const json = xhr.responseType === 'json' ? xhr.response : safeJsonParse(xhr.responseText)
    if (json === undefined) return
    runtime.dispatchAfterResponse(meta.url, meta.method, xhr.status, json)
  } catch {
    // 读失败（跨源限制等）：放弃本次观察，不影响页面。
  }
}

/**
 * XHR 短路交付：readonly 属性（readyState/status/responseText/response）用实例级
 * defineProperty 覆盖（遮住原型 getter），再按 XHR 事件序派发 readystatechange → load → loadend。
 */
export function deliverShortCircuitXhr(
  xhr: XMLHttpRequest,
  response: ShortCircuitResponse,
): void {
  const text = JSON.stringify(response.responseJson ?? null)
  const define = (prop: string, value: unknown): void => {
    Object.defineProperty(xhr, prop, {
      value,
      configurable: true,
      writable: false,
      enumerable: false,
    })
  }
  define('readyState', 4)
  define('status', response.status ?? 200)
  define('statusText', '')
  define('responseText', text)
  define('response', xhr.responseType === 'json' ? (response.responseJson ?? null) : text)
  xhr.dispatchEvent(new Event('readystatechange'))
  xhr.dispatchEvent(new ProgressEvent('load'))
  xhr.dispatchEvent(new ProgressEvent('loadend'))
}

/** patch XMLHttpRequest.prototype 的 open/send；返回还原函数。 */
export function installXhrPatch(
  runtime: InterceptRuntime,
  xhrClass: typeof XMLHttpRequest,
  win?: Window,
): () => void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = xhrClass.prototype as any
  const originalOpen = proto.open
  const originalSend = proto.send
  const metas = new WeakMap<object, XhrMeta>()

  proto.open = function (this: XMLHttpRequest, method: unknown, url: unknown, ...rest: unknown[]) {
    metas.set(this, {
      method: String(method ?? 'GET'),
      url: resolveRequestUrl(String(url ?? ''), win ?? (globalThis as unknown as Window)),
    })
    return originalOpen.apply(this, [method, url, ...rest])
  }

  proto.send = function (this: XMLHttpRequest, body?: unknown) {
    const meta = metas.get(this)
    if (meta) {
      const shorted = runtime.findShortCircuit(meta.url, meta.method, body ?? null)
      if (shorted) {
        deliverShortCircuitXhr(this, shorted)
        return
      }
      if (runtime.observesUrl(meta.url)) {
        this.addEventListener('load', () => dispatchXhrObservation(runtime, this, meta))
      }
    }
    return originalSend.call(this, body)
  }

  return () => {
    proto.open = originalOpen
    proto.send = originalSend
  }
}
