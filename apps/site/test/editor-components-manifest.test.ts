import test from "node:test"
import assert from "node:assert/strict"
import {
  editorComponentsManifestSchema,
  validateManifestDefaultProps
} from "../lib/editor-components-contract.ts"
import { buildEditorComponentsManifest } from "../lib/editor-components-manifest.ts"

test("buildEditorComponentsManifest returns schema-valid manifest with valid defaults", () => {
  const manifest = buildEditorComponentsManifest()
  const parsed = editorComponentsManifestSchema.safeParse(manifest)
  assert.equal(parsed.success, true)
  if (!parsed.success) return

  const defaultsError = validateManifestDefaultProps(parsed.data.components)
  assert.equal(defaultsError, null)
  assert.ok(parsed.data.components.length > 0)

  const hero = parsed.data.components.find((component) => component.type === "Hero")
  assert.ok(hero)
  const heroProps = (hero?.propsSchema.properties ?? {}) as Record<string, unknown>
  const imagePosition = heroProps.imagePosition as Record<string, unknown> | undefined
  assert.equal(imagePosition?.type, "string")
  assert.deepEqual(imagePosition?.enum, ["left", "right"])
  assert.equal(hero?.defaultProps?.imagePosition, "right")
})
