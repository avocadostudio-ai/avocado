import { useEffect, useMemo, useState } from "react"
import { editorComponentsManifestSchema, type EditorComponentDefinition } from "@ai-site-editor/shared"
import { siteOrigin } from "../lib/editor-utils"

type ManifestStatus = "loading" | "ready" | "degraded"

export type ComponentManifestState = {
  status: ManifestStatus
  components: EditorComponentDefinition[]
  reason?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validateBySimpleJsonSchema(schema: Record<string, unknown>, value: unknown): boolean {
  const type = typeof schema.type === "string" ? schema.type : undefined
  if (type === "object") {
    if (!isObject(value)) return false
    const props = isObject(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : []
    for (const key of required) {
      if (!(key in value)) return false
    }
    for (const [key, propSchema] of Object.entries(props)) {
      if (!(key in value)) continue
      if (!isObject(propSchema)) continue
      if (!validateBySimpleJsonSchema(propSchema, value[key])) return false
    }
    return true
  }
  if (type === "array") {
    if (!Array.isArray(value)) return false
    const items = schema.items
    if (isObject(items)) return value.every((item) => validateBySimpleJsonSchema(items, item))
    return true
  }
  if (type === "string") return typeof value === "string"
  if (type === "number" || type === "integer") return typeof value === "number" && Number.isFinite(value)
  if (type === "boolean") return typeof value === "boolean"
  return true
}

function validateManifestDefaults(components: EditorComponentDefinition[]) {
  for (const component of components) {
    if (!component.defaultProps) continue
    if (!validateBySimpleJsonSchema(component.propsSchema, component.defaultProps)) {
      return `defaultProps do not match propsSchema for component "${component.type}"`
    }
  }
  return null
}

export function useComponentManifest() {
  const [state, setState] = useState<ComponentManifestState>({
    status: "loading",
    components: []
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
            reason: "Manifest response shape is invalid"
          })
          return
        }

        const defaultValidationError = validateManifestDefaults(parsed.data.components)
        if (defaultValidationError) {
          if (!active) return
          setState({
            status: "degraded",
            components: [],
            reason: defaultValidationError
          })
          return
        }

        if (!active) return
        setState({
          status: "ready",
          components: parsed.data.components
        })
      } catch (error) {
        if (!active) return
        setState({
          status: "degraded",
          components: [],
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

