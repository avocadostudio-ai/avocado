import { useEffect, useMemo, useState } from "react"
import {
  blockManifestSchema,
  validateManifestDefaultProps,
  type BlockDefinition,
  type BlockManifest
} from "@avocadostudio-ai/shared"
import { siteOrigin } from "../lib/editor-utils"

type ManifestStatus = "loading" | "ready" | "degraded"
const MANIFEST_RETRY_MS = 3000

export type BlockManifestState = {
  status: ManifestStatus
  blocks: BlockDefinition[]
  version?: number
  manifest: BlockManifest | null
  reason?: string
}

export function useBlockManifest(origin?: string) {
  const [state, setState] = useState<BlockManifestState>({
    status: "loading",
    blocks: [],
    manifest: null
  })

  useEffect(() => {
    let active = true
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const run = async () => {
      try {
        const base = origin || siteOrigin
        const res = await fetch(`${base}/api/editor/blocks`)
        if (!res.ok) {
          if (!active) return
          setState({
            status: "degraded",
            blocks: [],
            manifest: null,
            reason: `Manifest endpoint returned ${res.status}`
          })
          retryTimer = setTimeout(() => {
            if (active) void run()
          }, MANIFEST_RETRY_MS)
          return
        }
        const payload = (await res.json()) as unknown
        const parsed = blockManifestSchema.safeParse(payload)
        if (!parsed.success) {
          if (!active) return
          setState({
            status: "degraded",
            blocks: [],
            manifest: null,
            reason: "Manifest response shape is invalid"
          })
          retryTimer = setTimeout(() => {
            if (active) void run()
          }, MANIFEST_RETRY_MS)
          return
        }

        const defaultValidationError = validateManifestDefaultProps(parsed.data.blocks)
        if (defaultValidationError) {
          if (!active) return
          setState({
            status: "degraded",
            blocks: [],
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
          blocks: parsed.data.blocks,
          version: parsed.data.version,
          manifest: parsed.data
        })
      } catch (error) {
        if (!active) return
        setState({
          status: "degraded",
          blocks: [],
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
  }, [origin])

  const byType = useMemo(() => {
    const map = new Map<string, BlockDefinition>()
    for (const block of state.blocks) {
      map.set(block.type, block)
    }
    return map
  }, [state.blocks])

  return {
    ...state,
    byType,
    siteCapabilities: {
      allowStructuralEdits: state.status === "ready",
      manifestStatus: state.status,
      reason: state.reason,
      manifestVersion: state.version,
      blockCount: state.blocks.length,
      checkedAt: new Date().toISOString()
    },
    allowStructuralEdits: state.status === "ready"
  }
}
