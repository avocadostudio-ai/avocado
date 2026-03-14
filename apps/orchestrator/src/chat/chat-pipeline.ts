import { randomUUID } from "node:crypto"
import type { FastifyBaseLogger } from "fastify"
import {
  editorComponentsManifestSchema,
  type EditPlan,
  type EditorComponentsManifest,
  type Operation,
  type PageDoc
} from "@ai-site-editor/shared"
import {
  type ChatRequestBody,
  type ChatResult,
  siteCapabilitiesSchema,
  isBatchAddRequest,
  isBlockCatalogQuery,
  isInfoQuery,
  isPageListQuery,
  plannerMessageWithPendingContext,
  buildSiteContextBlock,
  infoResponse
} from "../nlp/intent-detection.js"
import type { createChatTelemetryStore } from "../telemetry/chat-telemetry.js"
import {
  type AIProvider,
  type ModelKey,
  type ContinuationChain,
  type PendingImageGeneration,
  versions,
  pendingClarificationBySession,
  chatHistoryBySession,
  pendingApprovalPlanBySession,
  continuationChainBySession,
  orderSlugsHomeFirst,
  getSessionDraft,
  getPage,
  setPage,
  pushUndo,
  bumpVersion,
  pushRecentEdit,
  pushChatHistory,
  schedulePersistState
} from "../state/session-state.js"
import {
  toErrorDetail,
  isNoEffectiveChangeError,
  classifyGuardrailError,
  formatValidationError,
  isDeterministicRepairEligible,
  buildDeterministicRepairFeedback,
  type SkippedOperation,
  validateOperations,
  applyOpsAtomically,
  isStructuralOperation,
  pickFocusBlockId,
  pickUpdatedSlug
} from "../ops/ops-engine.js"
import {
  clarificationSuggestions,
  postEditSuggestions,
  demoPlanFromMessage,
  plannerContextPack,
  compileDeterministicPlan,
  inferDeterministicIntent,
  isHighConfidenceDeterministicCase
} from "../nlp/deterministic-planner.js"
import { generatePlanWithOpenAI, isPlannerOutputError, isStrictJsonResponseEnabled, parseIntentWithOpenAI } from "./planner.js"
import {
  CancelError as _CancelError,
  isCancelError as _isCancelError
} from "../errors.js"
import { isMultiStepCandidate, decomposeRequest } from "./decomposer.js"
import { generatePlanWithAnthropic, parseIntentWithAnthropic } from "./anthropic-planner.js"
import { type TokenUsage, estimateUsd } from "../telemetry/usage.js"
import type { ToolRuntime } from "../tools/runtime.js"

// ---------------------------------------------------------------------------
// Re-exports from extracted modules (for backwards compat with external importers)
// ---------------------------------------------------------------------------
export { sentenceCase, firstUrlFromText, preferredImageAltText, collectMentionedSlugsFromPlan, collectMentionedSlugsFromOps, normalizePlanCopyForUi, futureToPastTense } from "./chat-pipeline-ui.js"
export { sanitizeMessageForPlanning, inferTranslationScopeFromMessage, isNonEmptyString, findFullPageTranslationCoverageGap, type TranslationScope } from "./chat-pipeline-translation.js"
export { shouldPreferFastModelForMessage, shouldUseLlmIntentRouter, compactPlannerContextPack, minimalPlannerContextPack, shouldUseMinimalPlannerContext, shouldPreferFocusedTranslation } from "./chat-pipeline-context.js"
export { isRewriteLikeMessage, isPerformanceAwareMessage, isLikelyTextField, collectChangedTextFields, buildMetaChangeLogEntries, buildAiInsightChanges, deterministicCreatePagePlan, deterministicDuplicatePagePlan, deterministicSelectedTextRewritePlan, shouldReturnDeterministicClarification } from "./chat-pipeline-deterministic.js"
export { blockHasImageUrlProp, parsePath, getValueAtPath, setValueAtPath, deleteValueAtPath, extractIndexedQueries, extractReferencedItemIndices, blockSupportsImageAtPath, detectImagePaths, imageQueryFromItem, shouldPopulateAllChildImages, findImageTargets, rewriteAddBlockToChildImageUpdate, withUnsplashHeroImage, shouldResolveCreatePageHeroImage, resolveHeroImageForCreatePage, detectImageOps } from "./chat-pipeline-image.js"

// Internal imports from extracted modules (used by this file)
import { collectMentionedSlugsFromPlan, normalizePlanCopyForUi, futureToPastTense } from "./chat-pipeline-ui.js"
import { sanitizeMessageForPlanning, inferTranslationScopeFromMessage, normalizeVariationTypos, findFullPageTranslationCoverageGap, type TranslationScope } from "./chat-pipeline-translation.js"
import { shouldPreferFastModelForMessage, shouldUseLlmIntentRouter, compactPlannerContextPack, minimalPlannerContextPack, shouldUseMinimalPlannerContext, shouldPreferFocusedTranslation } from "./chat-pipeline-context.js"
import { buildAiInsightChanges, buildMetaChangeLogEntries, deterministicCreatePagePlan, deterministicDuplicatePagePlan, deterministicSelectedTextRewritePlan, shouldReturnDeterministicClarification } from "./chat-pipeline-deterministic.js"
import { getValueAtPath, setValueAtPath, deleteValueAtPath, blockSupportsImageAtPath, detectImageOps, rewriteAddBlockToChildImageUpdate, withUnsplashHeroImage, resolveHeroImageForCreatePage } from "./chat-pipeline-image.js"

let generatePlanWithOpenAIImpl = generatePlanWithOpenAI
export function setGeneratePlanWithOpenAIForTests(fn?: typeof generatePlanWithOpenAI) {
  generatePlanWithOpenAIImpl = fn ?? generatePlanWithOpenAI
}

let generatePlanWithAnthropicImpl = generatePlanWithAnthropic
export function setGeneratePlanWithAnthropicForTests(fn?: typeof generatePlanWithAnthropic) {
  generatePlanWithAnthropicImpl = fn ?? generatePlanWithAnthropic
}

let demoPlanFromMessageImpl = demoPlanFromMessage
export function setDemoPlanFromMessageForTests(fn?: typeof demoPlanFromMessage) {
  demoPlanFromMessageImpl = fn ?? demoPlanFromMessage
}

let parseIntentWithOpenAIImpl = parseIntentWithOpenAI
export function setParseIntentWithOpenAIForTests(fn?: typeof parseIntentWithOpenAI) {
  parseIntentWithOpenAIImpl = fn ?? parseIntentWithOpenAI
}

let parseIntentWithAnthropicImpl = parseIntentWithAnthropic
export function setParseIntentWithAnthropicForTests(fn?: typeof parseIntentWithAnthropic) {
  parseIntentWithAnthropicImpl = fn ?? parseIntentWithAnthropic
}

// ---------------------------------------------------------------------------
// Pipeline context
// ---------------------------------------------------------------------------

export type ChatPipelineContext = {
  log: FastifyBaseLogger
  chatTelemetry: ReturnType<typeof createChatTelemetryStore>
  modelLookup: Record<AIProvider, Record<ModelKey, string>>
  availableProviders: AIProvider[]
  toolRuntime: ToolRuntime
}

// ---------------------------------------------------------------------------
// Deferred image placeholder
// ---------------------------------------------------------------------------

/**
 * Data URI SVG with SMIL shimmer animation and "Generating image..." text.
 * Used as a Hero's `imageUrl` while the real image is being generated.
 */
export const GENERATING_IMAGE_PLACEHOLDER = [
  `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 600'%3E`,
  `%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='0'%3E`,
  `%3Cstop offset='0%25' stop-color='%23e2e8f0'/%3E`,
  `%3Cstop offset='50%25' stop-color='%23f1f5f9'%3E%3Canimate attributeName='offset' values='0;1;0' dur='2s' repeatCount='indefinite'/%3E%3C/stop%3E`,
  `%3Cstop offset='100%25' stop-color='%23e2e8f0'/%3E`,
  `%3C/linearGradient%3E%3C/defs%3E`,
  `%3Crect width='1200' height='600' fill='url(%23g)'/%3E`,
  // AI sparkle — classic 4-point diamond star, positioned just left of the text
  `%3Cg transform='translate(448,296)' fill='%2394a3b8'%3E`,
  // Main sparkle: thin 4-point star (tall + narrow = classic AI look)
  `%3Cpath d='M0-12C1 -4 4-1 12 0 4 1 1 4 0 12-1 4-4 1-12 0-4-1-1-4 0-12Z'%3E`,
  `%3Canimate attributeName='opacity' values='0.5;1;0.5' dur='2s' repeatCount='indefinite'/%3E`,
  `%3C/path%3E`,
  // Small companion sparkle — offset top-right
  `%3Cpath d='M11-9C11.4-7 12.6-5.8 15-5.5 12.6-5.2 11.4-4 11-2 10.6-4 9.4-5.2 7-5.5 9.4-5.8 10.6-7 11-9Z' opacity='0.6'%3E`,
  `%3Canimate attributeName='opacity' values='0.3;0.8;0.3' dur='1.6s' repeatCount='indefinite'/%3E`,
  `%3C/path%3E`,
  `%3C/g%3E`,
  // "Generating image..." — large centered text (nudged right to balance sparkle)
  `%3Ctext x='616' y='310' text-anchor='middle' fill='%2394a3b8' font-family='system-ui' font-size='36' font-weight='500'%3EGenerating image%E2%80%A6%3C/text%3E`,
  `%3C/svg%3E`
].join("")

/** Returns true if the URL is the shimmer placeholder used during deferred image generation. */
export function isGeneratingPlaceholder(url: string): boolean {
  return url.startsWith("data:image/svg+xml,") && url.includes("Generating%20image")
}

/** Remove any "Generating image..." SVG placeholders left in session state (e.g. after cancel). */
export function cleanupImagePlaceholders(session: string) {
  const draft = getSessionDraft(session)
  for (const [, page] of draft) {
    for (const block of page.blocks) {
      const props = block.props as Record<string, unknown>
      if (typeof props.imageUrl === "string" && isGeneratingPlaceholder(props.imageUrl)) {
        props.imageUrl = ""
      }
    }
  }
}

/** Metadata for a deferred create_page Hero image that still needs resolution. */
export type DeferredCreatePageImage = {
  pageSlug: string
  blockId: string
  query: string
  pageTitle: string
  sectionContext: string
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Build a compact page directory from the session draft for the system prompt. */
function buildPageDirectory(session: string): string {
  const draft = getSessionDraft(session)
  if (draft.size === 0) return ""
  const slugs = orderSlugsHomeFirst(Array.from(draft.keys()))
  return slugs
    .map((slug) => {
      const page = draft.get(slug)!
      const blockTypes = page.blocks.map((b) => b.type).join(", ")
      return `  ${slug} "${page.title}" (${blockTypes})`
    })
    .join("\n")
}

function isVariationRequestMessage(message: string) {
  const normalized = normalizeVariationTypos(message.toLowerCase())
  return (
    /\bvariations?\b/.test(normalized) &&
    /\b(generate|create|make|show|give|produce|draft)\b/.test(normalized)
  )
}

// ---------------------------------------------------------------------------
// Effective slug resolution
// ---------------------------------------------------------------------------

export function resolveEffectiveSlug(args: { session: string; requestedSlug: string; activeBlockId?: string }) {
  const { session, requestedSlug, activeBlockId } = args
  if (!activeBlockId) return requestedSlug
  const current = getPage(session, requestedSlug)
  if (current?.blocks.some((block) => block.id === activeBlockId)) return requestedSlug
  const draft = getSessionDraft(session)
  for (const [slug, page] of draft) {
    if (page.blocks.some((block) => block.id === activeBlockId)) return slug
  }
  return requestedSlug
}

// ---------------------------------------------------------------------------
// Cancel error — re-exported from errors.ts for backward compatibility
// ---------------------------------------------------------------------------

export const CancelError = _CancelError
export const isCancelError = _isCancelError

export function throwIfCanceled(signal?: AbortSignal) {
  if (signal?.aborted) throw new _CancelError(signal.reason as string ?? "user_canceled")
}

/** Race a promise against an abort signal. Rejects with CancelError if signal fires first. */
export function raceCancel<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new _CancelError(signal.reason as string ?? "user_canceled"))
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new _CancelError(signal.reason as string ?? "user_canceled")), { once: true })
    })
  ])
}

