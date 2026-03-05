import type { EditorComponentsManifest } from "./editor-components-contract"
import { siteComponentRegistry } from "./site-component-registry"

export function buildEditorComponentsManifest(): EditorComponentsManifest {
  return {
    version: 1,
    components: siteComponentRegistry.map((entry) => structuredClone(entry))
  }
}
