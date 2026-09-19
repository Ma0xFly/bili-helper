// 无级倍速（Epic4-S4.1/S4.2）：接管播放器原生倍速菜单——预设项隐藏，注入 0.1–5（步进 0.01）
// 滑杆 + 7 个预设；直接改 HTMLMediaElement（不调 B 站播放器 API）；ratechange 强制回写配置值
// （外部改速以插件为准，自身写入经 WeakSet 标记不形成回环）；全局一份持久化（跨视频/标签/重启）。
// 直播间不生效（hostname 或 .live-room-app 判定，进入直播间恢复 1x）；停止恢复 1x 并移除 UI。

import { readFeatureConfig, writeFeatureConfig } from '../config'

export const RATE_PRESETS = [3, 2, 1.5, 1.25, 1, 0.75, 0.5] as const
export const RATE_MIN = 0.1
export const RATE_MAX = 5
const MENU_SELECTOR = '.bpx-player-ctrl-playbackrate-menu'
const MENU_ITEM_SELECTOR = '.bpx-player-ctrl-playbackrate-menu-item'
const RESULT_SELECTOR = '.bpx-player-ctrl-playbackrate-result'
const SLIDER_FLAG = 'data-bili-helper-rate-slider'
const MENU_RETRY_MS = 500
const MENU_RETRY_MAX = 20

export function normalizeRate(value: number): number {
  if (!Number.isFinite(value)) return 1
  const clamped = Math.min(RATE_MAX, Math.max(RATE_MIN, value))
  return Math.round(clamped * 100) / 100
}

export function isLivePage(doc: Document, hostname: string): boolean {
  if (hostname === 'live.bilibili.com') return true
  return doc.querySelector('.live-room-app') !== null
}

export function formatRateLabel(rate: number): string {
  return rate === 1 ? '倍速' : `${rate}x`
}

