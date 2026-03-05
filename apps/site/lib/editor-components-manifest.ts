import type { EditorComponentsManifest } from "./editor-components-contract.ts"
import { getSiteComponentRegistry } from "./site-component-registry.ts"

export function buildEditorComponentsManifest(): EditorComponentsManifest {
  const components = getSiteComponentRegistry()

  return {
    version: 1,
    components
  }
}
