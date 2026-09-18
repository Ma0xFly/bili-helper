// 功能层测试共用工具：构造完整的 FeatureConfigMap 与单条 FeatureEntry。
import { FEATURE_IDS, FEATURE_REGISTRY } from './config'
import type { FeatureConfigMap, FeatureConfigShapes, FeatureEntry, FeatureId } from './config'

export function entryOf<K extends FeatureId>(
  id: K,
  configPatch: Partial<FeatureConfigShapes[K]> = {},
  enabled = true,
): FeatureEntry<K> {
  return {
    config: { ...FEATURE_REGISTRY[id].defaults, ...configPatch },
    enabled,
  }
}

/** 全功能「开着」的默认地图（测试里按需关掉；管理器只认 enabled + 注入面）。 */
export const DEFAULT_DUMMY_CONFIGS: FeatureConfigMap = Object.fromEntries(
  FEATURE_IDS.map((id) => [id, entryOf(id)]),
) as FeatureConfigMap
