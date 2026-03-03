import type { PatchAckMessage } from "@ai-site-editor/shared"

export type ModelKey = "fast" | "balanced" | "reasoning" | "codex"
export type AIProvider = "openai" | "anthropic"
export type PlannerSource = "openai" | "anthropic" | "demo"
export type PlannerBadgeState = PlannerSource | "checking" | "error"
export type ChatExecutionMode = "auto" | "plan_only" | "apply_pending_plan" | "discard_pending_plan"

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
  focusBlockId?: string
  updatedSlug?: string
  suggestions?: string[]
  debug?: {
    traceId?: string
    promptHash?: string
    promptExcerpt?: string
    outcome?: string
    reasonCategory?: string
    intent?: string
    opTypes?: string[]
    opCount?: number
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
      payload: Record<string, unknown>
    }
  | ({ source: "site-editor/v1" } & PatchAckMessage)

export type ChatEntry = {
  id: string
  role: "user" | "assistant"
  text: string
  status?: string
  canUndo?: boolean
  wasUndone?: boolean
  changes?: string[]
  mentionedSlugs?: string[]
  suggestions?: string[]
  errors?: string[]
  meta?: string
  debug?: AssistantResponse["debug"]
  aiJustification?: string
  aiPerformanceNote?: string
  pendingPlanId?: string
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
}

export type RestoreSnapshot = {
  commit: string
  committedAt: string
  message: string
  pageCount: number
  homeHeading: string
}
