import type { BlockManifest, Operation } from "@ai-site-editor/shared"
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
 * Preview bridge functions that must be passed as deps because they
 * hold a reference to the preview iframe.  These are the *only*
 * remaining dependency-injected functions after the Zustand migration.
 */
export type PreviewBridgeFns = {
  postToSite: (type: "highlightBlock" | "draftUpdated" | "setNestedLabelsVisibility" | "liveDraft" | "showSkeleton" | "removeSkeleton" | "aiFieldLoading", payload: Record<string, unknown>) => void
  postPatchToSite: (op: Operation, fromVersion: number, toVersion: number, focusBlockId?: string) => void
}

/**
 * Shared dependencies passed from the parent useChatEngine hook
 * to each extracted sub-hook via a config object.
 *
 * After the Zustand migration most fields moved to the store or
 * session singleton.  This type now holds only:
 *  - preview bridge functions (iframe-bound, can't live in store)
 *  - dynamic hook values (componentManifest, siteCapabilities, activeSiteConfig)
 */
export type ChatEngineSharedDeps = PreviewBridgeFns & {
  activeSiteConfig: SiteConfig
  componentManifest?: BlockManifest | null
  siteCapabilities?: SiteCapabilities
  allowStructuralEdits: boolean
  getBlockDefaultProps?: (blockType: string) => Record<string, unknown> | null
}

export type {
  ApplyOpsResponse,
  AssistantResponse,
  PlannerBadgeState,
  SiteCapabilities,
  VariationModalState,
  VariationOption
}
