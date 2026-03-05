import test from "node:test"
import assert from "node:assert/strict"
import {
  editorComponentsManifestSchema,
  validateManifestDefaultProps
} from "@ai-site-editor/shared"
import { buildEditorComponentsManifest } from "../lib/editor-components-manifest.ts"

test("buildEditorComponentsManifest returns schema-valid manifest with valid defaults", () => {
  const manifest = buildEditorComponentsManifest()
  const parsed = editorComponentsManifestSchema.safeParse(manifest)
  assert.equal(parsed.success, true)
  if (!parsed.success) return

  const defaultsError = validateManifestDefaultProps(parsed.data.components)
  assert.equal(defaultsError, null)
  assert.ok(parsed.data.components.length > 0)
})
