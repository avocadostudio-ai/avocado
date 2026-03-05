import { useEffect, useMemo, useState } from "react"
import {
  editorComponentsManifestSchema,
  validateManifestDefaultProps,
  type EditorComponentDefinition,
  type EditorComponentsManifest
} from "@ai-site-editor/shared"
import { siteOrigin } from "../lib/editor-utils"

type ManifestStatus = "loading" | "ready" | "degraded"

export type ComponentManifestState = {
  status: ManifestStatus
  components: EditorComponentDefinition[]
  version?: number
  manifest: EditorComponentsManifest | null
  reason?: string
}

export function useComponentManifest() {
  const [state, setState] = useState<ComponentManifestState>({
    status: "loading",
    components: [],
    manifest: null
  })

  useEffect(() => {
    let active = true

    const run = async () => {
      try {
        const res = await fetch(`${siteOrigin}/api/editor/components`)
        if (!res.ok) {
          if (!active) return
          setState({
            status: "degraded",
            components: [],
            manifest: null,
            reason: `Manifest endpoint returned ${res.status}`
          })
          return
        }
        const payload = (await res.json()) as unknown
        const parsed = editorComponentsManifestSchema.safeParse(payload)
        if (!parsed.success) {
          if (!active) return
          setState({
            status: "degraded",
            components: [],
            manifest: null,
            reason: "Manifest response shape is invalid"
          })
          return
        }

        const defaultValidationError = validateManifestDefaultProps(parsed.data.components)
        if (defaultValidationError) {
          if (!active) return
          setState({
            status: "degraded",
            components: [],
            manifest: null,
            reason: defaultValidationError
          })
          return
        }

        if (!active) return
        setState({
          status: "ready",
          components: parsed.data.components,
          version: parsed.data.version,
          manifest: parsed.data
        })
      } catch (error) {
        if (!active) return
        setState({
          status: "degraded",
          components: [],
          manifest: null,
          reason: error instanceof Error ? error.message : "Manifest fetch failed"
        })
      }
    }

    void run()
    return () => {
      active = false
    }
  }, [])

  const byType = useMemo(() => {
    const map = new Map<string, EditorComponentDefinition>()
    for (const component of state.components) {
      map.set(component.type, component)
    }
    return map
  }, [state.components])

  return {
    ...state,
    byType,
    allowStructuralEdits: state.status === "ready"
  }
}
