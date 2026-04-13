import { SharedBlockRenderer, hasRenderer } from "@ai-site-editor/blocks"
import { getAllBlockMeta, type BlockManifest, type FieldMeta } from "@ai-site-editor/shared"
import { buildFields, registerRichtextKeys, convertPropsHtmlToMarkdown } from "./adapters"
import { PuckImageFieldControl } from "./PuckImageFieldControl"
import type { ImagePickerTarget, PuckCustomFieldRenderProps } from "./types"

export function createPuckConfig(
  manifest: BlockManifest,
  onOpenImagePicker?: (target: ImagePickerTarget) => void
) {
  const allMetaByType = getAllBlockMeta()

  const components = Object.fromEntries(
    manifest.blocks.map((def) => {
      const { fields, richtextKeys } = buildFields(def, allMetaByType[def.type], {
        mapImageField: (field: FieldMeta) => ({
          type: "custom",
          label: field.label,
          render: ({ value, onChange, readOnly }: PuckCustomFieldRenderProps) => (
            <PuckImageFieldControl
              value={typeof value === "string" ? value : ""}
              readOnly={Boolean(readOnly)}
              onChoose={() => {
                if (readOnly) return
                onOpenImagePicker?.({
                  currentUrl: typeof value === "string" ? value : undefined,
                  onSelect: (imageUrl) => onChange(imageUrl),
                })
              }}
              onClear={() => {
                if (readOnly) return
                onChange("")
              }}
            />
          ),
        })
      })
      registerRichtextKeys(def.type, richtextKeys)

      return [
        def.type,
        {
          fields,
          defaultProps: def.defaultProps,
          permissions: {
            drag: true,
            delete: true,
            duplicate: true,
            edit: true,
            insert: true,
          },
          render: (props: Record<string, unknown>) => {
            const blockId = typeof props._blockId === "string" && props._blockId.trim().length > 0
              ? props._blockId
              : `puck-${def.type}`
            const { _blockId: _, id: __, ...rawRest } = props
            const rest = convertPropsHtmlToMarkdown(def.type, rawRest)

            if (!hasRenderer(def.type)) {
              return (
                <section style={{ padding: "16px", border: "1px dashed #9ca3af", borderRadius: 8 }}>
                  <strong>{def.type}</strong>
                  <p style={{ margin: "8px 0 0", fontSize: 13 }}>
                    No renderer is registered for this block in the editor runtime.
                  </p>
                </section>
              )
            }

            return (
              <SharedBlockRenderer
                block={{
                  id: blockId,
                  type: def.type,
                  props: rest,
                }}
              />
            )
          }
        }
      ]
    })
  )

  return { components }
}
