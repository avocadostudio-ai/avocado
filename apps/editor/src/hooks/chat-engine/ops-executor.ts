import type { Operation, BlockManifest } from "@ai-site-editor/shared"
import type { ApplyOpsResponse, AssistantResponse, SiteCapabilities } from "../../lib/editor-types"
import { manifestUnavailableChanges, withIntegrationContext } from "../../lib/integration-context"

// Shared mutation/apply primitives for useChatEngine:
// request posting, response planning, and UI synchronization.
export type SelectionSyncDeps = {
  activeBlockIdRef: { current: string | undefined }
  activeBlockTypeRef: { current: string | undefined }
  activeEditablePathRef: { current: string | undefined }
  setActiveBlockId: (id: string | undefined) => void
  setActiveBlockType: (value: string | undefined) => void
  setActiveEditablePath: (value: string | undefined) => void
}

export type OpsTransportPlan =
  | {
      kind: "patch"
      op: Operation
      fromVersion: number
      toVersion: number
      focusBlockId?: string
    }
  | {
      kind: "draft"
      focusBlockId: string | null
    }

export type ApplySyncPlan =
  | {
      ok: false
      assistant: AssistantResponse
    }
  | {
      ok: true
      focusBlockId: string | null
      transport: OpsTransportPlan
    }

export async function postOpsRequest(args: {
  orchestrator: string
  session: string
  siteId: string
  ops: Array<Record<string, unknown>>
  componentManifest?: BlockManifest | null
  siteCapabilities?: SiteCapabilities
}) {
  return await fetch(`${args.orchestrator}/ops`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      withIntegrationContext(
        {
          session: args.session,
          siteId: args.siteId,
          ops: args.ops
        },
        args.componentManifest,
        args.siteCapabilities
      )
    )
  })
}

export function handleOpsFailure(args: {
  resOk: boolean
  data: ApplyOpsResponse
  fallbackSummary: string
}): AssistantResponse | null {
  if (args.resOk && args.data.status === "applied") return null
  return {
    status: "error",
    summary: args.data.error ?? args.data.summary ?? args.fallbackSummary,
    changes: args.data.changes ?? []
  }
}

export function planApplyOpsUiSync(args: {
  resOk: boolean
  data: ApplyOpsResponse
  fallbackSummary: string
  fallbackFocusBlockId?: string
  patchTransportEnabled: boolean
  patchOp?: Operation
}): ApplySyncPlan {
  const assistant = handleOpsFailure({
    resOk: args.resOk,
    data: args.data,
    fallbackSummary: args.fallbackSummary
  })
  if (assistant) return { ok: false, assistant }

  const focusBlockId = args.data.focusBlockId ?? args.fallbackFocusBlockId ?? null
  if (args.patchTransportEnabled && typeof args.data.previewVersion === "number" && args.patchOp) {
    const toVersion = args.data.previewVersion
    return {
      ok: true,
      focusBlockId,
      transport: {
        kind: "patch",
        op: args.patchOp,
        fromVersion: toVersion - 1,
        toVersion,
        focusBlockId: focusBlockId ?? undefined
      }
    }
  }

  return {
    ok: true,
    focusBlockId,
    transport: { kind: "draft", focusBlockId }
  }
}

export function syncFocusState(args: {
  deps: SelectionSyncDeps
  focusBlockId: string | null
  blockType?: string
  editablePath?: string
  clearSelection?: boolean
  clearEditablePath?: boolean
  clearBlockType?: boolean
}) {
  const { deps } = args
  if (args.clearSelection) {
    deps.activeBlockIdRef.current = undefined
    deps.activeBlockTypeRef.current = undefined
    deps.activeEditablePathRef.current = undefined
    deps.setActiveBlockId(undefined)
    deps.setActiveBlockType(undefined)
    deps.setActiveEditablePath(undefined)
    return
  }

  if (args.focusBlockId) {
    deps.activeBlockIdRef.current = args.focusBlockId
    deps.setActiveBlockId(args.focusBlockId)
  }

  if (args.blockType !== undefined) {
    deps.activeBlockTypeRef.current = args.blockType
    deps.setActiveBlockType(args.blockType)
  } else if (args.clearBlockType) {
    deps.activeBlockTypeRef.current = undefined
    deps.setActiveBlockType(undefined)
  }

  if (args.editablePath !== undefined) {
    deps.activeEditablePathRef.current = args.editablePath
    deps.setActiveEditablePath(args.editablePath)
  } else if (args.clearEditablePath) {
    deps.activeEditablePathRef.current = undefined
    deps.setActiveEditablePath(undefined)
  }
}

export function emitPatchOrDraftUpdated(args: {
  transport: OpsTransportPlan
  postPatchToSite: (op: Operation, fromVersion: number, toVersion: number, focusBlockId?: string) => void
  postToSite: (type: "draftUpdated", payload: Record<string, unknown>) => void
}) {
  if (args.transport.kind === "patch") {
    args.postPatchToSite(args.transport.op, args.transport.fromVersion, args.transport.toVersion, args.transport.focusBlockId)
    return
  }
  args.postToSite("draftUpdated", { focusBlockId: args.transport.focusBlockId })
}

export function buildInlineEditOperation(slug: string, blockId: string, editablePath: string, value: string) {
  const indexedPath = /^([A-Za-z_][A-Za-z0-9_]*)\[([0-9]+)\]\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(editablePath)
  if (indexedPath) {
    const listKey = indexedPath[1]
    const index = Number(indexedPath[2])
    const fieldKey = indexedPath[3]
    return {
      requestOp: {
        op: "update_item",
        pageSlug: slug,
        blockId,
        listKey,
        index,
        patch: { [fieldKey!]: value }
      } as Record<string, unknown>,
      patchOp: {
        op: "update_item",
        pageSlug: slug,
        blockId,
        listKey,
        index,
        patch: { [fieldKey!]: value }
      } as Operation
    }
  }

  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(editablePath)) {
    return {
      requestOp: {
        op: "update_props",
        pageSlug: slug,
        blockId,
        patch: { [editablePath]: value }
      } as Record<string, unknown>,
      patchOp: {
        op: "update_props",
        pageSlug: slug,
        blockId,
        patch: { [editablePath]: value }
      } as Operation
    }
  }

  return null
}

export function structuralEditGuard(args: {
  allowStructuralEdits: boolean
  action: string
  reason?: string
  lastNoticeAt: number
  now: number
  cooldownMs?: number
}) {
  if (args.allowStructuralEdits) {
    return { allowed: true as const, nextLastNoticeAt: args.lastNoticeAt, notice: null }
  }

  const cooldownMs = args.cooldownMs ?? 1200
  if (args.now - args.lastNoticeAt < cooldownMs) {
    return { allowed: false as const, nextLastNoticeAt: args.lastNoticeAt, notice: null }
  }

  return {
    allowed: false as const,
    nextLastNoticeAt: args.now,
    notice: {
      status: "needs_clarification",
      summary: `Cannot ${args.action} because structural editing is currently disabled.`,
      changes: manifestUnavailableChanges(args.reason?.trim())
    } satisfies AssistantResponse
  }
}
