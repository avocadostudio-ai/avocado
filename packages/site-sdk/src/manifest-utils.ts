import { deriveFieldMetaFromSchema, type BlockManifest } from "@avocadostudio-ai/shared"

export type ManifestFieldInfo = {
  /** Top-level image fields per block type (e.g. Hero → {"imageUrl"}) */
  imageFields: Map<string, Set<string>>
  /** Image fields within list items per block type + list key (e.g. CardGrid → cards → {"imageUrl"}) */
  listImageFields: Map<string, Map<string, Set<string>>>
  /** All list field names per block type (e.g. CardGrid → {"cards"}, FeatureGrid → {"features"}) */
  listFieldNames: Map<string, Set<string>>
}

const _cache = new WeakMap<BlockManifest, ManifestFieldInfo>()

/**
 * Derive field metadata per block type from the manifest's propsSchema.
 * Cached by manifest reference — safe to call from multiple modules.
 *
 * Works for both default blocks (via buildBlockManifest()) and custom blocks
 * (via developer-provided getManifest()). No shared block registry needed.
 */
export function getManifestImageFields(manifest: BlockManifest): ManifestFieldInfo {
  const cached = _cache.get(manifest)
  if (cached) return cached

  const imageFields = new Map<string, Set<string>>()
  const listImageFields = new Map<string, Map<string, Set<string>>>()
  const listFieldNames = new Map<string, Set<string>>()

  for (const block of manifest.blocks) {
    const { fields, listFields } = deriveFieldMetaFromSchema(block.propsSchema)

    const imgs = new Set<string>()
    for (const [key, meta] of Object.entries(fields)) {
      if (meta.kind === "image") imgs.add(key)
    }
    imageFields.set(block.type, imgs)

    const listNames = new Set(Object.keys(listFields))
    if (listNames.size > 0) listFieldNames.set(block.type, listNames)

    const listImgs = new Map<string, Set<string>>()
    for (const [listKey, listMeta] of Object.entries(listFields)) {
      const itemImgs = new Set<string>()
      for (const [itemKey, itemMeta] of Object.entries(listMeta.itemFields)) {
        if (itemMeta.kind === "image") itemImgs.add(itemKey)
      }
      if (itemImgs.size > 0) listImgs.set(listKey, itemImgs)
    }
    if (listImgs.size > 0) listImageFields.set(block.type, listImgs)
  }

  const result = { imageFields, listImageFields, listFieldNames }
  _cache.set(manifest, result)
  return result
}
