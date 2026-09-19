<script setup lang="ts">
// 极简首页背景面板（Epic3-S3.6 设置页侧）：URL（仅 https）与本地图片（压缩 ≤3MB）两种来源；
// 本地图存 storage.local（base64），URL 直写功能配置。只在「极简首页」开启时展开。
import { onMounted, ref } from 'vue'
import { readFeatureConfig, writeFeatureConfig } from '../../modules/features/config'
import { MINIMAL_HOMEPAGE_DEFAULT_BACKGROUND } from '../../modules/features/config'
import type { MinimalHomepageConfig } from '../../modules/features/layout/minimal-homepage'
import { MINIMAL_BG_STORAGE_KEY, compressBackgroundImage } from '../../modules/features/layout/minimal-homepage'

const urlDraft = ref('')
const source = ref<'url' | 'local'>('url')
const localInfo = ref('')
const busy = ref(false)
const hint = ref('')

onMounted(async () => {
  const entry = await readFeatureConfig('minimalHomepage')
  const config = entry.config as unknown as MinimalHomepageConfig
  source.value = config.backgroundSource
  urlDraft.value = config.backgroundUrl
  await refreshLocalInfo()
})

async function refreshLocalInfo(): Promise<void> {
  try {
    const stored = (await chrome.storage.local.get(MINIMAL_BG_STORAGE_KEY)) as Record<string, unknown>
    const record = stored[MINIMAL_BG_STORAGE_KEY] as { dataUrl?: string; name?: string } | undefined
    localInfo.value = record?.dataUrl ? `${record.name ?? '本地图片'}（已启用）` : '未设置本地图片'
  } catch {
    localInfo.value = ''
  }
}

async function saveUrl(): Promise<void> {
  const value = urlDraft.value.trim()
  if (!/^https:\/\//u.test(value)) {
    hint.value = '请输入有效的 HTTPS 图片 URL'
    return
  }
  busy.value = true
  try {
    await writeFeatureConfig('minimalHomepage', { backgroundSource: 'url', backgroundUrl: value })
    hint.value = '背景 URL 已保存'
  } catch {
    hint.value = '保存失败，请稍后重试'
  } finally {
    busy.value = false
  }
}

async function resetUrl(): Promise<void> {
  busy.value = true
  try {
    await writeFeatureConfig('minimalHomepage', {
      backgroundSource: 'url',
      backgroundUrl: MINIMAL_HOMEPAGE_DEFAULT_BACKGROUND,
    })
    urlDraft.value = MINIMAL_HOMEPAGE_DEFAULT_BACKGROUND
    hint.value = '已恢复默认背景'
  } catch {
    hint.value = '恢复失败，请稍后重试'
  } finally {
    busy.value = false
  }
}

async function pickLocal(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file === undefined) {
    hint.value = '请选择一张图片'
    return
  }
  if (!/^image\/(jpeg|png|webp)$/u.test(file.type)) {
    hint.value = '仅支持 JPG、PNG 或 WebP 图片'
    return
  }
  busy.value = true
  try {
    const { dataUrl } = await compressBackgroundImage(file)
    await chrome.storage.local.set({
      [MINIMAL_BG_STORAGE_KEY]: { dataUrl, name: file.name, storedSize: dataUrl.length },
    })
    await writeFeatureConfig('minimalHomepage', { backgroundSource: 'local' })
    hint.value = '本地背景已保存'
    await refreshLocalInfo()
  } catch (error) {
    hint.value = error instanceof Error ? error.message : '图片处理失败，请换一张重试'
  } finally {
    busy.value = false
  }
}

async function clearLocal(): Promise<void> {
  busy.value = true
  try {
    await chrome.storage.local.remove(MINIMAL_BG_STORAGE_KEY)
    await writeFeatureConfig('minimalHomepage', { backgroundSource: 'url' })
    hint.value = '已清除本地背景，回到 URL 来源'
    await refreshLocalInfo()
  } catch {
    hint.value = '清除失败，请稍后重试'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="bg-panel" aria-label="背景图片">
    <div class="bg-head">
      <strong>背景图片</strong>
      <span class="bg-badge">当前使用{{ source === 'local' ? '本地图片' : '图片 URL' }}</span>
    </div>
    <label class="bg-field">
      <span>图片 URL（仅 https）</span>
      <div class="bg-row">
        <input v-model="urlDraft" type="url" placeholder="https://..." aria-label="背景图片 URL" />
        <button type="button" :disabled="busy" @click="saveUrl">保存 URL</button>
        <button type="button" :disabled="busy" @click="resetUrl">恢复默认</button>
      </div>
    </label>
    <div class="bg-field">
      <span>本地图片（自动压缩，≤3MB）· {{ localInfo }}</span>
      <div class="bg-row">
        <label class="bg-file">
          选择本地图片
          <input type="file" accept="image/jpeg,image/png,image/webp" aria-label="选择本地背景图片" @change="pickLocal" />
        </label>
        <button type="button" :disabled="busy" @click="clearLocal">清除本地图片</button>
      </div>
    </div>
    <p v-if="hint" class="bg-hint" :class="{ ok: hint.includes('已') }">{{ hint }}</p>
  </div>
</template>

<style scoped>
.bg-panel {
  margin-top: 12px;
  padding: 12px 14px;
  border: 1px solid rgba(124, 92, 252, 0.25);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bg-head { display: flex; align-items: center; gap: 10px; font-size: 13px; color: #2e2a3b; }
.bg-badge { font-size: 11.5px; color: #7c5cfc; background: rgba(124,92,252,.1); border-radius: 6px; padding: 1px 8px; }
.bg-field { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: #4c4661; }
.bg-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.bg-row input[type='url'] {
  flex: 1; min-width: 200px; font: inherit; font-size: 12.5px;
  border: 1px solid #d9d4e8; border-radius: 8px; padding: 6px 10px;
}
.bg-row button, .bg-file {
  font: inherit; font-size: 12.5px; border: 1px solid #d9d4e8; background: #fff;
  color: #4c4661; border-radius: 8px; padding: 5px 12px; cursor: pointer;
}
.bg-file { position: relative; overflow: hidden; }
.bg-file input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.bg-hint { margin: 0; font-size: 12px; color: #c04040; }
.bg-hint.ok { color: #1f8848; }
</style>
