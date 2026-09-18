// 卡片拦截器底座（Epic2-S2.1/S2.2 共用）：深度扫描（穿透 shadowRoot）+ MutationObserver
// 增量捕获 + 批量移除与计数。语义沿旧产物验证过的行为：
//   - 初始扫描先做（含拦截条数日志），再挂观察器；
//   - 滚动/懒加载新增的节点进 microtask 批处理，一批只上报一次计数；
//   - Shadow DOM 内的卡片同样命中（B 站评论等组件是 Web Component，首页卡片部分场景也在影子树里）；
//   - 移除是不可逆的：stop 只停观察器，已删卡片不回溯恢复（重进页面即原样）。

export interface CardBlockerOptions {
  /** 观察根（默认 document.body；测试注入容器）。 */
  root?: ParentNode
  /** 日志名（如 'ad-video-blocker'），用于 [bili-helper:*] 前缀。 */
  logName: string
  /** 命中判定：true 表示该元素是「标记了一张要移除卡片」的元素。 */
  match: (element: Element) => boolean
  /** 一批移除 count>0 后回调（统计上报用）。 */
  onBlocked?: (count: number, phase: 'initial' | 'mutation') => void
}

export interface CardBlocker {
  start(): void
  stop(): void
}

/** 卡片移除目标：标记 → 最近的 .bili-feed-card（视觉卡）→ 它外层的 .feed-card（槽位）。
 * 旧版同序：优先整张槽位一起删，避免留下空槽造成布局空洞。 */
const removeTargetOf = (marker: Element): Element => {
  const inner = marker.closest('.bili-feed-card')
  return inner?.closest('.feed-card') ?? inner ?? marker.closest('.feed-card') ?? marker
}

export function createCardBlocker(options: CardBlockerOptions): CardBlocker {
  const root = options.root ?? (typeof document !== 'undefined' ? document.body : null)
  if (root === null) {
    return {
      start(): void {},
      stop(): void {},
    }
  }
  const removed = new WeakSet<Element>()
  const observers: MutationObserver[] = []
  const pending: Element[] = []
  let scheduled = false
  let running = false

  const removeCardOf = (marker: Element): boolean => {
    const card = removeTargetOf(marker)
    if (removed.has(card)) return false
    removed.add(card)
    card.remove()
    return true
  }

  /** 扫描一棵子树（含其下所有 shadowRoot）：返回移除的卡片数，并把遇到的 shadowRoot 挂上观察器。 */
  const scanTree = (parent: ParentNode): number => {
    let count = 0
    for (const element of parent.querySelectorAll('*')) {
      if (options.match(element)) {
        if (removeCardOf(element)) count += 1
        continue // 卡片已随标记移除，其后代不必再看
      }
      if (element.shadowRoot !== null) {
        attachObserver(element.shadowRoot)
        count += scanTree(element.shadowRoot)
      }
    }
    return count
  }

  const report = (count: number, phase: 'initial' | 'mutation'): void => {
    if (count <= 0) return
    console.info(`[bili-helper:${options.logName}] ${phase === 'initial' ? 'initial scan complete' : 'mutation blocked'}`, { blocked: count })
    options.onBlocked?.(count, phase)
  }

  const flush = (): void => {
    scheduled = false
    const nodes = pending.splice(0)
    let count = 0
    for (const element of nodes) {
      if (!element.isConnected) continue // 批处理前已被移走（可能就是我们删的卡片）
      if (options.match(element)) {
        if (removeCardOf(element)) count += 1
        continue
      }
      if (element.shadowRoot !== null) {
        attachObserver(element.shadowRoot)
        count += scanTree(element.shadowRoot)
      }
      for (const desc of element.querySelectorAll('*')) {
        if (options.match(desc)) {
          if (removeCardOf(desc)) count += 1
          continue
        }
        if (desc.shadowRoot !== null) {
          attachObserver(desc.shadowRoot)
          count += scanTree(desc.shadowRoot)
        }
      }
    }
    report(count, 'mutation')
  }

  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(flush)
  }

  const attachObserver = (observeRoot: ParentNode): void => {
    const observer = new MutationObserver((records) => {
      if (!running) return
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1) pending.push(node as Element)
        }
      }
      if (pending.length > 0) schedule()
    })
    observer.observe(observeRoot, { childList: true, subtree: true })
    observers.push(observer)
  }

  return {
    start(): void {
      if (running) return
      running = true
      const blocked = scanTree(root)
      console.info(`[bili-helper:${options.logName}] started`, { rootBlocked: blocked })
      report(blocked, 'initial')
      attachObserver(root)
    },
    stop(): void {
      running = false
      for (const observer of observers) observer.disconnect()
      observers.length = 0
      pending.length = 0
      console.info(`[bili-helper:${options.logName}] stopped`)
    },
  }
}
