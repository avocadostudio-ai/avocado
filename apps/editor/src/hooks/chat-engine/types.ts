import type { EditorComponentsManifest, Operation } from "@ai-site-editor/shared"
import type {
  ApplyOpsResponse,
  AssistantResponse,
  PlannerBadgeState,
  SiteCapabilities,
  SiteConfig,
  VariationModalState,
  VariationOption
} from "../../lib/editor-types"

/**
 * Shared dependencies passed from the parent useChatEngine hook
 * to each extracted sub-hook via a config object.
 */
export type ChatEngineSharedDeps = {
  session: string
  siteId: string
  activeSiteConfig: SiteConfig
  slug: string
  setSlug: (slug: string) => void
  activeBlockIdRef: React.RefObject<string | undefined>
  activeBlockTypeRef: React.RefObject<string | undefined>
  activeEditablePathRef: React.RefObject<string | undefined>
  setActiveBlockId: (id: string | undefined) => void
  setActiveBlockType: (type: string | undefined) => void
  setActiveEditablePath: (path: string | undefined) => void
  postToSite: (type: "highlightBlock" | "draftUpdated" | "setNestedLabelsVisibility" | "liveDraft" | "showSkeleton" | "removeSkeleton" | "aiFieldLoading", payload: Record<string, unknown>) => void
  postPatchToSite: (op: Operation, fromVersion: number, toVersion: number, focusBlockId?: string) => void
  componentManifest?: EditorComponentsManifest | null
  siteCapabilities?: SiteCapabilities
  allowStructuralEdits: boolean
  getBlockDefaultProps?: (blockType: string) => Record<string, unknown> | null
  pushAssistantFromResult: (data: AssistantResponse, options?: { canUndo?: boolean }) => void
}

export type {
  ApplyOpsResponse,
  AssistantResponse,
  PlannerBadgeState,
  SiteCapabilities,
  VariationModalState,
  VariationOption
}