export function createSteplessRateRuntime(options: {
  doc?: Document
  hostname?: string
} = {}): { start(): void; stop(): void } {
  const doc = options.doc ?? (typeof document !== 'undefined' ? document : null)
  const hostname = options.hostname ?? (typeof location !== 'undefined' ? location.hostname : '')
  if (doc === null) return { start(): void {}, stop(): void {} }

  let rate = 1
  let style: HTMLStyleElement | null = null
  let menuTimer: number | undefined
  let menuRetries = 0
  let observer: MutationObserver | null = null
  let ratechangeHandler: ((event: Event) => void) | null = null

  const applyRate = (value: number): void => {
    for (const video of [...doc.querySelectorAll('video')]) {
      const media = video as HTMLMediaElement
      media.defaultPlaybackRate = value
      media.playbackRate = value
    }
  }

  const persist = (value: number): void => {
    writeFeatureConfig('steplessVideoRate', { rate: value }).catch(() => {
      console.error('[bili-helper:stepless-rate] failed to persist rate')
    })
  }

  const setRate = (value: number, persistIt: boolean): void => {
    rate = normalizeRate(value)
    applyRate(rate)
    updateMenu()
    if (persistIt) persist(rate)
  }

  const updateMenu = (): void => {
    const menu = doc.querySelector(MENU_SELECTOR)
    if (menu === null) return
    // 注意：SLIDER_FLAG 挂在外层 li 上，回显要找里面的 input。
    const slider = menu.querySelector<HTMLInputElement>(`[${SLIDER_FLAG}] input[type='range']`)
    if (slider !== null) slider.value = String(rate)
    menu.querySelectorAll('[data-bili-helper-rate-preset]').forEach((el) => {
      const preset = Number((el as HTMLElement).dataset.biliHelperRatePreset)
      el.toggleAttribute('data-active', preset === rate)
      el.setAttribute('aria-pressed', preset === rate ? 'true' : 'false')
    })
    const result = doc.querySelector(RESULT_SELECTOR)
    if (result !== null) result.textContent = formatRateLabel(rate)
  }

  const injectMenu = (): void => {
    const menu = doc.querySelector(MENU_SELECTOR)
    if (menu === null) {
      if (menuRetries < MENU_RETRY_MAX) {
        menuRetries += 1
        menuTimer = window.setTimeout(injectMenu, MENU_RETRY_MS)
      }
      return
    }
    if (menu.querySelector(`[${SLIDER_FLAG}]`) !== null) return
    if (style === null) {
      style = doc.createElement('style')
      // 隐藏原生预设项（保留我们的注入块）。
      style.textContent = `${MENU_SELECTOR} > ${MENU_ITEM_SELECTOR} { display: none !important; } [${SLIDER_FLAG}] { display: flex !important; align-items: center; gap: 6px; padding: 6px 10px; color: #fff; } [${SLIDER_FLAG}] input[type='range'] { width: 120px; accent-color: #fb7299; } [data-bili-helper-rate-preset] { background: none; border: none; color: #fff; font-size: 12px; cursor: pointer; padding: 2px 4px; } [data-bili-helper-rate-preset][data-active] { color: #fb7299; font-weight: 700; }`
      doc.head.append(style)
    }
    const block = doc.createElement('li')
    block.setAttribute(SLIDER_FLAG, 'true')
    const slider = doc.createElement('input')
    slider.type = 'range'
    slider.min = String(RATE_MIN)
    slider.max = String(RATE_MAX)
    slider.step = '0.01'
    slider.value = String(rate)
    slider.setAttribute('aria-label', '无级倍速')
    slider.addEventListener('input', () => setRate(Number(slider.value), false)) // 拖动即时生效
    slider.addEventListener('change', () => setRate(Number(slider.value), true)) // 松手才落库
    block.append(slider)
    for (const preset of RATE_PRESETS) {
      const button = doc.createElement('button')
      button.type = 'button'
      button.textContent = `${preset}x`
      button.dataset.biliHelperRatePreset = String(preset)
      button.addEventListener('click', () => setRate(preset, true))
      block.append(button)
    }
    menu.append(block)
    updateMenu()
  }

  const watchVideos = (): void => {
    observer = new MutationObserver(() => {
      if (isLivePage(doc, hostname)) {
        applyRate(1)
        return
      }
      // 新出现的视频（换 P/换清晰度重建 video）：按当前配置速率播放。
      for (const video of [...doc.querySelectorAll('video')]) {
        const media = video as HTMLMediaElement
        if (media.playbackRate !== rate) applyRate(rate)
      }
    })
    observer.observe(doc.documentElement, { childList: true, subtree: true })
    // ratechange 回写：外部（B 站/其它脚本）改速 → 强制回到配置值；自身写入不触发回环。
    ratechangeHandler = (event: Event): void => {
      const media = event.target as HTMLMediaElement
      if (media.playbackRate === rate) return
      applyRate(rate)
      console.info('[bili-helper:stepless-rate] 外部改速已回写', { enforced: rate })
    }
    doc.addEventListener('ratechange', ratechangeHandler, true)
  }

  return {
    async start(): Promise<void> {
      if (isLivePage(doc, hostname)) {
        console.info('[bili-helper:stepless-rate] 直播间不生效')
        return
      }
      console.info('[bili-helper:stepless-rate] started')
      try {
        const entry = await readFeatureConfig('steplessVideoRate')
        rate = normalizeRate((entry.config as { rate: number }).rate)
      } catch {
        rate = 1
      }
      menuRetries = 0
      injectMenu()
      watchVideos()
      applyRate(rate)
    },
    stop(): void {
      if (menuTimer !== undefined) window.clearTimeout(menuTimer)
      menuTimer = undefined
      observer?.disconnect()
      observer = null
      if (ratechangeHandler !== null) {
        doc.removeEventListener('ratechange', ratechangeHandler, true)
        ratechangeHandler = null
      }
      doc.querySelector(`[${SLIDER_FLAG}]`)?.remove()
      style?.remove()
      style = null
      for (const video of [...doc.querySelectorAll('video')]) {
        const media = video as HTMLMediaElement
        if (media.playbackRate !== 1) {
          media.playbackRate = 1
          media.defaultPlaybackRate = 1
        }
      }
      const result = doc.querySelector(RESULT_SELECTOR)
      if (result !== null) result.textContent = formatRateLabel(1)
      console.info('[bili-helper:stepless-rate] stopped（倍速恢复 1x）')
    },
  }
}
