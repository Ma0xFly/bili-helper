// 采集层把 B 站原始字段归一到这些形状，时间一律「秒（number）」；
// HH:MM:SS 只在 UI 层格式化。适配器不得各自重新解析原始字段。

export interface VideoMeta {
  bvid: string
  /** 视频分 P 的 cid；从 URL 无法解出，留待 page 状态填充。 */
  cid: number | undefined
  title: string
  duration: number
}

export interface Subtitle {
  start: number
  end: number
  text: string
}

export interface Danmaku {
  time: number
  text: string
}

export interface Comment {
  text: string
}