// ---------------------------------------------------------------------------
// SSE write helper
// ---------------------------------------------------------------------------

export function sseWrite(reply: { raw: NodeJS.WritableStream }, payload: unknown) {
  const stream = reply.raw as NodeJS.WritableStream & {
    destroyed?: boolean
    writableEnded?: boolean
    writable?: boolean
  }
  if (stream.destroyed || stream.writableEnded === true || stream.writable === false) return
  try {
    stream.write(`data: ${JSON.stringify(payload)}\n\n`)
  } catch {
    // Client disconnected; ignore write errors for SSE.
  }
}

function sleepMs(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return Promise.resolve()
  return new Promise<void>((resolve) => setTimeout(resolve, durationMs))
}

// ---------------------------------------------------------------------------
// Main chat pipeline
// ---------------------------------------------------------------------------

export async function runChatPipeline(
  ctx: ChatPipelineContext,
  body: ChatRequestBody,
  options?: {
    onPlanningToken?: (token: string) => void
    onPlannedOp?: (event: { index: number; op: Operation }) => void
    onSummaryChunk?: (text: string) => void
    onChangeLogEntry?: (entry: string) => void
    onOpApplied?: (event: { index: number; total: number; op: Operation; previewVersion: number; focusBlockId?: string; updatedSlug?: string }) => void
    onOpSkipped?: (event: { index: number; total: number; op: Operation; reason: SkippedOperation["reason"] }) => void
    onStatusUpdate?: (message: string) => void
    onImageProgress?: (event: { percent: number; stage: string }) => void
    onPlanMeta?: (event: { intent: EditPlan["intent"]; summary: string; estimatedOps: number }) => void
    onRollbackStarted?: (event: { appliedCount: number; reason: string }) => void
    onRollbackDone?: (event: { restoredVersion: number }) => void
    signal?: AbortSignal
  }
): Promise<{ code: number; payload: ChatResult | { error: string } }> {
  let executionMode = body.executionMode ?? "auto"
  const requiresMessage = executionMode === "auto" || executionMode === "plan_only"
  if (!body.session || !body.slug || (requiresMessage && !body.message)) {
    return { code: 400, payload: { error: "session and slug are required; message is required for planning" } }
  }
  const manifestPayload = (() => {
    if (!body.componentsManifest) return undefined
    if (typeof body.componentsManifest !== "string") return body.componentsManifest
    try {
      return JSON.parse(body.componentsManifest) as unknown
    } catch {
      return "__invalid_json__"
    }
  })()
  const parsedManifest =
    manifestPayload === "__invalid_json__"
      ? { success: false as const }
      : manifestPayload
        ? editorComponentsManifestSchema.safeParse(manifestPayload)
        : { success: true as const, data: undefined }
  if (!parsedManifest.success) {
    return { code: 400, payload: { error: "invalid componentsManifest payload" } }
  }
  const componentsManifest: EditorComponentsManifest | undefined = parsedManifest.data
  const capabilitiesPayload = (() => {
    if (!body.siteCapabilities) return undefined
    if (typeof body.siteCapabilities !== "string") return body.siteCapabilities
    try {
      return JSON.parse(body.siteCapabilities) as unknown
    } catch {
      return "__invalid_json__"
    }
  })()
  const parsedCapabilities =
    capabilitiesPayload === "__invalid_json__"
      ? { success: false as const }
      : capabilitiesPayload
        ? siteCapabilitiesSchema.safeParse(capabilitiesPayload)
        : { success: true as const, data: undefined }
  if (!parsedCapabilities.success) {
    return { code: 400, payload: { error: "invalid siteCapabilities payload" } }
  }
  const siteCapabilities = parsedCapabilities.data
  if (executionMode === "discard_pending_plan") {
    const existing = pendingApprovalPlanBySession.get(body.session)
    if (!existing) {
      const defaultProvider: AIProvider = ctx.availableProviders[0] ?? "openai"
      const defaultModelKey: ModelKey = (process.env.OPENAI_MODEL_KEY as ModelKey | undefined) ?? "balanced"
      return {
        code: 200,
        payload: {
          status: "canceled",
          summary: "No pending plan to stop.",
          changes: [],
          previewVersion: versions.get(body.session) ?? 0,
          plannerSource: ctx.availableProviders.length > 0 ? ctx.availableProviders[0] : "demo",
          modelUsed: ctx.modelLookup[defaultProvider][defaultModelKey],
          modelKey: defaultModelKey
        }
      }
    }
    if (body.pendingPlanId && body.pendingPlanId !== existing.id) {
      return { code: 409, payload: { error: "pending plan mismatch" } }
    }
    pendingApprovalPlanBySession.delete(body.session)
    return {
      code: 200,
      payload: {
        status: "canceled",
        summary: "Stopped. The pending plan was discarded and will not be executed.",
        changes: [],
        previewVersion: versions.get(body.session) ?? 0,
        plannerSource: existing.source,
        modelUsed: existing.modelUsed,
        modelKey: existing.modelKey
      }
    }
  }

  if (executionMode === "continue_chain") {
    const chain = continuationChainBySession.get(body.session)
    if (!chain) {
      return { code: 409, payload: { error: "no continuation chain found for this session" } }
    }
    if (body.continuationChainId && body.continuationChainId !== chain.id) {
      return { code: 409, payload: { error: "continuation chain id mismatch" } }
    }
    if (chain.currentStep >= chain.totalSteps) {
      continuationChainBySession.delete(body.session)
      return { code: 409, payload: { error: "continuation chain already completed" } }
    }
    // Execute the next step as a normal chat message
    throwIfCanceled(options?.signal)
    const stepMessage = chain.steps[chain.currentStep]
    chain.currentStep++
    const isLastStep = chain.currentStep >= chain.totalSteps

    const result = await runChatPipeline(ctx, {
      ...body,
      message: stepMessage,
      slug: chain.effectiveSlug,
      executionMode: "auto"
    }, options)

    // Attach continuation info if more steps remain
    if (!isLastStep && result.code === 200 && "status" in result.payload && result.payload.status !== "error") {
      const payload = result.payload as ChatResult
      payload.continuation = {
        chainId: chain.id,
        currentStep: chain.currentStep + 1,
        totalSteps: chain.totalSteps,
        nextStepLabel: chain.stepLabels[chain.currentStep]
      }
    }

    if (isLastStep) {
      continuationChainBySession.delete(body.session)
    }

    return result
  }

  const sanitizedMessage = sanitizeMessageForPlanning(body.message ?? "")
  const pageDirectory = buildPageDirectory(body.session)
  const siteContextBlock = buildSiteContextBlock({
    sitePurpose: body.sitePurpose,
    siteHosting: body.siteHosting,
    businessContext: body.businessContext,
    siteContext: body.siteContext,
    pageDirectory: pageDirectory || undefined
  })
  // Site context is now passed to the LLM system prompt (cacheable) instead of the user message.
  const plannerMessage = plannerMessageWithPendingContext(body.session, sanitizedMessage)
  const inferredTranslationScope = inferTranslationScopeFromMessage(plannerMessage)
  const translationScope = shouldPreferFocusedTranslation({
    message: plannerMessage,
    inferredScope: inferredTranslationScope,
    activeBlockId: body.activeBlockId
  })
    ? "component"
    : inferredTranslationScope
  const planningActiveBlockId = translationScope === "page" ? undefined : body.activeBlockId
  const planningActiveEditablePath = translationScope === "page" ? undefined : body.activeEditablePath
  const sessionChatHistory = chatHistoryBySession.get(body.session) ?? []
  const chatRequestId = randomUUID()
  const requestedSlug = body.slug
  const effectiveSlug = resolveEffectiveSlug({
    session: body.session,
    requestedSlug,
    activeBlockId: planningActiveBlockId
  })
  ctx.log.info(
    {
      event: "chat_pipeline_start",
      chatRequestId,
      session: body.session,
      requestedSlug,
      effectiveSlug,
      activeBlockId: planningActiveBlockId,
      activeEditablePath: planningActiveEditablePath,
      message: body.message
    },
    "Chat pipeline request received"
  )

  const requestedProvider = body.provider ?? (ctx.availableProviders[0] as AIProvider | undefined)
  const provider: AIProvider = (() => {
    if (requestedProvider && ctx.availableProviders.includes(requestedProvider)) return requestedProvider
    // Prefer Anthropic by default when available (user can always override via UI/provider param).
    if (!body.provider && ctx.availableProviders.includes("anthropic") && process.env.ANTHROPIC_API_KEY) return "anthropic"
    if (!body.provider && ctx.availableProviders.includes("openai") && process.env.OPENAI_API_KEY) return "openai"
    return ctx.availableProviders[0] ?? "openai"
  })()
  const baseModelKey =
    body.modelKey && ctx.modelLookup[provider][body.modelKey]
      ? body.modelKey
      : (process.env.OPENAI_MODEL_KEY as ModelKey | undefined) ?? "balanced"
  const modelKey =
    !body.modelKey &&
    baseModelKey !== "fast" &&
    ctx.modelLookup[provider].fast &&
    shouldPreferFastModelForMessage(plannerMessage)
      ? ("fast" as const)
      : baseModelKey
  const modelUsed = ctx.modelLookup[provider][modelKey]
  const plannerSource: "openai" | "anthropic" | "demo" =
    provider === "anthropic" && process.env.ANTHROPIC_API_KEY ? "anthropic" :
    provider === "openai" && process.env.OPENAI_API_KEY ? "openai" :
    process.env.OPENAI_API_KEY ? "openai" :
    process.env.ANTHROPIC_API_KEY ? "anthropic" : "demo"
  const promptHash = ctx.chatTelemetry.promptHash(plannerMessage)
  const promptExcerpt = ctx.chatTelemetry.promptExcerpt(plannerMessage)
  const pipelineStartedAtMs = Date.now()
  const stageTimeline: Array<{
    stage: "request_received" | "first_token" | "first_structured_progress" | "plan_ready" | "first_op_applied" | "done"
    atMs: number
  }> = []
  let planningStartedAtMs: number | null = null
  let planningFinishedAtMs: number | null = null
  let firstPlanningTokenMs: number | null = null
  let planningAttempts = 0
  let imageResolutionDurationMs = 0
  let applyDurationMs: number | undefined
  let firstApplyMs: number | null = null
  let doneStageMarked = false

  const markPlanningStart = () => {
    if (planningStartedAtMs === null) planningStartedAtMs = Date.now()
  }

  const markPlanningFinish = () => {
    planningFinishedAtMs = Date.now()
  }

  const onPlanningToken = (token: string) => {
    if (firstPlanningTokenMs === null) {
      firstPlanningTokenMs = Date.now() - pipelineStartedAtMs
      emitStatus("Generating plan...")
      if (!stageTimeline.some((item) => item.stage === "first_token")) {
        stageTimeline.push({ stage: "first_token", atMs: firstPlanningTokenMs })
      }
      ctx.chatTelemetry.push({
        id: chatRequestId,
        at: new Date().toISOString(),
        phase: "milestone",
        timelineStage: "first_token",
        session: body.session!,
        requestedSlug,
        effectiveSlug,
        plannerSource,
        modelKey,
        modelUsed,
        promptHash,
        promptExcerpt,
        promptLength: plannerMessage.length,
        totalDurationMs: firstPlanningTokenMs
      })
    }
    options?.onPlanningToken?.(token)
  }

  const markFirstStructuredProgress = () => {
    if (stageTimeline.some((item) => item.stage === "first_structured_progress")) return
    const atMs = Date.now() - pipelineStartedAtMs
    stageTimeline.push({ stage: "first_structured_progress", atMs })
    ctx.chatTelemetry.push({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "milestone",
      timelineStage: "first_structured_progress",
      session: body.session!,
      requestedSlug,
      effectiveSlug,
      plannerSource,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      totalDurationMs: atMs
    })
  }

  const emitStatus = (message: string) => {
    options?.onStatusUpdate?.(message)
    ctx.log.info(
      {
        event: "chat_pipeline_status",
        chatRequestId,
        session: body.session,
        message,
        elapsedMs: Date.now() - pipelineStartedAtMs
      },
      "Chat pipeline status update"
    )
  }

  const planningDurationMs = () =>
    planningStartedAtMs !== null && planningFinishedAtMs !== null
      ? Math.max(0, planningFinishedAtMs - planningStartedAtMs)
      : undefined
  const timingFields = () => ({
    totalDurationMs: Date.now() - pipelineStartedAtMs,
    planningDurationMs: planningDurationMs(),
    firstPlanningTokenMs: firstPlanningTokenMs ?? undefined,
    applyDurationMs,
    imageResolutionDurationMs: imageResolutionDurationMs > 0 ? imageResolutionDurationMs : undefined,
    planningAttempts: planningAttempts > 0 ? planningAttempts : undefined
  })
  const incrementalApplyEnabled = !/^(0|false|no|off)$/i.test((process.env.CHAT_INCREMENTAL_APPLY ?? "1").trim())
  const streamedApplyMinStepMsRaw = Number(process.env.CHAT_STREAM_APPLY_MIN_STEP_MS ?? 260)
  const streamedApplyMinStepMs =
    Number.isFinite(streamedApplyMinStepMsRaw) && streamedApplyMinStepMsRaw > 0
      ? Math.min(Math.max(Math.trunc(streamedApplyMinStepMsRaw), 1), 2000)
      : 0
  const incrementalPlanStreamEnabled = !/^(0|false|no|off)$/i.test((process.env.CHAT_INCREMENTAL_PLAN_STREAM ?? "1").trim())
  const withDebugPayload = (
    payload: ChatResult,
    extra?: Partial<NonNullable<ChatResult["debug"]>>
  ): ChatResult => ({
    ...payload,
    debug: {
      traceId: chatRequestId,
      promptHash,
      promptExcerpt,
      timeline: (() => {
        if (!doneStageMarked) {
          doneStageMarked = true
          const doneAtMs = Date.now() - pipelineStartedAtMs
          stageTimeline.push({ stage: "done", atMs: doneAtMs })
          ctx.chatTelemetry.push({
            id: chatRequestId,
            at: new Date().toISOString(),
            phase: "milestone",
            timelineStage: "done",
            session: body.session!,
            requestedSlug,
            effectiveSlug,
            plannerSource,
            modelKey,
            modelUsed,
            promptHash,
            promptExcerpt,
            promptLength: plannerMessage.length,
            totalDurationMs: doneAtMs
          })
        }
        return stageTimeline.slice()
      })(),
      ...(payload.debug ?? {}),
      ...(extra ?? {})
    }
  })
  stageTimeline.push({ stage: "request_received", atMs: 0 })
  ctx.chatTelemetry.push({
    id: chatRequestId,
    at: new Date().toISOString(),
    phase: "received",
    session: body.session,
    requestedSlug,
    effectiveSlug,
    plannerSource,
    modelKey,
    modelUsed,
    promptHash,
    promptExcerpt,
    promptLength: plannerMessage.length
  })
  ctx.chatTelemetry.push({
    id: chatRequestId,
    at: new Date().toISOString(),
    phase: "milestone",
    timelineStage: "request_received",
    session: body.session,
    requestedSlug,
    effectiveSlug,
    plannerSource,
    modelKey,
    modelUsed,
    promptHash,
    promptExcerpt,
    promptLength: plannerMessage.length,
    totalDurationMs: 0
  })

  if (executionMode === "auto") {
    const existingPendingPlan = pendingApprovalPlanBySession.get(body.session)
    const normalizedIncomingMessage = typeof body.message === "string" ? body.message.trim() : ""
    const normalizedPendingMessage = typeof existingPendingPlan?.originalMessage === "string"
      ? existingPendingPlan.originalMessage.trim()
      : ""
    const replayedPendingPrompt = Boolean(
      existingPendingPlan &&
      (
        existingPendingPlan.promptHash === promptHash ||
        (normalizedIncomingMessage.length > 0 && normalizedPendingMessage.length > 0 && normalizedIncomingMessage === normalizedPendingMessage)
      )
    )
    if (replayedPendingPrompt) {
      executionMode = "apply_pending_plan"
      body.pendingPlanId = body.pendingPlanId ?? existingPendingPlan?.id
    }
  }

  const current = getPage(body.session, effectiveSlug)
  if (!current) return { code: 404, payload: { error: "page not found" } }

  if (body.message && isInfoQuery(body.message) && !isBatchAddRequest(body.message)) {
    const info = infoResponse({ body, current, plannerSource, modelUsed, modelKey })
    return { code: info.code, payload: withDebugPayload(info.payload, { outcome: "info" }) }
  }
  if (body.message && isPageListQuery(body.message)) {
    const directory = buildPageDirectory(body.session)
    const draft = getSessionDraft(body.session)
    const pageCount = draft.size
    return {
      code: 200,
      payload: withDebugPayload({
        status: "info",
        summary: `This site has ${pageCount} page${pageCount === 1 ? "" : "s"}:`,
        changes: directory ? directory.split("\n").map((l) => l.trim()) : ["No pages found."],
        suggestions: [
          "Add a new page",
          "Delete a page",
          "Rename a page",
          "Reorder pages"
        ],
        previewVersion: versions.get(body.session) ?? 0,
        plannerSource,
        modelUsed,
        modelKey
      } satisfies ChatResult, { outcome: "info" })
    }
  }
  if (body.message && isVariationRequestMessage(body.message)) {
    const suggestions = [
      "Use the Variations action after selecting the target block.",
      "Example: select Hero, then generate 4 variations."
    ]
    pendingClarificationBySession.set(body.session, { baseRequest: plannerMessage, updatedAt: new Date().toISOString() })
    return {
      code: 200,
      payload: withDebugPayload({
        status: "needs_clarification",
        summary: "Variation requests are handled in block variations mode.",
        changes: [],
        suggestions,
        previewVersion: versions.get(body.session) ?? 0,
        plannerSource,
        modelUsed,
        modelKey
      } satisfies ChatResult, { outcome: "variation_request_redirect", reasonCategory: "ambiguity" })
    }
  }

  emitStatus("Analyzing your request...")

  const contextPack = plannerContextPack({
    session: body.session,
    slug: effectiveSlug,
    message: plannerMessage,
    currentPage: current,
    activeBlockId: planningActiveBlockId,
    activeBlockType: body.activeBlockType,
    activeEditablePath: planningActiveEditablePath,
    includeFullProps: translationScope === "page"
  })
  const compactContextExperimentEnabled = /^(1|true|yes|on)$/i.test((process.env.CHAT_COMPACT_CONTEXT_EXPERIMENT ?? "").trim())
  const minimalContextExperimentEnabled = /^(1|true|yes|on)$/i.test((process.env.CHAT_MINIMAL_CONTEXT_EXPERIMENT ?? "").trim())
  const basePlannerContext =
    compactContextExperimentEnabled
      ? compactPlannerContextPack({ contextPack, message: plannerMessage, translationScope })
      : contextPack
  const useMinimalPlannerContext = minimalContextExperimentEnabled && shouldUseMinimalPlannerContext({
    message: plannerMessage,
    translationScope,
    activeBlockId: planningActiveBlockId,
    activeEditablePath: planningActiveEditablePath
  })
  const plannerContext =
    useMinimalPlannerContext
      ? minimalPlannerContextPack({ contextPack: basePlannerContext })
      : basePlannerContext
  const contextPackBytes = (() => {
    try {
      return Buffer.byteLength(JSON.stringify(plannerContext), "utf8")
    } catch {
      return undefined
    }
  })()
  const plannerContextTelemetryFields: Record<string, unknown> = {
    ...(typeof contextPackBytes === "number" ? { contextPackBytes } : {}),
    compactContextEnabled: compactContextExperimentEnabled,
    minimalContextEnabled: useMinimalPlannerContext,
    strictJsonEnabled: isStrictJsonResponseEnabled()
  }

  const guardrailFailureResponse = (args: { reason: string; source: "openai" | "anthropic" | "demo" }) => {
    const category = classifyGuardrailError(args.reason)
    ctx.chatTelemetry.push({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "result",
      session: body.session!,
      requestedSlug,
      effectiveSlug,
      plannerSource: args.source,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      outcome: "guardrail_failure",
      reason: args.reason.slice(0, 300),
      reasonCategory: category,
      ...plannerContextTelemetryFields,
      ...timingFields()
    })
    if (category === "ambiguity") {
      const selected =
        planningActiveBlockId && current.blocks.find((b) => b.id === planningActiveBlockId)
          ? current.blocks.find((b) => b.id === planningActiveBlockId)
          : null
      return {
        code: 200,
        payload: withDebugPayload({
          status: "needs_clarification",
          summary: "I need one more detail before applying this safely.",
          changes: [],
          mentionedSlugs: [effectiveSlug],
          suggestions: clarificationSuggestions({ body, current, selected }),
          previewVersion: versions.get(body.session!) ?? 0,
          plannerSource: args.source,
          modelUsed,
          modelKey
        } satisfies ChatResult, { outcome: "needs_clarification", reasonCategory: category })
      }
    }
    return {
      code: 400,
      payload: withDebugPayload({
        status: "validation_error",
        summary: "I could not apply that change safely.",
        changes: [],
        validationErrors: [formatValidationError(args.reason)],
        previewVersion: versions.get(body.session!) ?? 0,
        plannerSource: args.source,
        modelUsed,
        modelKey
      } satisfies ChatResult, { outcome: "validation_error", reasonCategory: category })
    }
  }

  let planUsage: TokenUsage | undefined
  let usedNativeUnsplashTool = false
  let usedNativeImageTool = false

  const respondFromPlan = async (
    plan: EditPlan,
    source: "openai" | "anthropic" | "demo",
    applyMode: "apply_now" | "plan_only" = "apply_now",
    optionsOverride?: { preResolvedPlan?: boolean },
    plannerTier?: "forced_deterministic" | "deterministic" | "llm_intent_router" | "full_llm" | "demo"
  ) => {
    const usageFields = planUsage ? {
      inputTokens: planUsage.inputTokens,
      outputTokens: planUsage.outputTokens,
      totalTokens: planUsage.totalTokens,
      ...(typeof planUsage.cacheCreationInputTokens === "number"
        ? { cacheCreationInputTokens: planUsage.cacheCreationInputTokens }
        : {}),
      ...(typeof planUsage.cacheReadInputTokens === "number"
        ? { cacheReadInputTokens: planUsage.cacheReadInputTokens }
        : {}),
      estimatedUsd: estimateUsd(modelUsed, planUsage)
    } : {}
    ctx.chatTelemetry.push({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "plan_generated",
      session: body.session!,
      requestedSlug,
      effectiveSlug,
      plannerSource: source,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      intent: plan.intent,
      opCount: plan.ops.length,
      opTypes: plan.ops.map((op) => op.op),
      plannerTier,
      ...plannerContextTelemetryFields,
      ...usageFields,
      ...timingFields()
    })
    let resolvedPlan = plan
    let detectedImageOps: PendingImageGeneration[] = []
    let effectiveApplyMode = applyMode
    if (!optionsOverride?.preResolvedPlan) {
      resolvedPlan = normalizePlanCopyForUi(plan, current)
      resolvedPlan = rewriteAddBlockToChildImageUpdate({
        plan: resolvedPlan,
        message: plannerMessage,
        currentPage: current,
        slug: effectiveSlug
      })

      // Detect image ops synchronously before making any API calls
      detectedImageOps = detectImageOps({
        plan: resolvedPlan,
        message: plannerMessage,
        slug: effectiveSlug,
        currentPage: current,
        activeBlockId: planningActiveBlockId,
        activeEditablePath: planningActiveEditablePath
      })

      // Filter out image ops targeting blocks whose schema doesn't support imageUrl
      if (detectedImageOps.length > 0) {
        const unsupportedBlocks = new Set<string>()
        const unsupportedImagePaths: Array<{ blockId: string; pageSlug: string; path: string; altPath?: string }> = []
        detectedImageOps = detectedImageOps.filter((imgOp) => {
          const block = current.blocks.find((b) => b.id === imgOp.blockId)
          if (!block) return true
          const path = imgOp.path || "imageUrl"
          if (blockSupportsImageAtPath(block.type, path)) return true
          unsupportedBlocks.add(block.type)
          unsupportedImagePaths.push({ blockId: imgOp.blockId, pageSlug: imgOp.pageSlug, path, altPath: imgOp.altPath })
          return false
        })
        // Strip unsupported imageUrl values from ops patches so they don't leak through
        for (const removed of unsupportedImagePaths) {
          const op = resolvedPlan.ops.find((o) => o.op === "update_props" && o.blockId === removed.blockId && o.pageSlug === removed.pageSlug)
          if (!op || op.op !== "update_props") continue
          const rawPatch = op.patch as Record<string, unknown>
          const patchCandidate =
            rawPatch && typeof rawPatch.props === "object" && rawPatch.props !== null && !Array.isArray(rawPatch.props)
              ? (rawPatch.props as Record<string, unknown>)
              : rawPatch
          deleteValueAtPath(patchCandidate, removed.path)
          if (removed.altPath) deleteValueAtPath(patchCandidate, removed.altPath)
        }
        if (unsupportedBlocks.size > 0) {
          const names = Array.from(unsupportedBlocks).join(", ")
          resolvedPlan.change_log = [
            ...resolvedPlan.change_log,
            `Note: ${names} blocks do not support images. Consider using CardGrid instead.`
          ]
        }
      }

      if (detectedImageOps.length > 0) {
        // Force plan approval so user can review before expensive image generation
        effectiveApplyMode = "plan_only"

        // Strip placeholder imageUrl values from ops so preview shows current image
        for (const op of resolvedPlan.ops) {
          if (op.op !== "update_props") continue
          const imgOps = detectedImageOps.filter((io) => io.blockId === op.blockId && io.pageSlug === op.pageSlug)
          if (imgOps.length === 0) continue
          const rawPatch = op.patch as Record<string, unknown>
          const patchCandidate =
            rawPatch && typeof rawPatch.props === "object" && rawPatch.props !== null && !Array.isArray(rawPatch.props)
              ? (rawPatch.props as Record<string, unknown>)
              : rawPatch
          for (const imgOp of imgOps) {
            if (typeof imgOp.path === "string" && imgOp.path.length > 0) {
              deleteValueAtPath(patchCandidate, imgOp.path)
            } else {
              delete patchCandidate.imageUrl
            }
            if (typeof imgOp.altPath === "string" && imgOp.altPath.length > 0) {
              deleteValueAtPath(patchCandidate, imgOp.altPath)
            } else {
              delete patchCandidate.imageAlt
            }
          }
        }

        // Annotate change_log with deferred image generation info
        for (const imgOp of detectedImageOps) {
          const pendingImageMessage =
            imgOp.provider === "unsplash"
              ? `Will find an image on Unsplash: "${imgOp.query}".`
              : imgOp.provider === "openai"
                ? `Will generate an image with AI: "${imgOp.query}".`
                : `Will resolve an image for: "${imgOp.query}".`
          resolvedPlan.change_log = [...resolvedPlan.change_log, pendingImageMessage]
        }
      } else {
        // Emit plan metadata and progress markers before blocking image resolution
        // so the UI gets instant feedback (e.g. "Created page /about.") while images load.
        options?.onPlanMeta?.({
          intent: resolvedPlan.intent,
          summary: resolvedPlan.summary_for_user,
          estimatedOps: resolvedPlan.ops.length
        })
        markFirstStructuredProgress()
        if (!stageTimeline.some((item) => item.stage === "plan_ready")) {
          const planReadyAtMs = Date.now() - pipelineStartedAtMs
          stageTimeline.push({ stage: "plan_ready", atMs: planReadyAtMs })
          ctx.chatTelemetry.push({
            id: chatRequestId,
            at: new Date().toISOString(),
            phase: "milestone",
            timelineStage: "plan_ready",
            session: body.session!,
            requestedSlug,
            effectiveSlug,
            plannerSource: source,
            modelKey,
            modelUsed,
            promptHash,
            promptExcerpt,
            promptLength: plannerMessage.length,
            totalDurationMs: planReadyAtMs
          })
        }

        // Keep legacy rewrite path as fallback only when native tool path did not already resolve image candidates.
        if (!usedNativeUnsplashTool && !usedNativeImageTool) {
          const imageResolutionStartMs = Date.now()
          emitStatus("Resolving image assets...")
          resolvedPlan = await withUnsplashHeroImage({
            plan: resolvedPlan,
            message: plannerMessage,
            slug: effectiveSlug,
            currentPage: current,
            activeBlockId: planningActiveBlockId,
            activeEditablePath: planningActiveEditablePath,
            chatRequestId,
            log: ctx.log,
            onStatusUpdate: options?.onStatusUpdate,
            onImageProgress: options?.onImageProgress
          })
          imageResolutionDurationMs += Date.now() - imageResolutionStartMs
        }
      }

      if (resolvedPlan.intent === "needs_clarification" && planningActiveBlockId) {
        const focusedFallback = compileDeterministicPlan({
          session: body.session ?? "dev",
          intent: { action: "clarify" },
          message: plannerMessage,
          slug: effectiveSlug ?? "/",
          currentPage: current,
          activeBlockId: planningActiveBlockId,
          activeEditablePath: planningActiveEditablePath
        })
        if (focusedFallback?.intent === "edit_plan" && focusedFallback.ops.length > 0) {
          resolvedPlan = focusedFallback
        }
      }
    }

    if (resolvedPlan.intent === "needs_clarification" && body.message && isBlockCatalogQuery(body.message)) {
      const forcedInfo = infoResponse({ body, current, plannerSource: source, modelUsed, modelKey })
      return { done: true as const, response: forcedInfo }
    }

    if (translationScope === "page") {
      const translationCoverageGap = findFullPageTranslationCoverageGap({
        plan: resolvedPlan,
        message: plannerMessage,
        currentPage: current,
        slug: effectiveSlug
      })
      if (translationCoverageGap) return { done: false as const, reason: translationCoverageGap }
    }

    // Emit plan metadata if not already emitted (deferred image path and other branches skip the early emit above)
    if (!stageTimeline.some((item) => item.stage === "first_structured_progress")) {
      options?.onPlanMeta?.({
        intent: resolvedPlan.intent,
        summary: resolvedPlan.summary_for_user,
        estimatedOps: resolvedPlan.ops.length
      })
    }
    markFirstStructuredProgress()
    if (!stageTimeline.some((item) => item.stage === "plan_ready")) {
      const planReadyAtMs = Date.now() - pipelineStartedAtMs
      stageTimeline.push({ stage: "plan_ready", atMs: planReadyAtMs })
      ctx.chatTelemetry.push({
        id: chatRequestId,
        at: new Date().toISOString(),
        phase: "milestone",
        timelineStage: "plan_ready",
        session: body.session!,
        requestedSlug,
        effectiveSlug,
        plannerSource: source,
        modelKey,
        modelUsed,
        promptHash,
        promptExcerpt,
        promptLength: plannerMessage.length,
        totalDurationMs: planReadyAtMs
      })
    }

    if (resolvedPlan.intent === "needs_clarification") {
      pendingClarificationBySession.set(body.session!, { baseRequest: plannerMessage, updatedAt: new Date().toISOString() })
      ctx.chatTelemetry.push({
        id: chatRequestId,
        at: new Date().toISOString(),
        phase: "result",
        session: body.session!,
        requestedSlug,
        effectiveSlug,
        plannerSource: source,
        modelKey,
        modelUsed,
        promptHash,
        promptExcerpt,
        promptLength: plannerMessage.length,
        outcome: "needs_clarification",
        intent: resolvedPlan.intent,
        opCount: resolvedPlan.ops.length,
        opTypes: resolvedPlan.ops.map((op) => op.op),
        plannerTier,
        ...plannerContextTelemetryFields,
        ...timingFields()
      })
      if (body.message) pushChatHistory(body.session!, body.message, resolvedPlan.summary_for_user)
      const selected =
        planningActiveBlockId && current.blocks.find((b) => b.id === planningActiveBlockId)
          ? current.blocks.find((b) => b.id === planningActiveBlockId)
          : null
      return {
        done: true as const,
        response: {
          code: 200,
          payload: withDebugPayload({
            status: "needs_clarification",
            summary: resolvedPlan.summary_for_user,
            changes: resolvedPlan.change_log,
            mentionedSlugs: collectMentionedSlugsFromPlan(resolvedPlan, effectiveSlug),
            suggestions: resolvedPlan.suggested_next_actions ?? clarificationSuggestions({ body, current, selected }),
            previewVersion: versions.get(body.session!) ?? 0,
            plannerSource: source,
            modelUsed,
            modelKey
          } satisfies ChatResult, {
            outcome: "needs_clarification",
            intent: resolvedPlan.intent,
            opCount: resolvedPlan.ops.length,
            opTypes: resolvedPlan.ops.map((op) => op.op),
            ...usageFields
          })
        }
      }
    }

    if (effectiveApplyMode === "plan_only") {
      const pendingPlanId = randomUUID()
      pendingApprovalPlanBySession.set(body.session!, {
        id: pendingPlanId,
        createdAt: new Date().toISOString(),
        promptHash,
        requestedSlug,
        effectiveSlug,
        summary: resolvedPlan.summary_for_user,
        source,
        modelUsed,
        modelKey,
        plan: structuredClone(resolvedPlan),
        originalMessage: plannerMessage,
        ...(detectedImageOps.length > 0 ? { pendingImageOps: detectedImageOps } : {})
      })
      ctx.chatTelemetry.push({
        id: chatRequestId,
        at: new Date().toISOString(),
        phase: "result",
        session: body.session!,
        requestedSlug,
        effectiveSlug,
        plannerSource: source,
        modelKey,
        modelUsed,
        promptHash,
        promptExcerpt,
        promptLength: plannerMessage.length,
        outcome: "plan_ready_for_approval",
        intent: resolvedPlan.intent,
        opCount: resolvedPlan.ops.length,
        opTypes: resolvedPlan.ops.map((op) => op.op),
        plannerTier,
        ...plannerContextTelemetryFields,
        ...timingFields()
      })
      return {
        done: true as const,
        response: {
          code: 200,
          payload: withDebugPayload({
            status: "plan_ready",
            summary: resolvedPlan.summary_for_user,
            changes: resolvedPlan.change_log,
            mentionedSlugs: collectMentionedSlugsFromPlan(resolvedPlan, effectiveSlug),
            previewVersion: versions.get(body.session!) ?? 0,
            plannerSource: source,
            modelUsed,
            modelKey,
            pendingPlanId
          } satisfies ChatResult, {
            outcome: "plan_ready_for_approval",
            intent: resolvedPlan.intent,
            opCount: resolvedPlan.ops.length,
            opTypes: resolvedPlan.ops.map((op) => op.op),
            ...usageFields
          })
        }
      }
    }

    const previous = getPage(body.session!, effectiveSlug)
    if (!previous) {
      return {
        done: true as const,
        response: { code: 404, payload: { error: "page not found" } as { error: string } }
      }
    }

    if (resolvedPlan.ops.length === 0) {
      pendingClarificationBySession.delete(body.session!)
      pendingApprovalPlanBySession.delete(body.session!)
      ctx.chatTelemetry.push({
        id: chatRequestId,
        at: new Date().toISOString(),
        phase: "result",
        session: body.session!,
        requestedSlug,
        effectiveSlug,
        plannerSource: source,
        modelKey,
        modelUsed,
        promptHash,
        promptExcerpt,
        promptLength: plannerMessage.length,
        outcome: "no_effective_change",
        intent: resolvedPlan.intent,
        opCount: 0,
        opTypes: [],
        plannerTier,
        ...plannerContextTelemetryFields,
        ...timingFields()
      })
      return {
        done: true as const,
        response: {
          code: 200,
          payload: withDebugPayload({
            status: "applied",
            summary: "No changes needed. That content is already up to date.",
            changes: [],
            mentionedSlugs: [effectiveSlug],
            previewVersion: versions.get(body.session!) ?? 0,
            plannerSource: source,
            modelUsed,
            modelKey
          } satisfies ChatResult, { outcome: "no_effective_change" })
        }
      }
    }

    if (siteCapabilities?.allowStructuralEdits === false && resolvedPlan.ops.some((op) => isStructuralOperation(op))) {
      const reason =
        typeof siteCapabilities.reason === "string" && siteCapabilities.reason.trim().length > 0
          ? ` ${siteCapabilities.reason.trim()}`
          : ""
      return {
        done: true as const,
        response: {
          code: 200,
          payload: withDebugPayload({
            status: "needs_clarification",
            summary: `Structural edits are disabled for this site context.${reason}`,
            changes: ["Expose GET /api/editor/components with a valid manifest to enable structural operations."],
            mentionedSlugs: [effectiveSlug],
            previewVersion: versions.get(body.session!) ?? 0,
            plannerSource: source,
            modelUsed,
            modelKey
          } satisfies ChatResult, { outcome: "blocked_structural_capability" })
        }
      }
    }

    let applyStartedAtMs: number | null = null
    let skippedOps: SkippedOperation[] = []
    try {
      // Validate ops against the canonical Zod schema at the NLP → ops-engine
      // boundary. Post-planner transforms (image rewriting, UI normalization)
      // could theoretically produce malformed ops; this catches them early.
      validateOperations(resolvedPlan.ops)

      emitStatus("Applying changes...")
      applyStartedAtMs = Date.now()
      const hasPageStructuralOps = resolvedPlan.ops.some(
        (op) => op.op === "create_page" || op.op === "rename_page" || op.op === "remove_page" || op.op === "move_page" || op.op === "duplicate_page"
      )
      if (incrementalApplyEnabled && options?.onOpApplied && !hasPageStructuralOps) {
        const rollbackBySlug = new Map<string, PageDoc>()
        for (const op of resolvedPlan.ops) {
          const slugsToSnapshot: string[] = []
          if (op.op === "create_page") slugsToSnapshot.push(op.page.slug)
          else slugsToSnapshot.push(op.pageSlug)
          if (op.op === "duplicate_block" && typeof op.toPageSlug === "string" && op.toPageSlug.length > 0) {
            slugsToSnapshot.push(op.toPageSlug)
          }

          for (const slug of slugsToSnapshot) {
            if (rollbackBySlug.has(slug)) continue
            const existing = getPage(body.session!, slug)
            if (existing) rollbackBySlug.set(slug, structuredClone(existing))
          }
        }

        // Validate the whole plan from the current state before progressive apply.
        const preflight = applyOpsAtomically(body.session!, resolvedPlan.ops, { componentsManifest })
        skippedOps = preflight.skippedOps

        // Roll back to pre-apply state so we can replay ops progressively.
        for (const [slug, snapshot] of rollbackBySlug) {
          setPage(body.session!, { ...snapshot, slug })
        }
        for (const op of resolvedPlan.ops) {
          if (op.op === "create_page") {
            if (rollbackBySlug.has(op.page.slug)) {
              setPage(body.session!, structuredClone(rollbackBySlug.get(op.page.slug)!))
              continue
            }
            const sessionDraft = getSessionDraft(body.session!)
            sessionDraft.delete(op.page.slug)
            continue
          }
          if (op.op === "rename_page") {
            const sessionDraft = getSessionDraft(body.session!)
            if (rollbackBySlug.has(op.newPageSlug)) {
              setPage(body.session!, structuredClone(rollbackBySlug.get(op.newPageSlug)!))
            } else {
              sessionDraft.delete(op.newPageSlug)
            }
          }
        }

        const total = resolvedPlan.ops.length
        try {
          for (let index = 0; index < total; index += 1) {
            throwIfCanceled(options?.signal)
            const stepStartedAtMs = Date.now()
            const op = resolvedPlan.ops[index]
            const stepResult = applyOpsAtomically(body.session!, [op], { componentsManifest })
            if (stepResult.skippedOps.length > 0) {
              for (const skipped of stepResult.skippedOps) {
                options?.onOpSkipped?.({
                  index: index + 1,
                  total,
                  op,
                  reason: skipped.reason
                })
              }
              continue
            }
            if (firstApplyMs === null) {
              firstApplyMs = Date.now() - pipelineStartedAtMs
              stageTimeline.push({ stage: "first_op_applied", atMs: firstApplyMs })
              ctx.chatTelemetry.push({
                id: chatRequestId,
                at: new Date().toISOString(),
                phase: "milestone",
                timelineStage: "first_op_applied",
                session: body.session!,
                requestedSlug,
                effectiveSlug,
                plannerSource: source,
                modelKey,
                modelUsed,
                promptHash,
                promptExcerpt,
                promptLength: plannerMessage.length,
                totalDurationMs: firstApplyMs
              })
            }
            const previewVersion = bumpVersion(body.session!)
            options.onOpApplied({
              index: index + 1,
              total,
              op,
              previewVersion,
              focusBlockId: pickFocusBlockId([op])
            })
            if (streamedApplyMinStepMs > 0 && total > 1 && index < total - 1) {
              const stepElapsedMs = Date.now() - stepStartedAtMs
              const remainingMs = streamedApplyMinStepMs - stepElapsedMs
              if (remainingMs > 0) await sleepMs(remainingMs)
            }
          }
        } catch (progressiveError) {
          if (isCancelError(progressiveError)) throw progressiveError
          options?.onRollbackStarted?.({ appliedCount: total, reason: toErrorDetail(progressiveError) })
          // Roll back to pre-plan state so we don't leave a partially-applied plan.
          for (const [slug, snapshot] of rollbackBySlug) {
            setPage(body.session!, { ...snapshot, slug })
          }
          options?.onRollbackDone?.({ restoredVersion: versions.get(body.session!) ?? 0 })
          throw progressiveError
        }
      } else {
        const applyResult = applyOpsAtomically(body.session!, resolvedPlan.ops, { componentsManifest })
        skippedOps = applyResult.skippedOps
        if (applyResult.appliedCount > 0 && firstApplyMs === null) {
          firstApplyMs = Date.now() - pipelineStartedAtMs
          stageTimeline.push({ stage: "first_op_applied", atMs: firstApplyMs })
          ctx.chatTelemetry.push({
            id: chatRequestId,
            at: new Date().toISOString(),
            phase: "milestone",
            timelineStage: "first_op_applied",
            session: body.session!,
            requestedSlug,
            effectiveSlug,
            plannerSource: source,
            modelKey,
            modelUsed,
            promptHash,
            promptExcerpt,
            promptLength: plannerMessage.length,
            totalDurationMs: firstApplyMs
          })
        }

        // Deferred image resolution for create_page: emit op_applied immediately
        // so the editor navigates to the new page with a shimmer placeholder,
        // then resolve the real image and patch it in.
        const deferredImages = (resolvedPlan as EditPlan & { _deferredCreatePageImages?: DeferredCreatePageImage[] })._deferredCreatePageImages
        if (deferredImages && deferredImages.length > 0 && options?.onOpApplied) {
          const deferredUpdatedSlug = pickUpdatedSlug(body.session!, effectiveSlug, resolvedPlan.ops)
          const immediatePreviewVersion = bumpVersion(body.session!)
          const createOp = resolvedPlan.ops.find((op) => op.op === "create_page")
          options.onOpApplied({
            index: 1,
            total: 1,
            op: createOp ?? resolvedPlan.ops[0],
            previewVersion: immediatePreviewVersion,
            focusBlockId: pickFocusBlockId(resolvedPlan.ops),
            updatedSlug: deferredUpdatedSlug
          })

          // Resolve each deferred image and patch the Hero block
          for (const deferred of deferredImages) {
            throwIfCanceled(options?.signal)
            try {
              const deferredImageStart = Date.now()
              const imageResult = await raceCancel(resolveHeroImageForCreatePage({
                query: deferred.query,
                pageTitle: deferred.pageTitle,
                pageSlug: deferred.pageSlug,
                sectionContext: deferred.sectionContext,
                chatRequestId,
                log: ctx.log,
                onStatusUpdate: options.onStatusUpdate,
                onImageProgress: options?.onImageProgress
              }), options?.signal)
              const deferredImageDurationMs = Date.now() - deferredImageStart
              if (imageResult) {
                const patchOp: Operation = {
                  op: "update_props",
                  pageSlug: deferred.pageSlug,
                  blockId: deferred.blockId,
                  patch: { props: { imageUrl: imageResult.url, imageAlt: imageResult.alt } }
                }
                applyOpsAtomically(body.session!, [patchOp], { componentsManifest })
                const patchVersion = bumpVersion(body.session!)
                options.onOpApplied({
                  index: 1,
                  total: 1,
                  op: patchOp,
                  previewVersion: patchVersion,
                  focusBlockId: deferred.blockId
                })
                resolvedPlan.change_log = [...resolvedPlan.change_log, "Generated a new image with AI."]
                ctx.log.info(
                  { event: "deferred_hero_image_resolved", chatRequestId, pageSlug: deferred.pageSlug, blockId: deferred.blockId, source: imageResult.source, durationMs: deferredImageDurationMs },
                  `Deferred hero image resolved and applied in ${deferredImageDurationMs}ms`
                )
              }
            } catch (err) {
              if (isCancelError(err)) throw err
              ctx.log.warn(
                { event: "deferred_hero_image_failed", chatRequestId, pageSlug: deferred.pageSlug, blockId: deferred.blockId, error: toErrorDetail(err) },
                "Deferred hero image resolution failed — page remains with placeholder"
              )
            }
          }
        }
      }
      pushUndo(body.session!, effectiveSlug, previous)
      pendingClarificationBySession.delete(body.session!)
      pendingApprovalPlanBySession.delete(body.session!)
      const planUpdatedSlug = pickUpdatedSlug(body.session!, effectiveSlug, resolvedPlan.ops)
      const updatedSlug = planUpdatedSlug ?? (effectiveSlug !== requestedSlug ? effectiveSlug : undefined)
      pushRecentEdit(body.session!, { slug: updatedSlug ?? effectiveSlug, summary: futureToPastTense(resolvedPlan.summary_for_user), ops: resolvedPlan.ops })
      if (body.message) pushChatHistory(body.session!, body.message, futureToPastTense(resolvedPlan.summary_for_user))
      const previewVersion = options?.onOpApplied ? (versions.get(body.session!) ?? 0) : bumpVersion(body.session!)
      schedulePersistState(ctx.log)
      const focusBlockId = pickFocusBlockId(resolvedPlan.ops)
      const aiInsightChanges = buildAiInsightChanges({ plan: resolvedPlan, message: plannerMessage })
      const metaChangeLogEntries = buildMetaChangeLogEntries(resolvedPlan.ops)
      const skippedSummary =
        skippedOps.length > 0
          ? [`Skipped ${skippedOps.length} unchanged operation${skippedOps.length === 1 ? "" : "s"}.`]
          : []
      applyDurationMs = applyStartedAtMs !== null ? Date.now() - applyStartedAtMs : undefined
      ctx.chatTelemetry.push({
        id: chatRequestId,
        at: new Date().toISOString(),
        phase: "result",
        session: body.session!,
        requestedSlug,
        effectiveSlug,
        plannerSource: source,
        modelKey,
        modelUsed,
        promptHash,
        promptExcerpt,
        promptLength: plannerMessage.length,
        outcome: "applied",
        intent: resolvedPlan.intent,
        opCount: resolvedPlan.ops.length,
        opTypes: resolvedPlan.ops.map((op) => op.op),
        skippedOpCount: skippedOps.length > 0 ? skippedOps.length : undefined,
        plannerTier,
        ...plannerContextTelemetryFields,
        ...usageFields,
        ...timingFields()
      })
      return {
        done: true as const,
        response: {
          code: 200,
          payload: withDebugPayload({
            status: "applied",
            summary: futureToPastTense(resolvedPlan.summary_for_user),
            changes: [...resolvedPlan.change_log.map(futureToPastTense), ...metaChangeLogEntries, ...aiInsightChanges, ...skippedSummary],
            mentionedSlugs: collectMentionedSlugsFromPlan(resolvedPlan, updatedSlug ?? effectiveSlug),
            suggestions: resolvedPlan.suggested_next_actions ?? postEditSuggestions({ plan: resolvedPlan, current, body }),
            previewVersion,
            focusBlockId,
            updatedSlug,
            plannerSource: source,
            modelUsed,
            modelKey
          } satisfies ChatResult, {
            outcome: "applied",
            intent: resolvedPlan.intent,
            opCount: resolvedPlan.ops.length,
            opTypes: resolvedPlan.ops.map((op) => op.op),
            skippedOpCount: skippedOps.length,
            skippedOps,
            ...usageFields
          })
        }
      }
    } catch (error) {
      if (isCancelError(error)) throw error
      if (applyDurationMs === undefined && applyStartedAtMs !== null) {
        applyDurationMs = Date.now() - applyStartedAtMs
      }
      const reason = toErrorDetail(error)
      if (isNoEffectiveChangeError(reason)) {
        pendingApprovalPlanBySession.delete(body.session!)
        ctx.chatTelemetry.push({
          id: chatRequestId,
          at: new Date().toISOString(),
          phase: "result",
          session: body.session!,
          requestedSlug,
          effectiveSlug,
          plannerSource: source,
          modelKey,
          modelUsed,
          promptHash,
          promptExcerpt,
          promptLength: plannerMessage.length,
          outcome: "no_effective_change",
          reason: reason.slice(0, 300),
          plannerTier,
          ...plannerContextTelemetryFields,
          ...timingFields()
        })
        return {
          done: true as const,
          response: {
            code: 200,
            payload: withDebugPayload({
              status: "applied",
              summary: "No changes needed. That content is already up to date.",
              changes: [],
              mentionedSlugs: [effectiveSlug],
              previewVersion: versions.get(body.session!) ?? 0,
              plannerSource: source,
              modelUsed,
              modelKey
            } satisfies ChatResult, { outcome: "no_effective_change" })
          }
        }
      }
      ctx.chatTelemetry.push({
        id: chatRequestId,
        at: new Date().toISOString(),
        phase: "plan_apply_failed",
        session: body.session!,
        requestedSlug,
        effectiveSlug,
        plannerSource: source,
        modelKey,
        modelUsed,
        promptHash,
        promptExcerpt,
        promptLength: plannerMessage.length,
        outcome: "apply_failed",
        reason: reason.slice(0, 300),
        reasonCategory: classifyGuardrailError(reason),
        plannerTier,
        ...timingFields()
      })
      return { done: false as const, reason }
    }
  }

  if (executionMode === "apply_pending_plan") {
    const pending = pendingApprovalPlanBySession.get(body.session)
    if (!pending) {
      const fallbackMessage = typeof body.message === "string" ? body.message.trim() : ""
      if (fallbackMessage.length > 0) {
        return runChatPipeline(ctx, { ...body, executionMode: "auto" }, options)
      }
      return {
        code: 409,
        payload: withDebugPayload({
          status: "needs_clarification",
          summary: "No pending plan is waiting for approval. Ask for a change first.",
          changes: [],
          previewVersion: versions.get(body.session) ?? 0,
          plannerSource,
          modelUsed,
          modelKey
        } satisfies ChatResult, { outcome: "pending_plan_missing" })
      }
    }
    if (body.pendingPlanId && body.pendingPlanId !== pending.id) {
      return {
        code: 409,
        payload: withDebugPayload({
          status: "validation_error",
          summary: "Pending plan does not match the latest reviewed plan.",
          changes: [],
          validationErrors: ["Pending plan id mismatch. Refresh and approve again."],
          previewVersion: versions.get(body.session) ?? 0,
          plannerSource,
          modelUsed,
          modelKey
        } satisfies ChatResult, { outcome: "pending_plan_mismatch" })
      }
    }
    // Run deferred image generation if the pending plan has image ops
    let approvalPlan = pending.plan
    try {
      if (pending.pendingImageOps && pending.pendingImageOps.length > 0) {
        const imageResolutionStartMs = Date.now()
        emitStatus("Resolving image assets...")
        const imageMessage = pending.originalMessage ?? (typeof body.message === "string" ? body.message : "")
        const planClone = structuredClone(approvalPlan)

        // Restore placeholder imageUrl in ops that had it stripped during detection.
        // withUnsplashHeroImage checks requestedImageUrl.length > 0 to decide whether
        // to resolve an image — without this, the stripped patch causes it to skip.
        for (const imgOp of pending.pendingImageOps) {
          const op = planClone.ops.find(
            (o) => o.op === "update_props" && o.blockId === imgOp.blockId && o.pageSlug === imgOp.pageSlug
          )
          if (!op || op.op !== "update_props") continue
          const rawPatch = op.patch as Record<string, unknown>
          const patchTarget =
            rawPatch && typeof rawPatch.props === "object" && rawPatch.props !== null && !Array.isArray(rawPatch.props)
              ? (rawPatch.props as Record<string, unknown>)
              : rawPatch
          if (typeof imgOp.path === "string" && imgOp.path.length > 0) {
            if (getValueAtPath(patchTarget, imgOp.path) === undefined) {
              setValueAtPath(patchTarget, imgOp.path, "pending")
            }
          } else if (!Object.prototype.hasOwnProperty.call(patchTarget, "imageUrl")) {
            patchTarget.imageUrl = "pending"
          }
        }

        approvalPlan = await withUnsplashHeroImage({
          plan: planClone,
          message: imageMessage,
          slug: pending.effectiveSlug,
          currentPage: current,
          preferredImageOps: pending.pendingImageOps,
          activeBlockId: body.activeBlockId,
          activeEditablePath: body.activeEditablePath,
          chatRequestId,
          log: ctx.log,
          onStatusUpdate: options?.onStatusUpdate,
          onImageProgress: options?.onImageProgress
        })
        imageResolutionDurationMs += Date.now() - imageResolutionStartMs
      }
      const approvedOutcome = await respondFromPlan(approvalPlan, pending.source, "apply_now", { preResolvedPlan: true })
      if (approvedOutcome.done) return approvedOutcome.response
      return guardrailFailureResponse({ reason: approvedOutcome.reason, source: pending.source })
    } catch (error) {
      const reason = toErrorDetail(error)
      ctx.log.error({ event: "apply_pending_plan_error", chatRequestId, error: reason }, "Pending plan execution failed")
      pendingApprovalPlanBySession.delete(body.session!)
      ctx.chatTelemetry.push({
        id: chatRequestId,
        at: new Date().toISOString(),
        phase: "result",
        session: body.session!,
        requestedSlug,
        effectiveSlug,
        plannerSource: pending.source,
        modelKey: pending.modelKey,
        modelUsed: pending.modelUsed,
        promptHash,
        promptExcerpt,
        promptLength: plannerMessage.length,
        outcome: "apply_pending_plan_error",
        reason: reason.slice(0, 300),
        reasonCategory: classifyGuardrailError(reason),
        ...plannerContextTelemetryFields,
        ...timingFields()
      })
      return {
        code: 500,
        payload: withDebugPayload({
          status: "error",
          summary: "Failed to execute the approved plan. Please try again.",
          changes: [reason.slice(0, 300)],
          previewVersion: versions.get(body.session!) ?? 0,
          plannerSource: pending.source,
          modelUsed: pending.modelUsed,
          modelKey: pending.modelKey
        } satisfies ChatResult, { outcome: "apply_pending_plan_error" })
      }
    }
  }

  const applyMode = executionMode === "plan_only" ? "plan_only" : "apply_now"

  markPlanningStart()
  emitStatus("Planning edits...")
  const forcedDuplicatePlan = deterministicDuplicatePagePlan({ session: body.session, message: plannerMessage, effectiveSlug })
  if (forcedDuplicatePlan) {
    markPlanningFinish()
    ctx.chatTelemetry.push({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "forced_plan",
      session: body.session,
      requestedSlug,
      effectiveSlug,
      plannerSource,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      outcome: "forced_duplicate_page",
      intent: forcedDuplicatePlan.intent,
      opCount: forcedDuplicatePlan.ops.length,
      opTypes: forcedDuplicatePlan.ops.map((op) => op.op),
      plannerTier: "forced_deterministic",
      ...timingFields()
    })
    const forcedOutcome = await respondFromPlan(forcedDuplicatePlan, plannerSource, applyMode, undefined, "forced_deterministic")
    if (forcedOutcome.done) return forcedOutcome.response
  }

  const forcedSelectedRewritePlan = deterministicSelectedTextRewritePlan({
    slug: effectiveSlug,
    message: plannerMessage,
    currentPage: current,
    activeBlockId: planningActiveBlockId,
    activeEditablePath: planningActiveEditablePath
  })
  if (forcedSelectedRewritePlan) {
    markPlanningFinish()
    ctx.chatTelemetry.push({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "forced_plan",
      session: body.session,
      requestedSlug,
      effectiveSlug,
      plannerSource,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      outcome: "forced_rewrite_selected_text",
      intent: forcedSelectedRewritePlan.intent,
      opCount: forcedSelectedRewritePlan.ops.length,
      opTypes: forcedSelectedRewritePlan.ops.map((op) => op.op),
      plannerTier: "forced_deterministic",
      ...timingFields()
    })
    const forcedOutcome = await respondFromPlan(forcedSelectedRewritePlan, plannerSource, applyMode, undefined, "forced_deterministic")
    if (forcedOutcome.done) return forcedOutcome.response
  }

  const forcedCreatePlan = deterministicCreatePagePlan({ session: body.session, message: plannerMessage })
  if (forcedCreatePlan) {
    markPlanningFinish()
    ctx.chatTelemetry.push({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "forced_plan",
      session: body.session,
      requestedSlug,
      effectiveSlug,
      plannerSource,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      outcome: "forced_create_page",
      intent: forcedCreatePlan.intent,
      opCount: forcedCreatePlan.ops.length,
      opTypes: forcedCreatePlan.ops.map((op) => op.op),
      plannerTier: "forced_deterministic",
      ...timingFields()
    })
    const forcedOutcome = await respondFromPlan(forcedCreatePlan, plannerSource, applyMode, undefined, "forced_deterministic")
    if (forcedOutcome.done) return forcedOutcome.response
  }

  if (plannerSource === "demo") {
    markPlanningStart()
    try {
      emitStatus("Planning edits...")
      const demoPlan = demoPlanFromMessageImpl(plannerMessage, effectiveSlug, planningActiveBlockId, body.activeBlockType)
      markPlanningFinish()
      const outcome = await respondFromPlan(demoPlan, "demo", applyMode, undefined, "demo")
      if (outcome.done) return outcome.response
      return guardrailFailureResponse({ reason: outcome.reason, source: "demo" })
    } catch (error) {
      markPlanningFinish()
      const reason = toErrorDetail(error)
      ctx.chatTelemetry.push({
        id: chatRequestId,
        at: new Date().toISOString(),
        phase: "result",
        session: body.session,
        requestedSlug,
        effectiveSlug,
        plannerSource: "demo",
        modelKey,
        modelUsed,
        promptHash,
        promptExcerpt,
        promptLength: plannerMessage.length,
        outcome: "planner_exception",
        reason: reason.slice(0, 300),
        reasonCategory: classifyGuardrailError(reason),
        plannerTier: "demo",
        ...plannerContextTelemetryFields,
        ...timingFields()
      })
      return {
        code: 500,
        payload: withDebugPayload({
          status: "error",
          summary: "Could not generate an edit plan.",
          changes: [reason.slice(0, 300)],
          previewVersion: versions.get(body.session) ?? 0,
          plannerSource: "demo",
          modelUsed,
          modelKey
        }, { outcome: "planner_exception", reasonCategory: classifyGuardrailError(reason) })
      }
    }
  }

  const isHighConfidence = isHighConfidenceDeterministicCase({
    message: plannerMessage,
    currentPage: current,
    activeBlockId: planningActiveBlockId,
    activeEditablePath: planningActiveEditablePath
  })

  if (isHighConfidence) {
    const deterministicIntent = inferDeterministicIntent({
      message: plannerMessage,
      currentPage: current,
      activeBlockId: planningActiveBlockId,
      activeEditablePath: planningActiveEditablePath
    })

    if (deterministicIntent) {
      emitStatus("Planning edits...")
      const deterministicPlan = compileDeterministicPlan({
        session: body.session,
        intent: deterministicIntent,
        message: plannerMessage,
        slug: effectiveSlug,
        currentPage: current,
        activeBlockId: planningActiveBlockId,
        activeEditablePath: planningActiveEditablePath
      })

      if (deterministicPlan?.intent === "edit_plan" && deterministicPlan.ops.length > 0) {
        markPlanningFinish()
        ctx.chatTelemetry.push({
          id: chatRequestId,
          at: new Date().toISOString(),
          phase: "deterministic_plan_generated",
          session: body.session,
          requestedSlug,
          effectiveSlug,
          plannerSource,
          modelKey,
          modelUsed,
          promptHash,
          promptExcerpt,
          promptLength: plannerMessage.length,
          outcome: "deterministic_plan_ready",
          intent: deterministicPlan.intent,
          opCount: deterministicPlan.ops.length,
          opTypes: deterministicPlan.ops.map((op) => op.op),
          plannerTier: "deterministic"
        })
        const deterministicOutcome = await respondFromPlan(deterministicPlan, plannerSource, applyMode, undefined, "deterministic")
        if (deterministicOutcome.done) return deterministicOutcome.response
      }

      if (
        deterministicPlan?.intent === "needs_clarification" &&
        shouldReturnDeterministicClarification(plannerMessage)
      ) {
        markPlanningFinish()
        const deterministicOutcome = await respondFromPlan(deterministicPlan, plannerSource, applyMode, undefined, "deterministic")
        if (deterministicOutcome.done) return deterministicOutcome.response
      }
    }
  }

  const llmIntentRouterEnabled = !/^(0|false|no|off)$/i.test((process.env.CHAT_LLM_INTENT_ROUTER ?? "1").trim())
  const shouldTryLlmIntentRouter =
    llmIntentRouterEnabled &&
    shouldUseLlmIntentRouter(plannerMessage) &&
    (plannerSource === "openai" || plannerSource === "anthropic")

  if (shouldTryLlmIntentRouter) {
    try {
      emitStatus("Understanding your request...")
      const routerModel =
        ctx.modelLookup[provider]?.fast ??
        ctx.modelLookup[provider]?.balanced ??
        modelUsed

      const routedIntent =
        plannerSource === "anthropic"
          ? await parseIntentWithAnthropicImpl({
              message: plannerMessage,
              slug: effectiveSlug,
              currentPage: current,
              activeBlockId: planningActiveBlockId,
              activeBlockType: body.activeBlockType,
              activeEditablePath: planningActiveEditablePath,
              model: routerModel,
              log: ctx.log
            })
          : await parseIntentWithOpenAIImpl({
              message: plannerMessage,
              slug: effectiveSlug,
              currentPage: current,
              activeBlockId: planningActiveBlockId,
              activeBlockType: body.activeBlockType,
              activeEditablePath: planningActiveEditablePath,
              model: routerModel
            })

      emitStatus("Planning edits...")
      const routedPlan = compileDeterministicPlan({
        session: body.session,
        intent: routedIntent,
        message: plannerMessage,
        slug: effectiveSlug,
        currentPage: current,
        activeBlockId: planningActiveBlockId,
        activeEditablePath: planningActiveEditablePath
      })

      if (routedPlan?.intent === "edit_plan" && routedPlan.ops.length > 0) {
        markPlanningFinish()
        ctx.chatTelemetry.push({
          id: chatRequestId,
          at: new Date().toISOString(),
          phase: "deterministic_plan_generated",
          session: body.session,
          requestedSlug,
          effectiveSlug,
          plannerSource,
          modelKey,
          modelUsed,
          promptHash,
          promptExcerpt,
          promptLength: plannerMessage.length,
          outcome: "llm_router_plan_ready",
          intent: routedPlan.intent,
          opCount: routedPlan.ops.length,
          opTypes: routedPlan.ops.map((op) => op.op),
          plannerTier: "llm_intent_router",
          ...timingFields()
        })
        const routedOutcome = await respondFromPlan(routedPlan, plannerSource, applyMode, undefined, "llm_intent_router")
        if (routedOutcome.done) return routedOutcome.response
      }

      if (routedPlan?.intent === "needs_clarification" && shouldReturnDeterministicClarification(plannerMessage)) {
        markPlanningFinish()
        ctx.chatTelemetry.push({
          id: chatRequestId,
          at: new Date().toISOString(),
          phase: "deterministic_plan_generated",
          session: body.session,
          requestedSlug,
          effectiveSlug,
          plannerSource,
          modelKey,
          modelUsed,
          promptHash,
          promptExcerpt,
          promptLength: plannerMessage.length,
          outcome: "llm_router_needs_clarification",
          intent: routedPlan.intent,
          opCount: 0,
          opTypes: [],
          plannerTier: "llm_intent_router",
          ...timingFields()
        })
        const routedOutcome = await respondFromPlan(routedPlan, plannerSource, applyMode, undefined, "llm_intent_router")
        if (routedOutcome.done) return routedOutcome.response
      }
    } catch {
      // If router fails, fall back to the full planner.
    }
  }

  // --- Continuation chain decomposition ---
  // If the message looks like a multi-step request and we haven't already entered a chain,
  // decompose it into steps and execute only the first one through the normal planner.
  if (
    executionMode === "auto" &&
    !continuationChainBySession.has(body.session) &&
    isMultiStepCandidate(plannerMessage) &&
    (plannerSource === "openai" || plannerSource === "anthropic")
  ) {
    try {
      emitStatus("Breaking down your request...")
      // Always use OpenAI for decomposition — it's a lightweight JSON task that
      // doesn't need the full Anthropic planner, and avoids model/provider mismatch.
      const decomposerModel =
        ctx.modelLookup.openai?.fast ??
        ctx.modelLookup.openai?.balanced ??
        ctx.modelLookup[provider]?.fast ??
        modelUsed
      const decomposition = await decomposeRequest({
        message: plannerMessage,
        currentPage: current,
        slug: effectiveSlug,
        model: decomposerModel,
        siteContextBlock
      })
      if (decomposition.steps.length > 1) {
        const chain: ContinuationChain = {
          id: randomUUID(),
          steps: decomposition.steps,
          stepLabels: decomposition.labels,
          currentStep: 0,
          totalSteps: decomposition.steps.length,
          originalMessage: plannerMessage,
          effectiveSlug,
          siteContextBlock
        }
        continuationChainBySession.set(body.session, chain)

        // Execute step 0 through normal planner
        chain.currentStep = 1
        const stepResult = await runChatPipeline(ctx, {
          ...body,
          message: decomposition.steps[0],
          executionMode: "auto"
        }, options)

        // Attach continuation info for remaining steps
        if (stepResult.code === 200 && "status" in stepResult.payload && stepResult.payload.status !== "error") {
          const payload = stepResult.payload as ChatResult
          payload.continuation = {
            chainId: chain.id,
            currentStep: 2, // 1-indexed for display
            totalSteps: chain.totalSteps,
            nextStepLabel: chain.stepLabels[1]
          }
        }

        return stepResult
      }
      // If 1 step, fall through to normal flow
    } catch (decompositionError) {
      if (isCancelError(decompositionError)) throw decompositionError
      ctx.log.warn({ err: toErrorDetail(decompositionError), event: "decomposition_failed" }, "Request decomposition failed, falling back to normal planner")
      // Fall through to normal flow
    }
  }

  const generatePlanImpl = plannerSource === "anthropic" ? generatePlanWithAnthropicImpl : generatePlanWithOpenAIImpl
  const maxPlanningAttempts = 3
  let initialPlan: EditPlan | null = null
  const planningErrors: string[] = []
  markPlanningStart()

  for (let attempt = 1; attempt <= maxPlanningAttempts; attempt += 1) {
    throwIfCanceled(options?.signal)
    planningAttempts = attempt
    try {
      emitStatus(attempt === 1 ? "Calling AI model..." : `Retrying plan generation (${attempt}/${maxPlanningAttempts})...`)
      const result = await raceCancel(generatePlanImpl({
        message: plannerMessage,
        slug: effectiveSlug,
        currentPage: current,
        contextPack: plannerContext,
        model: modelUsed,
        history: sessionChatHistory,
        siteContextBlock,
        toolRuntime: plannerSource === "anthropic" ? ctx.toolRuntime : undefined,
        toolCallContext: plannerSource === "anthropic"
          ? {
              siteId: body.siteId ?? "default",
              sessionId: body.session ?? "dev",
              traceId: chatRequestId
            }
          : undefined,
        onStatusUpdate: options?.onStatusUpdate,
        onImageProgress: options?.onImageProgress,
        onToolExecution: plannerSource === "anthropic"
          ? (event) => {
              if (event.ok && event.toolName === "unsplash.search") usedNativeUnsplashTool = true
              if (event.ok && event.toolName === "image.generate") usedNativeImageTool = true
              ctx.chatTelemetry.push({
                id: chatRequestId,
                at: new Date().toISOString(),
                phase: "tool_call",
                session: body.session ?? "dev",
                requestedSlug,
                effectiveSlug,
                plannerSource,
                modelKey,
                modelUsed,
                promptHash,
                promptExcerpt,
                promptLength: plannerMessage.length,
                toolName: event.toolName,
                toolOk: event.ok,
                toolLatencyMs: event.latencyMs,
                toolAttempts: event.attempts,
                toolErrorCode: event.errorCode,
                correlationId: event.traceId,
                outcome: event.ok ? "tool_ok" : "tool_error",
                ...timingFields()
              })
            }
          : undefined,
        log: ctx.log,
        onToken: onPlanningToken,
        onSummaryChunk: options?.onSummaryChunk,
        onChangeLogEntry: options?.onChangeLogEntry,
        onPlannedOp: incrementalPlanStreamEnabled
          ? (op, index) => {
              markFirstStructuredProgress()
              options?.onPlannedOp?.({ op, index })
            }
          : undefined,
        manifestBlockTypes: componentsManifest ? componentsManifest.components.map(c => c.type) : undefined,
        signal: options?.signal
      }), options?.signal)
      initialPlan = result.plan
      planUsage = result.usage
      if (result.schemaContext) {
        plannerContextTelemetryFields.contractMode = result.schemaContext.contractMode
        plannerContextTelemetryFields.contractBytes = result.schemaContext.contractBytes
        plannerContextTelemetryFields.contractBlockCount = result.schemaContext.contractBlockCount
        plannerContextTelemetryFields.strictJsonEnabled = result.schemaContext.strictJsonEnabled
      }
      markPlanningFinish()
      emitStatus("Validating plan...")
      break
    } catch (error) {
      if (isCancelError(error)) throw error
      const reason = toErrorDetail(error)
      const reasonCategory = isPlannerOutputError(error) ? error.reasonCategory : classifyGuardrailError(reason)
      ctx.log.warn({ event: "plan_attempt_failed", attempt, model: modelUsed, reason: reason.slice(0, 300) },
        `Planning attempt ${attempt} failed`)
      ctx.chatTelemetry.push({
        id: chatRequestId,
        at: new Date().toISOString(),
        phase: "plan_attempt_failed",
        session: body.session,
        requestedSlug,
        effectiveSlug,
        plannerSource,
        modelKey,
        modelUsed,
        promptHash,
        promptExcerpt,
        promptLength: plannerMessage.length,
        outcome: `attempt_${attempt}_failed`,
        reason: reason.slice(0, 300),
        reasonCategory,
        plannerRefusal: reasonCategory === "planner_refusal" ? true : undefined,
        plannerIncomplete: reasonCategory === "incomplete_output" ? true : undefined,
        ...timingFields()
      })
      if (isPlannerOutputError(error) && !error.retryable) {
        markPlanningFinish()
        ctx.chatTelemetry.push({
          id: chatRequestId,
          at: new Date().toISOString(),
          phase: "result",
          session: body.session,
          requestedSlug,
          effectiveSlug,
          plannerSource,
          modelKey,
          modelUsed,
          promptHash,
          promptExcerpt,
          promptLength: plannerMessage.length,
          outcome: reasonCategory === "planner_refusal" ? "planning_refusal" : "planning_incomplete",
          reason: reason.slice(0, 300),
          reasonCategory,
          plannerRefusal: reasonCategory === "planner_refusal" ? true : undefined,
          plannerIncomplete: reasonCategory === "incomplete_output" ? true : undefined,
          plannerTier: "full_llm",
          ...plannerContextTelemetryFields,
          ...timingFields()
        })
        if (reasonCategory === "planner_refusal") {
          return {
            code: 200,
            payload: withDebugPayload({
              status: "needs_clarification",
              summary: "I can’t help with that request as written. Please rephrase and I can try a safe alternative.",
              changes: [],
              suggestions: [
                "Describe the same goal in safer, neutral terms.",
                "Limit the request to website content edits only.",
                "Ask for a high-level rewrite without sensitive details."
              ],
              previewVersion: versions.get(body.session) ?? 0,
              plannerSource,
              modelUsed,
              modelKey
            }, { outcome: "planning_refusal", reasonCategory })
          }
        }
        return {
          code: 500,
          payload: withDebugPayload({
            status: "error",
            summary: "I couldn’t finish generating a plan. Please try again.",
            changes: [],
            validationErrors: [reason.slice(0, 300)],
            previewVersion: versions.get(body.session) ?? 0,
            plannerSource,
            modelUsed,
            modelKey
          }, { outcome: "planning_incomplete", reasonCategory })
        }
      }
      planningErrors.push(`Attempt ${attempt} planning failed: ${reason}`)
      if (attempt === maxPlanningAttempts) {
        markPlanningFinish()
        ctx.chatTelemetry.push({
          id: chatRequestId,
          at: new Date().toISOString(),
          phase: "result",
          session: body.session,
          requestedSlug,
          effectiveSlug,
          plannerSource,
          modelKey,
          modelUsed,
          promptHash,
          promptExcerpt,
          promptLength: plannerMessage.length,
          outcome: "planning_exhausted",
          reason: reason.slice(0, 300),
          reasonCategory,
          plannerRefusal: reasonCategory === "planner_refusal" ? true : undefined,
          plannerIncomplete: reasonCategory === "incomplete_output" ? true : undefined,
          plannerTier: "full_llm",
          ...plannerContextTelemetryFields,
          ...timingFields()
        })
        return {
          code: 500,
          payload: withDebugPayload({
            status: "error",
            summary: "Could not generate an edit plan.",
            changes: [reason.slice(0, 300)],
            validationErrors: planningErrors.slice(-3),
            previewVersion: versions.get(body.session) ?? 0,
            plannerSource,
            modelUsed,
            modelKey
          }, { outcome: "planning_exhausted", reasonCategory })
        }
      }
    }
  }

  if (!initialPlan) {
    markPlanningFinish()
    ctx.chatTelemetry.push({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "result",
      session: body.session,
      requestedSlug,
      effectiveSlug,
      plannerSource,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      outcome: "planning_missing",
      plannerTier: "full_llm",
      ...plannerContextTelemetryFields,
      ...timingFields()
    })
    return {
      code: 500,
      payload: withDebugPayload({
        status: "error",
        summary: "Could not generate an edit plan.",
        changes: [],
        validationErrors: planningErrors.slice(-3),
        previewVersion: versions.get(body.session) ?? 0,
        plannerSource,
        modelUsed,
        modelKey
      }, { outcome: "planning_missing" })
    }
  }

  const initialOutcome = await respondFromPlan(initialPlan, plannerSource, applyMode, undefined, "full_llm")
  if (initialOutcome.done) return initialOutcome.response

  if (!isDeterministicRepairEligible(initialOutcome.reason)) {
    return guardrailFailureResponse({ reason: initialOutcome.reason, source: plannerSource })
  }

  let repairedPlan: EditPlan
  try {
    throwIfCanceled(options?.signal)
    emitStatus("Repairing plan and retrying...")
    ctx.chatTelemetry.push({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "repair_attempt",
      session: body.session,
      requestedSlug,
      effectiveSlug,
      plannerSource,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      outcome: "repair_started",
      reason: initialOutcome.reason.slice(0, 300),
      reasonCategory: classifyGuardrailError(initialOutcome.reason),
      ...timingFields()
    })
    planningAttempts += 1
    plannerContextTelemetryFields.schemaRetryUsed = true
    const repairFeedback = /full-page translation coverage/i.test(initialOutcome.reason)
      ? `${initialOutcome.reason}. Repair for translation completeness: include missing translated text fields for list children across all affected blocks. Preserve links/hrefs unchanged.`
      : buildDeterministicRepairFeedback(initialOutcome.reason)
    const repairResult = await raceCancel(generatePlanImpl({
      message: plannerMessage,
      slug: effectiveSlug,
      currentPage: current,
      contextPack: plannerContext,
      model: modelUsed,
      history: sessionChatHistory,
      feedback: repairFeedback,
      forceFullSchemaContracts: true,
      siteContextBlock,
      onToken: onPlanningToken,
      onSummaryChunk: options?.onSummaryChunk,
      onChangeLogEntry: options?.onChangeLogEntry,
      onPlannedOp: incrementalPlanStreamEnabled
        ? (op, index) => {
            markFirstStructuredProgress()
            options?.onPlannedOp?.({ op, index })
          }
        : undefined,
      signal: options?.signal
    }), options?.signal)
    repairedPlan = repairResult.plan
    planUsage = repairResult.usage
    if (repairResult.schemaContext) {
      plannerContextTelemetryFields.contractMode = repairResult.schemaContext.contractMode
      plannerContextTelemetryFields.contractBytes = repairResult.schemaContext.contractBytes
      plannerContextTelemetryFields.contractBlockCount = repairResult.schemaContext.contractBlockCount
      plannerContextTelemetryFields.strictJsonEnabled = repairResult.schemaContext.strictJsonEnabled
    }
    markPlanningFinish()
    ctx.chatTelemetry.push({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "repair_generated",
      session: body.session,
      requestedSlug,
      effectiveSlug,
      plannerSource,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      outcome: "repair_plan_generated",
      intent: repairedPlan.intent,
      opCount: repairedPlan.ops.length,
      opTypes: repairedPlan.ops.map((op) => op.op),
      ...timingFields()
    })
  } catch (error) {
    if (isCancelError(error)) throw error
    markPlanningFinish()
    const reason = toErrorDetail(error)
    ctx.chatTelemetry.push({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "result",
      session: body.session,
      requestedSlug,
      effectiveSlug,
      plannerSource,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      outcome: "repair_failed",
      reason: reason.slice(0, 300),
      reasonCategory: classifyGuardrailError(reason),
      ...plannerContextTelemetryFields,
      ...timingFields()
    })
    return {
      code: 400,
      payload: withDebugPayload({
        status: "validation_error",
        summary: "I could not apply that change safely.",
        changes: [],
        validationErrors: [formatValidationError(reason)],
        previewVersion: versions.get(body.session) ?? 0,
        plannerSource,
        modelUsed,
        modelKey
      }, { outcome: "repair_failed", reasonCategory: classifyGuardrailError(reason) })
    }
  }

  const repairedOutcome = await respondFromPlan(repairedPlan, plannerSource, applyMode)
  if (repairedOutcome.done) return repairedOutcome.response
  const repairedReason = repairedOutcome.reason
  ctx.chatTelemetry.push({
    id: chatRequestId,
    at: new Date().toISOString(),
    phase: "result",
    session: body.session,
    requestedSlug,
    effectiveSlug,
    plannerSource,
    modelKey,
    modelUsed,
    promptHash,
    promptExcerpt,
    promptLength: plannerMessage.length,
    outcome: "repair_failed",
    reason: repairedReason.slice(0, 300),
    reasonCategory: "schema_violation",
    ...plannerContextTelemetryFields,
    ...timingFields()
  })
  return {
    code: 400,
    payload: withDebugPayload({
      status: "validation_error",
      summary: "I could not apply that change safely.",
      changes: [],
      validationErrors: [formatValidationError(repairedReason)],
      previewVersion: versions.get(body.session) ?? 0,
      plannerSource,
      modelUsed,
      modelKey
    }, { outcome: "repair_failed", reasonCategory: "schema_violation" })
  }
}
