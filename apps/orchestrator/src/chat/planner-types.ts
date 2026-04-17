import {
  generatePlanWithOpenAI,
  parseIntentWithOpenAI,
} from "./planner.js"
import {
  generatePlanWithAnthropic,
  parseIntentWithAnthropic,
} from "./anthropic-planner.js"
import {
  generatePlanWithGemini,
  parseIntentWithGemini,
} from "./gemini-planner.js"
import type { PlannerSource } from "./provider-routing.js"
import type { ParsedIntent } from "../nlp/deterministic-planner.js"
import type { EditPlan, PageDoc, BlockManifest, Operation } from "@ai-site-editor/shared"
import type { TokenUsage } from "../telemetry/usage.js"
import type { PlannerSchemaContextMeta } from "./planner.js"
import type { DeferredNativeImageCall } from "./chat-pipeline-shared.js"
import type { ToolRuntime } from "../tools/runtime.js"
import type { ToolExecutionEvent } from "../tools/types.js"

// ---------------------------------------------------------------------------
// Provider-agnostic argument shapes
// ---------------------------------------------------------------------------

export type CommonParseIntentArgs = {
  message: string
  slug: string
  currentPage: PageDoc
  activeBlockId?: string
  activeBlockType?: string
  activeEditablePath?: string
  model: string
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void }
}

export type CommonGeneratePlanArgs = {
  message: string
  slug: string
  currentPage: PageDoc
  contextPack: ReturnType<typeof import("../nlp/deterministic-planner.js").plannerContextPack>
  model: string
  history?: Array<{ role: "user" | "assistant"; content: string }>
  feedback?: string
  onToken?: (token: string) => void
  onFieldDraft?: (draft: { blockId: string; editablePath: string; value: string }) => void
  onPlannedOp?: (op: Operation, index: number) => void
  onSummaryChunk?: (text: string) => void
  onChangeLogEntry?: (entry: string) => void
  onToolExecution?: (event: ToolExecutionEvent) => void
  onStatusUpdate?: (message: string) => void
  onImageProgress?: (event: { percent: number; stage: string }) => void
  toolRuntime?: ToolRuntime
  toolCallContext?: {
    siteId: string
    sessionId: string
    userId?: string
    traceId: string
    gdriveFolderId?: string
  }
  siteContextBlock?: string | null
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void }
  forceFullSchemaContracts?: boolean
  componentsManifest?: BlockManifest
  lightweight?: boolean
  signal?: AbortSignal
  locale?: string
}

export type GeneratePlanResult = {
  plan: EditPlan
  usage: TokenUsage
  schemaContext: PlannerSchemaContextMeta
  deferredNativeImageCalls?: DeferredNativeImageCall[]
}

// ---------------------------------------------------------------------------
// Planner interface
// ---------------------------------------------------------------------------

export interface Planner {
  readonly source: PlannerSource
  /** True when the provider supports native tool use for structured output. */
  readonly supportsNativeTools: boolean
  parseIntent(args: CommonParseIntentArgs): Promise<ParsedIntent>
  generatePlan(args: CommonGeneratePlanArgs): Promise<GeneratePlanResult>
}

// ---------------------------------------------------------------------------
// Default implementations — thin adapters over existing functions.
// Each adapter strips fields the underlying provider function doesn't accept.
// ---------------------------------------------------------------------------

const openAIPlanner: Planner = {
  source: "openai",
  supportsNativeTools: false,
  async parseIntent(args) {
    const { log: _log, ...rest } = args
    return parseIntentWithOpenAI(rest)
  },
  async generatePlan(args) {
    const { onStatusUpdate: _s, onImageProgress: _i, log: _l, ...rest } = args
    return generatePlanWithOpenAI(rest)
  },
}

const anthropicPlanner: Planner = {
  source: "anthropic",
  supportsNativeTools: true,
  parseIntent: parseIntentWithAnthropic,
  generatePlan: generatePlanWithAnthropic,
}

const geminiPlanner: Planner = {
  source: "gemini",
  supportsNativeTools: true,
  parseIntent: parseIntentWithGemini,
  generatePlan: generatePlanWithGemini,
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export type PlannerRegistry = {
  get(source: PlannerSource): Planner | null
  has(source: PlannerSource): boolean
}

export function createPlannerRegistry(
  overrides?: Partial<Record<PlannerSource, Planner>>
): PlannerRegistry {
  const defaults: Partial<Record<PlannerSource, Planner>> = {
    openai: openAIPlanner,
    anthropic: anthropicPlanner,
    gemini: geminiPlanner,
  }
  const merged: Partial<Record<PlannerSource, Planner>> = { ...defaults, ...(overrides ?? {}) }
  return {
    get(source) {
      return merged[source] ?? null
    },
    has(source) {
      return merged[source] !== undefined
    },
  }
}
