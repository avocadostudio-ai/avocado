import type { PatchAckMessage } from "@ai-site-editor/shared"

export type ModelKey = "fast" | "balanced" | "reasoning" | "codex"
export type AIProvider = "openai" | "anthropic" | "gemini"
export type PlannerSource = "openai" | "anthropic" | "gemini" | "demo"
export type PlannerBadgeState = PlannerSource | "checking" | "error"
export type ChatExecutionMode = "auto" | "plan_only" | "apply_pending_plan" | "discard_pending_plan" | "continue_chain"

export type SiteCapabilities = {
  allowStructuralEdits: boolean
  manifestStatus: "loading" | "ready" | "degraded"
  reason?: string
  manifestVersion?: number
  blockCount?: number
  checkedAt: string
}

export type AssistantResponse = {
  status?: string
  summary?: string
  changes?: string[]
  mentionedSlugs?: string[]
  previewVersion?: number
  validationErrors?: string[] | { fieldErrors?: Record<string, string[]>; formErrors?: string[] }
  modelUsed?: string
  modelKey?: string
  plannerSource?: PlannerSource
  pendingPlanId?: string
  continuation?: {
    chainId: string
    currentStep: number
    totalSteps: number
    nextStepLabel: string
  }
  focusBlockId?: string
  updatedSlug?: string
  undoSlug?: string
  suggestions?: string[]
  debug?: {
    traceId?: string
    promptHash?: string
    promptExcerpt?: string
    outcome?: string
    reasonCategory?: string
    reason?: string
    intent?: string
    opTypes?: string[]
    opCount?: number
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cacheCreationInputTokens?: number
    cacheReadInputTokens?: number
    estimatedUsd?: number | null
    plannerTier?: string
    modelUsed?: string
    plannerSource?: string
    planningAttempts?: number
    executionMode?: string
    skippedOpCount?: number
    skippedOps?: Array<{
      index: number
      op: string
      reason: "empty_patch" | "unchanged_value"
      pageSlug?: string
      blockId?: string
    }>
    timeline?: Array<{
      stage: "request_received" | "first_token" | "first_structured_progress" | "plan_ready" | "first_op_applied" | "done"
      atMs: number
    }>
  }
  error?: string
}

export type VariationOption = {
  id: string
  title: string
  summary: string
  patch: Record<string, unknown>
  changedKeys: string[]
}

export type VariationResponse = {
  status?: string
  summary?: string
  blockId?: string
  blockType?: string
  pageSlug?: string
  baseProps?: Record<string, unknown>
  variations?: VariationOption[]
  plannerSource?: PlannerSource
  modelUsed?: string
  modelKey?: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cacheCreationInputTokens?: number
    cacheReadInputTokens?: number
    estimatedUsd?: number | null
  }
  error?: string
}

export type SiteMessage =
  | {
      protocol: "site-editor/v1"
      type:
        | "blockClicked"
        | "routeChanged"
        | "blockReordered"
        | "blockDeleteRequested"
        | "inlineTextCommitted"
        | "blockAddRequested"
        | "listItemAddRequested"
        | "listItemRemoveRequested"
        | "listItemMoveRequested"
        | "openImagePicker"
        | "editBlockRequested"
        | "iframeScrolled"
      payload: Record<string, unknown>
    }
  | ({ source: "site-editor/v1" } & PatchAckMessage)

export type FieldAiContext = {
  blockId: string
  blockType: string
  fieldPath: string
  fieldLabel: string
  blockDisplayName: string
}

export type ChatEntry = {
  id: string
  role: "user" | "assistant"
  text: string
  status?: string
  canUndo?: boolean
  wasUndone?: boolean
  undoSlug?: string
  changes?: string[]
  mentionedSlugs?: string[]
  suggestions?: string[]
  errors?: string[]
  meta?: string
  debug?: AssistantResponse["debug"]
  aiJustification?: string
  aiPerformanceNote?: string
  pendingPlanId?: string
  fieldAiContext?: FieldAiContext
  continuation?: {
    chainId: string
    currentStep: number
    totalSteps: number
    nextStepLabel: string
  }
}

export type ApplyOpsResponse = {
  status?: string
  summary?: string
  changes?: string[]
  previewVersion?: number
  focusBlockId?: string
  updatedSlug?: string
  error?: string
}

export type HistoryResponse = {
  status?: string
  previewVersion?: number
  navigateToSlug?: string
  error?: string
}

export type PublishResponse = {
  status?: string
  session?: string
  slugs?: string[]
  branch?: string
  commitSha?: string
  message?: string
  reason?: string
  details?: string[]
  deployStatus?: number
  deployResponse?: string
  inspectUrl?: string
  deploymentId?: string
  vercelState?: string
  error?: string
}

export type PublishStatus = {
  session?: string
  status?: string
  startedAt?: string
  updatedAt?: string
  slugs?: string[]
  deployStatus?: number
  inspectUrl?: string
  deploymentId?: string
  deploymentUrl?: string
  vercelState?: string
  lastCheckError?: string
}

export type VariationModalState = {
  requestText: string
  blockId: string
  blockType: string
  pageSlug: string
  baseProps: Record<string, unknown>
  options: VariationOption[]
}

export type PreviewWidthPreset = "desktop" | "tablet" | "mobile"

export type CmsMediaConfig =
  | { provider: "contentful"; spaceId: string; deliveryToken: string; environment?: string }
  | { provider: "sanity"; projectId: string; dataset?: string }
  | { provider: "strapi"; url: string; token?: string }

export type PageTemplate = {
  name: string
  description: string
}

export type SiteConfig = {
  id: string
  name: string
  purpose: string
  hosting: string
  vercelProjectId?: string
  vercelTeamId?: string
  vercelProductionUrl?: string
  vercelDeployHookUrl?: string
  tone?: string
  constraints?: string[]
  pageTemplates?: PageTemplate[]
  previewUrl?: string
  gdriveFolderId?: string
  cmsMedia?: CmsMediaConfig
}

export type RestoreSnapshot = {
  commit: string
  committedAt: string
  message: string
  pageCount: number
  homeHeading: string
}
