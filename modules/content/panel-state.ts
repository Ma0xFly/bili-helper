// AI 面板（总结/提问）的共享响应式状态与动作注入点：接线层（entrypoints/content/index.ts）
// drive 显隐 gate（设置开关 + popup 快开关 + 全屏）、会话（采集上下文）与播放器动作；
// Vue 组件（entrypoints/content/ui/panel/*）只读渲染。组件不直接触碰 B 站 DOM。

import { reactive } from 'vue'
import type { AiContext, ChatHandlers, ChatInput, SummarizeInput, SummarizeResult } from '../ai/port'

/** 当前视频的采集会话：bvid 是 SPA 换视频的比对键（变化即面板状态复位）。 */
export interface PanelSession {
  bvid: string
  title: string
  context: AiContext
}

/** 接线层注入的面板动作：组件只经这里触达播放器/设置页/能力端口。 */
export interface PanelActions {
  /** 跳播：player.currentTime = seconds；无播放器时忽略。 */
  seek: (seconds: number) => void
  /** 打开设置页。 */
  openSettings: () => void
  /** 生成总结（经 resolveBackend 端口；调用方持 AbortSignal 停止）。 */
  summarize: (input: SummarizeInput) => Promise<SummarizeResult>
  /** 流式提问（SSE 三事件；调用方持 AbortSignal 停止）。 */
  chat: (input: ChatInput, handlers: ChatHandlers) => Promise<void>
  /** 重试上下文采集（面板错误态的重试按钮；接线层重置退避后立即再采）。 */
  retryCollection: () => void
}

export const panel = reactive({
  /** 设置页总开关 panelEnabled（storage.onChanged 同步过来）。 */
  masterEnabled: true,
  /** popup「总结面板」页内快开关（本页内生效，不持久化）。 */
  pageEnabled: true,
  /** 全屏态：全屏时面板隐藏（提示条/标记不受影响）。 */
  fullscreen: false,
  /** 设置读回完成前保持隐藏：panelEnabled=false 用户不会看到面板闪现。 */
  ready: false,
  /** 当前视频会话；null = 尚未采集完成（组件按 session.bvid 键控，变化即自复位）。 */
  session: null as PanelSession | null,
  /**
   * 上下文采集硬失败（视频元数据取不到）：会话为 null 时面板展示错误态 + 重试按钮。
   * 字幕/弹幕/评论单源失败走 allSettled 拼部分上下文，不算采集失败。
   */
  collectError: false,
})

/** 面板头副标题信号：SummaryTab/ChatTab 写入，PanelApp 读取。 */
export const panelActivity = reactive({
  /** 总结状态：生成中 → 副标题「正在阅读视频字幕…」；完成 → 相对时间。 */
  summaryStatus: 'idle' as 'idle' | 'generating' | 'done',
  summaryDoneAt: null as number | null,
  /** 提问流式中（副标题「正在回答…」）。 */
  chatAnswering: false,
})

/** 动作默认实现为空/拒绝：未接线时组件行为安全（面板隐藏，不会触发）。 */
export const panelActions: PanelActions = {
  seek: () => {},
  openSettings: () => {},
  summarize: () => Promise.reject(new Error('面板尚未接线：summarize 不可用')),
  chat: () => Promise.reject(new Error('面板尚未接线：chat 不可用')),
  retryCollection: () => {},
}

/** 面板可见性纯判定（接线层采集/显隐 gate 单点）：设置读回 + 总开关/页内开关 + 非全屏 + 页面可见。 */
export function panelVisibleNow(
  state: { ready: boolean; masterEnabled: boolean; pageEnabled: boolean; fullscreen: boolean },
  pageVisible: boolean,
): boolean {
  return state.ready && state.masterEnabled && state.pageEnabled && !state.fullscreen && pageVisible
}

/** 采集失败退避：指数增长带封顶（base/max 供测试注入，接线层用默认值）。 */
export function panelBackoffMs(
  failures: number,
  baseMs = 10_000,
  maxMs = 300_000,
): number {
  const exponent = Math.max(0, Math.floor(failures))
  return Math.min(baseMs * 2 ** exponent, maxMs)
}