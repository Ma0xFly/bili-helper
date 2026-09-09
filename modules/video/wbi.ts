// B 站 wbi 签名：评论等接口需要 wts + w_rid 参数。
// MD5 为纯 TS 实现（Web Crypto 不支持 MD5），密钥表/混钥规则按 B 站公开约定。
// 只签名 api.bilibili.com 自有端点；签名失败向上抛，由采集 provider 各自吞掉降级为空数组。

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]

/** wbi 密钥缓存的存活时长（毫秒）：密钥轮换不频繁，拉一次用半天。 */
const WBI_KEY_TTL_MS = 12 * 60 * 60 * 1000

interface WbiKeyCache {
  fetchedAt: number
  imgKey: string
  subKey: string
}

let keyCache: WbiKeyCache | null = null
let keyPromise: Promise<WbiKeyCache> | null = null

/** 清空 wbi 密钥缓存（测试隔离用；线上自然过期即可，不必主动调用）。 */
export function resetWbiKeyCache(): void {
  keyCache = null
  keyPromise = null
}

export async function fetchJsonWithWbi(
  url: string,
  params: Record<string, string | number>,
  signal?: AbortSignal,
): Promise<unknown> {
  const keys = await wbiKeys()
  return fetchUrl(`${url}?${signWbiParams(params, keys)}`, signal)
}

/** 用 wbi 规则给参数签名；返回 wts/w_rid 就位的参数字符串（先 wts 后 w_rid 约定）。 */
function signWbiParams(
  params: Record<string, string | number>,
  keys: { imgKey: string; subKey: string },
): string {
  const wts = Math.round(Date.now() / 1000)
  const sorted: Record<string, string | number> = { ...params, wts }
  const query = Object.keys(sorted)
    .sort()
    .map((key) => `${key}=${encodeURIComponent(String(sorted[key]).replace(/[!'()*]/g, ''))}`)
    .join('&')
  const wRid = md5(`${query}${getMixinKey(keys.imgKey + keys.subKey)}`)
  return `${query}&w_rid=${wRid}`
}

function getMixinKey(orig: string): string {
  return MIXIN_KEY_ENC_TAB.map((n) => orig[n]).join('').slice(0, 32)
}

/** 取 wbi 密钥：img_key/sub_key 来自 /x/web-interface/nav 的 wbi_img URL 文件名字段。 */
async function wbiKeys(): Promise<{ imgKey: string; subKey: string }> {
  if (keyCache && Date.now() - keyCache.fetchedAt < WBI_KEY_TTL_MS) return keyCache
  if (!keyPromise) {
    keyPromise = (async () => {
      const data = await fetchUrl('https://api.bilibili.com/x/web-interface/nav')
      const { imgKey, subKey } = extractWbiKeys(data)
      if (!imgKey || !subKey) throw new Error('wbi 密钥缺失')
      keyCache = { fetchedAt: Date.now(), imgKey, subKey }
      return keyCache
    })().catch((error) => {
      keyPromise = null
      throw error
    })
  }
  return keyPromise
}

/** nav 响应里解出 img_key/sub_key（wbi_img URL 的文件名段）。 */
function extractWbiKeys(data: unknown): { imgKey: string; subKey: string } {
  if (!isRecord(data) || !isRecord(data.data)) return { imgKey: '', subKey: '' }
  const wbiImg = data.data.wbi_img
  if (!isRecord(wbiImg)) return { imgKey: '', subKey: '' }
  return {
    imgKey: urlFileName(typeof wbiImg.img_url === 'string' ? wbiImg.img_url : ''),
    subKey: urlFileName(typeof wbiImg.sub_url === 'string' ? wbiImg.sub_url : ''),
  }
}

function urlFileName(url: string): string {
  const segment = url.split('/').pop() ?? ''
  const dot = segment.indexOf('.')
  return dot >= 0 ? segment.slice(0, dot) : segment
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function fetchUrl(url: string, signal?: AbortSignal): Promise<unknown> {
  if (typeof fetch !== 'function') throw new Error('当前环境没有 fetch')
  const response = await fetch(url, { credentials: 'include', signal })
  if (!response.ok) throw new Error(`请求失败：${response.status}`)
  return await response.json()
}

// ---------- MD5（纯 TS，标准实现） ----------

const MD5_ROTATE = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]

const MD5_CONSTANTS = Array.from({ length: 64 }, (_unused, i) =>
  Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32),
)

function rotateLeft(value: number, count: number): number {
  return ((value << count) | (value >>> (32 - count))) >>> 0
}

export function md5(input: string): string {
  const bytes = new TextEncoder().encode(input)
  const bitLen = bytes.length * 8
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, bitLen >>> 0, true)
  view.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000), true)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476

  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = new Uint32Array(padded.buffer, offset, 16)
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let i = 0; i < 64; i += 1) {
      let f: number
      let g: number
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }
      const temp = d
      d = c
      c = b
      b =
        (b +
          rotateLeft(
            a + f + (MD5_CONSTANTS[i] ?? 0) + (words[g] ?? 0),
            MD5_ROTATE[i] ?? 0,
          )) >>>
        0
      a = temp
    }
    a0 = (a0 + a) >>> 0
    b0 = (b0 + b) >>> 0
    c0 = (c0 + c) >>> 0
    d0 = (d0 + d) >>> 0
  }

  return (
    hexWord(a0) + hexWord(b0) + hexWord(c0) + hexWord(d0)
  )
}

// MD5 摘要字符串按标准约定以小端字节序输出每个 32 位字。
function hexWord(word: number): string {
  return [0, 1, 2, 3]
    .map((shift) => ((word >>> (shift * 8)) & 0xff).toString(16).padStart(2, '0'))
    .join('')
}