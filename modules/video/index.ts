// 采集归一化入口：三个 provider 与视频元数据全部转发到 collectors 真实实现，
// 端口侧布局不变（接口签名保持，便于测试注入）。

export { collectComments, collectDanmaku, collectSubtitles, collectVideoMeta } from './collectors'
export type { Comment, Danmaku, Subtitle, VideoMeta } from './types'