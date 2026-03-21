import test from "node:test"
import assert from "node:assert/strict"
import {
  blockManifestSchema,
  validateManifestDefaultProps,
  buildBlockManifest
} from "@ai-site-editor/site-sdk/editor-manifest"

test("buildBlockManifest returns schema-valid manifest with valid defaults", () => {
  const manifest = buildBlockManifest()
  const parsed = blockManifestSchema.safeParse(manifest)
  assert.equal(parsed.success, true)
  if (!parsed.success) return

  const defaultsError = validateManifestDefaultProps(parsed.data.blocks)
  assert.equal(defaultsError, null)
  assert.ok(parsed.data.blocks.length > 0)

  const hero = parsed.data.blocks.find((component) => component.type === "Hero")
  assert.ok(hero)
  const heroProps = (hero?.propsSchema.properties ?? {}) as Record<string, unknown>
  const imagePosition = heroProps.imagePosition as Record<string, unknown> | undefined
  assert.equal(imagePosition?.type, "string")
  assert.deepEqual(imagePosition?.enum, ["left", "right"])
  assert.equal(hero?.defaultProps?.imagePosition, "right")
})
