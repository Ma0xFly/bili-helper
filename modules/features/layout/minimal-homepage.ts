// 极简首页（Epic3-S3.5/S3.6）：首页只留居中搜索框，隐藏信息流/频道栏/横幅；背景支持
// URL（仅 https）与本地图片（base64 存 storage.local，≤3MB）；右下「切换背景」按钮
// 仅 URL 来源显示（换图只当次生效不写回配置）。stop = 样式/class/按钮全移除 + 搜索框还原。

export const MINIMAL_BODY_CLASS = 'bili-helper-minimal-homepage'
export const MINIMAL_STYLE_ID = 'bili-helper-minimal-homepage-style'
export const REFRESH_BUTTON_ID = 'bili-helper-minimal-homepage-refresh-background'
export const MINIMAL_BG_STORAGE_KEY = 'minimalHomepageBackgroundImage'
export const MAX_BACKGROUND_BYTES = 3 * 1024 * 1024
/** 本地图压缩参数：最长边与 JPEG 质量（旧产物口径）。 */
export const BACKGROUND_MAX_EDGE = 2560
export const BACKGROUND_JPEG_QUALITY = 0.86

export const MINIMAL_CSS = `
body.${MINIMAL_BODY_CLASS} .header-channel, body.${MINIMAL_BODY_CLASS} .bili-header__banner, body.${MINIMAL_BODY_CLASS} .bili-header__channel, body.${MINIMAL_BODY_CLASS} .bili-feed4-layout, body.${MINIMAL_BODY_CLASS} .palette-button-outer.palette-feed4, body.${MINIMAL_BODY_CLASS} .login-tip { display: none !important; }
body.${MINIMAL_BODY_CLASS} .center-search-container.offset-center-search { position: fixed !important; top: 45vh; left: 50%; transform: translate(-50%, -50%); width: min(720px, calc(100vw - 32px)); border-radius: 999px; box-shadow: 0 12px 40px rgba(0,0,0,.14); z-index: 100; }
body.${MINIMAL_BODY_CLASS} #app, body.${MINIMAL_BODY_CLASS} .bili-header, body.${MINIMAL_BODY_CLASS} #i_cecream { background: transparent !important; }
body.${MINIMAL_BODY_CLASS} { background-image: linear-gradient(rgba(245,244,250,.55), rgba(245,244,250,.55)), var(--bili-helper-minimal-homepage-background-image); background-size: cover; background-position: center; background-attachment: fixed; }
#${REFRESH_BUTTON_ID} { position: fixed; right: 24px; bottom: 24px; z-index: 2147483000; font-size: 12.5px; padding: 8px 14px; border-radius: 999px; border: 1px solid rgba(124,92,252,.4); background: rgba(255,255,255,.85); color: #4c4661; cursor: pointer; }
#${REFRESH_BUTTON_ID}:hover { background: #fff; }
`

export interface MinimalHomepageConfig {
  backgroundSource: 'url' | 'local'
  backgroundUrl: string
  backgroundVersion: number
}

export interface StoredBackgroundImage {
  dataUrl: string
  name: string
  storedSize: number
}

/** 本地图片压缩：等比缩到最长边 ≤2560 转 JPEG；压缩后仍超 3MB 抛错（文案由 UI 给）。 */
export async function compressBackgroundImage(file: File): Promise<{ dataUrl: string; storedSize: number }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(String(reader.result)))
    reader.addEventListener('error', () => reject(new Error('图片读取失败，请换一张图片重试')))
    reader.readAsDataURL(file)
  })
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image()
    el.addEventListener('load', () => resolve(el))
    el.addEventListener('error', () => reject(new Error('图片尺寸无效，请换一张图片重试')))
    el.src = dataUrl
  })
  const scale = Math.min(1, BACKGROUND_MAX_EDGE / Math.max(image.width, image.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.width * scale))
  canvas.height = Math.max(1, Math.round(image.height * scale))
  canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height)
  const output = canvas.toDataURL('image/jpeg', BACKGROUND_JPEG_QUALITY)
  if (output.length > MAX_BACKGROUND_BYTES) {
    throw new Error('图片压缩后仍超过 3 MB，请换一张更小的图片')
  }
  return { dataUrl: output, storedSize: output.length }
}

