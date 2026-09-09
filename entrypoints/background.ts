import { defineBackground } from 'wxt/utils/define-background'

// 最小 service worker：当前仅作协调占位，无任何逻辑。
// 未来流式 AI 与采集由内容脚本直连端点，后台不承载长连接分发，
// 避免 MV3 service worker 生命周期干扰。
export default defineBackground(() => {})