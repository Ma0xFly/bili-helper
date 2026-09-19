// Shadow DOM 浮层的共享响应式状态：控制器（modules/content/ad-skip-controller）drive 状态，
// Vue 组件（entrypoints/content/ui/*）只管渲染。动作回调由控制器注入，
// 组件不直接触碰 B 站 DOM。

import { reactive } from 'vue'
import type { AdSegment, SummarySegment } from '../ai/port'

export interface BannerState {
  visible: boolean
  /** 主文案（含商品名时前置）。 */
  copy: string
  /** 副文案：恰饭段时间区间 + 自动跳过声明。 */
  sub: string
  /** 倒计时环数字（1..3）；null = 静态环（手动拖入立即跳过态）。 */
  countdown: number | null
  /** 环进度 0..1（剩余秒数 / 3），随播放推进衰减。 */
  progress: number
  /** 当前段身份键（segmentKey）：「不是广告」纠错按钮用它定位段。 */
  key: string
}

export interface SavedChipState {
  visible: boolean
  text: string
}

export interface AdMarkState {
  key: string
  /** 相对进度条本体的横向百分比（标记层盒子 = 进度条几何）。 */
  leftPct: number
  widthPct: number
  productName: string
  range: string
  done: boolean
}

/** 章节标记渲染态：与 AdMarkState 同挂在进度条标记盒上，几何由章节跟踪器同步。 */
export interface ChapterMarkState {
  key: string
  /** 相对进度条本体的横向百分比（起点位置）。 */
  leftPct: number
  /** 章节起点（秒）：点击跳转目标。 */
  start: number
  label: string
  /** 起点时间文案（mm:ss / H:mm:ss），tooltip 用。 */
  timeText: string
  source: 'official' | 'ai'
}

/** 漏报标记态：两次点击之间（起点已记、终点未定）的进行中提示。 */
export interface MarkingState {
  active: boolean
  /** 标记起点（秒）。 */
  start: number
  startText: string
}

/**
 * 标记层盒子：直接跟随 B 站进度条本体的几何（相对播放器容器的 px），
 * 并镜像控制层显隐——B 站控制层淡出/收起时标记必须一起消失，不能悬在原地。
 * top = 进度条垂直中心线。
 */
export interface MarksBoxState {
  visible: boolean
  left: number
  top: number
  width: number
}

export interface OverlayGeometry {
  visible: boolean
  left: number
  top: number
  width: number
  height: number
}

export interface UiActions {
  onSkipNow: () => void
  onStay: () => void
  onOpenSettings: () => void
  /** 章节标记点击跳转（接线层注入；无播放器时忽略）。 */
  onSeek: (seconds: number) => void
  /** 「这段不是广告」纠错（key = segmentKey；横幅/标记 tooltip 都走这里）。 */
  onMarkNotAd: (key: string) => void
  /** 漏报标记两拍流：开始（记当前播放位置）/ 结束并入广告段 / 取消。 */
  onStartMarkAd: () => void
  onFinishMarkAd: () => void
  onCancelMarkAd: () => void
}

export const ui = reactive({
  /** 跟随 B 站夜间模式；true 时整套 token 切暗色。 */
  dark: false,
  overlay: { visible: false, left: 0, top: 0, width: 0, height: 0 } as OverlayGeometry,
  banner: { visible: false, copy: '', sub: '', countdown: 3, progress: 1, key: '' } as BannerState,
  chip: { visible: false, text: '' } as SavedChipState,
  vectorHint: { visible: false, text: '向量端点（Embedding）的 API 有问题，暂时只用词表匹配' },
  marks: [] as AdMarkState[],
  /** 章节标记（官方看点 + AI 时间线合并后），接线层维护。 */
  chapterMarks: [] as ChapterMarkState[],
  marksBox: { visible: false, left: 0, top: 0, width: 0 } as MarksBoxState,
  /**
   * 去广告检测结果镜像（控制器维护）：AI 面板分段时间线与广告区间合并打标用。
   * adSkipEnabled 关/无广告时为空数组 → 面板纯分段。
   */
  ads: [] as AdSegment[],
  /**
   * 最近一次总结的分段时间线镜像（SummaryTab 生成成功时写入）：
   * 章节接线层监听它 → 持久化缓存 + 与官方看点合并上条。换视频/未生成为空数组。
   */
  summarySegments: [] as SummarySegment[],
  /** 播放进度（秒），面板当前分段高亮用（由面板接线层轮询驱动）。 */
  currentTime: 0,
  /** 漏报标记进行中态（MarkingChip 渲染）。 */
  marking: { active: false, start: 0, startText: '' } as MarkingState,
  actions: {
    onSkipNow: () => {},
    onStay: () => {},
    onOpenSettings: () => {},
    onSeek: (_seconds: number) => {},
    onMarkNotAd: (_key: string) => {},
    onStartMarkAd: () => {},
    onFinishMarkAd: () => {},
    onCancelMarkAd: () => {},
  } as UiActions,
})