export function createMinimalHomepageRuntime(options: { doc?: Document; config?: MinimalHomepageConfig } = {}): {
  start(): void
  stop(): void
} {
  const doc = options.doc ?? (typeof document !== 'undefined' ? document : null)
  if (doc === null) return { start(): void {}, stop(): void {} }

  let style: HTMLStyleElement | null = null
  let button: HTMLElement | null = null
  let config: MinimalHomepageConfig | undefined = options.config
  let localDataUrl: string | null = null
  let placeholderBackup: { el: HTMLInputElement; placeholder: string; title: string } | null = null

  const applyBackground = (): void => {
    const value =
      config?.backgroundSource === 'local' && localDataUrl !== null
        ? `url("${localDataUrl}")`
        : `url("${config?.backgroundUrl ?? ''}")`
    doc.body.style.setProperty('--bili-helper-minimal-homepage-background-image', value)
  }

  const loadLocalBackground = async (): Promise<void> => {
    try {
      const stored = (await chrome.storage.local.get(MINIMAL_BG_STORAGE_KEY)) as Record<string, unknown>
      const record = stored[MINIMAL_BG_STORAGE_KEY] as { dataUrl?: unknown } | undefined
      if (typeof record?.dataUrl === 'string' && /^data:image\/(?:jpeg|png|webp);base64,/u.test(record.dataUrl)) {
        localDataUrl = record.dataUrl
      } else {
        localDataUrl = null
      }
    } catch {
      localDataUrl = null
    }
  }

  const ensureButton = (): void => {
    if (config?.backgroundSource !== 'url') return // 本地背景没有「换一张」语义
    if (button?.isConnected === true) return
    button = doc.createElement('button')
    ;(button as HTMLButtonElement).type = 'button'
    button.id = REFRESH_BUTTON_ID
    button.textContent = '切换背景'
    button.addEventListener('click', () => {
      // 只当次生效：给 URL 追加时间戳刷新缓存，不写回配置。
      const url = config?.backgroundUrl ?? ''
      if (url === '') return
      const stamped = url.includes('?') ? `${url}&t=${Date.now()}` : `${url}?t=${Date.now()}`
      doc.body.style.setProperty('--bili-helper-minimal-homepage-background-image', `url("${stamped}")`)
    })
    doc.body.append(button)
  }

  return {
    start(): void {
      console.info('[bili-helper:minimal-homepage] started')
      if (style === null) {
        style = doc.createElement('style')
        style.id = MINIMAL_STYLE_ID
        style.textContent = MINIMAL_CSS
        doc.head.append(style)
      }
      doc.body.classList.add(MINIMAL_BODY_CLASS)
      const input = doc.querySelector<HTMLInputElement>('input.nav-search-input')
      if (input !== null) {
        placeholderBackup = { el: input, placeholder: input.placeholder, title: input.title }
        input.placeholder = '搜索你感兴趣的内容…'
        input.title = '搜索'
      }
      void loadLocalBackground().then(() => {
        applyBackground()
        ensureButton()
      })
    },
    stop(): void {
      doc.body.classList.remove(MINIMAL_BODY_CLASS)
      doc.body.style.removeProperty('--bili-helper-minimal-homepage-background-image')
      style?.remove()
      style = null
      button?.remove()
      button = null
      if (placeholderBackup !== null) {
        placeholderBackup.el.placeholder = placeholderBackup.placeholder
        placeholderBackup.el.title = placeholderBackup.title
        placeholderBackup = null
      }
      console.info('[bili-helper:minimal-homepage] stopped')
    },
  }
}
