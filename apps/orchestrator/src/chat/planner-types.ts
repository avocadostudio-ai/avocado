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

export type ThinkingEvent =
  | { type: "start" }
  | { type: "token"; text: string }
  | { type: "end"; durationMs: number }

export type CommonGeneratePlanArgs = {
  message: string
  slug: string
  currentPage: PageDoc
  contextPack: ReturnType<typeof import("../nlp/deterministic-planner.js").plannerContextPack>
  model: string
  history?: Array<{ role: "user" | "assistant"; content: string }>
  feedback?: string
  onToken?: (token: string) => void
  onThinking?: (event: ThinkingEvent) => void
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
  /**
   * True iff the planner is allowed to return needs_clarification asking the
   * user whether a new image should come from Unsplash or AI generation. Set
   * only when both sources are configured server-side AND no session-level
   * preference is in effect. See chat-pipeline.ts for the computation and
   * sectionImageSourceChoice in prompts.ts for how the rule is phrased.
   */
  imageSourceChoiceOpen?: boolean
  /** Enable extended thinking (Anthropic). Ignored by providers that don't support it. */
  thinking?: { budgetTokens: number }
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
    // OpenAI doesn't yet support Anthropic-style thinking events — drop them.
    const { onStatusUpdate: _s, onImageProgress: _i, log: _l, onThinking: _t, thinking: _th, ...rest } = args
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
  async generatePlan(args) {
    const { onThinking: _t, thinking: _th, ...rest } = args
    return generatePlanWithGemini(rest)
  },
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
