import { useEffect, useMemo, useState } from "react"
import {
  editorComponentsManifestSchema,
  validateManifestDefaultProps,
  type EditorComponentDefinition,
  type EditorComponentsManifest
} from "@ai-site-editor/shared"
import { siteOrigin } from "../lib/editor-utils"

type ManifestStatus = "loading" | "ready" | "degraded"
const MANIFEST_RETRY_MS = 3000

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
    let retryTimer: ReturnType<typeof setTimeout> | null = null

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
          retryTimer = setTimeout(() => {
            if (active) void run()
          }, MANIFEST_RETRY_MS)
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
          retryTimer = setTimeout(() => {
            if (active) void run()
          }, MANIFEST_RETRY_MS)
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
          retryTimer = setTimeout(() => {
            if (active) void run()
          }, MANIFEST_RETRY_MS)
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
        retryTimer = setTimeout(() => {
          if (active) void run()
        }, MANIFEST_RETRY_MS)
      }
    }

    void run()
    return () => {
      active = false
      if (retryTimer) clearTimeout(retryTimer)
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
    siteCapabilities: {
      allowStructuralEdits: state.status === "ready",
      manifestStatus: state.status,
      reason: state.reason,
      manifestVersion: state.version,
      componentCount: state.components.length,
      checkedAt: new Date().toISOString()
    },
    allowStructuralEdits: state.status === "ready"
  }
}
