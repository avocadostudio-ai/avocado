import { randomUUID } from "node:crypto"
import {
  blockManifestSchema,
  type EditPlan,
  type BlockManifest,
  type Operation,
  type PageDoc
} from "@ai-site-editor/shared"
import {
  type ChatPipelineContext,
  type DeferredCreatePageImage,
  GENERATING_IMAGE_PLACEHOLDER,
  SEARCHING_IMAGE_PLACEHOLDER,
  isGeneratingPlaceholder,
  cleanupImagePlaceholders,
  buildPageDirectory,
  isVariationRequestMessage,
  resolveEffectiveSlug,
  throwIfCanceled,
  raceCancel,
  sseWrite,
  sleepMs,
  suppressCancelOnly
} from "./chat-pipeline-shared.js"
import {
  type ChatRequestBody,
  type ChatResult,
  siteCapabilitiesSchema,
  isBatchAddRequest,
  isBlockCatalogQuery,
  isInfoQuery,
  isAdviceQuery,
  adviceResponse,
  isContentQuery,
  isPageListQuery,
  plannerMessageWithPendingContext,
  buildSiteContextBlock,
  infoResponse
} from "../nlp/intent-detection.js"
import {
  type AIProvider,
  type ModelKey,
  type ContinuationChain,
  type ImageSourcePreference,
  type PendingImageGeneration,
  versions,
  pendingClarificationBySession,
  chatHistoryBySession,
  pendingApprovalPlanBySession,
  continuationChainBySession,
  imageSourcePreferenceBySession,
  getSessionDraft,
  getPage,
  setPage,
  pushUndo,
  bumpVersion,
  pushRecentEdit,
  pushVersionEntry,
  pushChatHistory,
  schedulePersistState,
  removePage
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
import { evaluateDestructiveActions } from "../ops/destructive-action-gate.js"
import {
  clarificationSuggestions,
  postEditSuggestions,
  demoPlanFromMessage,
  plannerContextPack,
  compileDeterministicPlan,
  inferDeterministicIntent,
  isHighConfidenceDeterministicCase,
  tryCompoundDeterministicPlan
} from "../nlp/deterministic-planner.js"
import { generatePlanWithOpenAI, isPlannerOutputError, isStrictJsonResponseEnabled, parseIntentWithOpenAI, type PlannerSchemaContextMeta } from "./planner.js"
import { isDemoModeEnabled, splitDemoOps, getDemoAllowedBlockTypes } from "../demo-mode.js"
import { isCancelError as _isCancelError } from "../errors.js"
// `isCancelError` is used directly (without underscore) in runChatPipeline
const isCancelError = _isCancelError
import { isMultiStepCandidate, decomposeRequest } from "./decomposer.js"
import { generatePlanWithAnthropic, parseIntentWithAnthropic, type DeferredNativeImageCall } from "./anthropic-planner.js"
import { generatePlanWithGemini, parseIntentWithGemini } from "./gemini-planner.js"
import { createPlannerRegistry, type ThinkingEvent } from "./planner-types.js"
import { type TokenUsage, estimateUsd } from "../telemetry/usage.js"
import { executeToolCall } from "../tools/runtime.js"
import { detectImageSourceAmbiguity } from "../nlp/intent-helpers.js"

// ---------------------------------------------------------------------------
// Re-exports from extracted modules (for backwards compat with external importers)
// ---------------------------------------------------------------------------
export { sentenceCase, firstUrlFromText, preferredImageAltText, collectMentionedSlugsFromPlan, collectMentionedSlugsFromOps, normalizePlanCopyForUi, futureToPastTense } from "./chat-pipeline-ui.js"
export { sanitizeMessageForPlanning, inferTranslationScopeFromMessage, isNonEmptyString, findFullPageTranslationCoverageGap, findExplicitCtaTargetCoverageGap, type TranslationScope } from "./chat-pipeline-translation.js"
export { shouldPreferFastModelForMessage, shouldUseLlmIntentRouter, compactPlannerContextPack, minimalPlannerContextPack, shouldUseMinimalPlannerContext, shouldPreferFocusedTranslation, shouldEnableReasoningForMessage } from "./chat-pipeline-context.js"
export { isRewriteLikeMessage, isPerformanceAwareMessage, isLikelyTextField, collectChangedTextFields, buildMetaChangeLogEntries, buildAiInsightChanges, buildOpChangeLogEntries, deterministicCreatePagePlan, deterministicDuplicatePagePlan, deterministicSelectedTextRewritePlan, shouldReturnDeterministicClarification, fmtSlug } from "./chat-pipeline-deterministic.js"
export { blockHasImageUrlProp, parsePath, getValueAtPath, setValueAtPath, deleteValueAtPath, extractIndexedQueries, extractReferencedItemIndices, blockSupportsImageAtPath, detectImagePaths, imageQueryFromItem, shouldPopulateAllChildImages, findImageTargets, rewriteAddBlockToChildImageUpdate, withUnsplashHeroImage, shouldResolveCreatePageHeroImage, resolveHeroImageForCreatePage, detectImageOps } from "./chat-pipeline-image.js"
export { type ChatPipelineContext, type DeferredCreatePageImage, GENERATING_IMAGE_PLACEHOLDER, SEARCHING_IMAGE_PLACEHOLDER, isGeneratingPlaceholder, cleanupImagePlaceholders, buildPageDirectory, resolveEffectiveSlug, CancelError, isCancelError, throwIfCanceled, raceCancel, sseWrite, sleepMs, suppressCancelOnly } from "./chat-pipeline-shared.js"

// Internal imports from extracted modules (used by this file)
import { collectMentionedSlugsFromPlan, normalizePlanCopyForUi, futureToPastTense, pastToFutureTense } from "./chat-pipeline-ui.js"
import { sanitizeMessageForPlanning, inferTranslationScopeFromMessage, findFullPageTranslationCoverageGap, findExplicitCtaTargetCoverageGap, type TranslationScope } from "./chat-pipeline-translation.js"
import { shouldPreferFastModelForMessage, shouldUseLlmIntentRouter, compactPlannerContextPack, minimalPlannerContextPack, shouldUseMinimalPlannerContext, shouldPreferFocusedTranslation, classifyMessageComplexity, isRouterPlanTooShallow, shouldEnableReasoningForMessage } from "./chat-pipeline-context.js"
import { buildAiInsightChanges, buildMetaChangeLogEntries, buildOpChangeLogEntries, deterministicCreatePagePlan, deterministicDuplicatePagePlan, deterministicSelectedTextRewritePlan, shouldReturnDeterministicClarification, fmtSlug } from "./chat-pipeline-deterministic.js"
import { getValueAtPath, setValueAtPath, deleteValueAtPath, blockSupportsImageAtPath, detectImageOps, rewriteAddBlockToChildImageUpdate, withUnsplashHeroImage, resolveHeroImageForCreatePage } from "./chat-pipeline-image.js"
import { resolveEffectiveProvider, resolveModelKeyForProvider, resolvePlannerSource } from "./provider-routing.js"
import { runVariationPipeline } from "./variation-pipeline.js"
import { validateAndStripHallucinatedProps } from "./hallucination-validator.js"

/**
 * Parses an image-source chip answer ("Use Unsplash photo", "Generate with AI",
 * "Either's fine — pick for me") and returns the matching preference, or null
 * when the message isn't a chip reply. Matching is loose (plain-text containment)
 * so typed-out variants still resolve.
 */
function parseImageSourceChoiceFromMessage(message: string): ImageSourcePreference | null {
  if (typeof message !== "string") return null
  const normalized = message.toLowerCase().replace(/\s+/g, " ").trim()
  if (!normalized) return null
  // "Either's fine" must take precedence — otherwise a message that mentions
  // both sources ("I'll let you pick between unsplash or AI") would resolve
  // ambiguously.
  if (/\beither\b/.test(normalized) && /\b(fine|pick|choose|you\s+decide)\b/.test(normalized)) return "either"
  if (/\buse\s+unsplash\b/.test(normalized) || /^unsplash(?:\s+photo)?$/.test(normalized)) return "unsplash"
  if (/\bgenerate\s+with\s+ai\b/.test(normalized) || /^(?:ai|ai[-\s]?generated)$/.test(normalized)) return "genai"
  return null
}

/**
 * Appends a source hint token ("unsplash" / "generate image") to the planner
 * message IFF the user's message doesn't already name a source. Avoids
 * contradicting an explicit prompt like "Generate an AI image of X" when the
 * session preference happens to be Unsplash.
 *
 * Exported for unit tests.
 */
export function applyImageSourceHint(
  plannerMessage: string,
  sanitizedMessage: string,
  preference: ImageSourcePreference | undefined
): string {
  if (!preference || preference === "either") return plannerMessage
  const hasExplicit =
    /\b(unsplash|stock\s+photo|stock\s+image|royalty[-\s]?free)\b/i.test(sanitizedMessage) ||
    /\b(generate|generated|ai[-\s]?generated|ai\s+image|ai\s+photo|dall[-\s]?e|midjourney|stable\s+diffusion)\b/i.test(sanitizedMessage) ||
    /\bwith\s+ai\b/i.test(sanitizedMessage)
  if (hasExplicit) return plannerMessage
  if (preference === "unsplash") return `${plannerMessage} unsplash`
  if (preference === "genai") return `${plannerMessage} generate image`
  return plannerMessage
}

/**
 * Image fields that, when they are the ONLY fields touched in an update_props
 * patch, make the op a pure "image update" — safe to auto-apply via the deferred
 * image resolution path (shimmer placeholder → real URL streamed in over SSE).
 *
 * Compound plans or plans that touch text fields alongside images keep the
 * approval gate so the user can still review text copy before it lands.
 */
const IMAGE_ONLY_PATCH_FIELDS = new Set(["imageUrl", "imageAlt", "ogImage", "logoUrl"])

/**
 * True when every op in the plan is an `update_props` whose patch touches
 * only image-related fields (imageUrl/imageAlt/ogImage/logoUrl). Such plans
 * should skip the approval gate — image resolution is deterministic work.
 *
 * Exported for unit tests.
 */
export function isImageOnlyUpdatePropsPlan(plan: EditPlan): boolean {
  if (plan.intent !== "edit_plan") return false
  if (!Array.isArray(plan.ops) || plan.ops.length === 0) return false
  return plan.ops.every((op) => {
    if (op.op !== "update_props") return false
    const rawPatch = op.patch as Record<string, unknown> | undefined
    if (!rawPatch || typeof rawPatch !== "object") return false
    const patch =
      typeof (rawPatch as { props?: unknown }).props === "object" &&
      (rawPatch as { props?: unknown }).props !== null &&
      !Array.isArray((rawPatch as { props?: unknown }).props)
        ? ((rawPatch as { props: Record<string, unknown> }).props)
        : rawPatch
    const keys = Object.keys(patch)
    if (keys.length === 0) return false
    return keys.every((k) => IMAGE_ONLY_PATCH_FIELDS.has(k))
  })
}

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

let generatePlanWithGeminiImpl = generatePlanWithGemini
export function setGeneratePlanWithGeminiForTests(fn?: typeof generatePlanWithGemini) {
  generatePlanWithGeminiImpl = fn ?? generatePlanWithGemini
}

let parseIntentWithGeminiImpl = parseIntentWithGemini
export function setParseIntentWithGeminiForTests(fn?: typeof parseIntentWithGemini) {
  parseIntentWithGeminiImpl = fn ?? parseIntentWithGemini
}

// ---------------------------------------------------------------------------
// Main chat pipeline
// ---------------------------------------------------------------------------

export async function runChatPipeline(
  ctx: ChatPipelineContext,
  body: ChatRequestBody,
  options?: {
    onPlanningToken?: (token: string) => void
    onThinking?: (event: ThinkingEvent) => void
    onFieldDraft?: (event: { blockId: string; editablePath: string; value: string }) => void
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
        ? blockManifestSchema.safeParse(manifestPayload)
        : { success: true as const, data: undefined }
  if (!parsedManifest.success) {
    return { code: 400, payload: { error: "invalid componentsManifest payload" } }
  }
  const componentsManifest: BlockManifest | undefined = parsedManifest.data
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
  let plannerMessage = plannerMessageWithPendingContext(body.session, sanitizedMessage)

  // ---------------------------------------------------------------------------
  // Image source preference (Layer 3): capture the user's choice from a chip
  // answer (if any), then bias downstream image-source detection via a hint
  // token so repeated prompts stop within the same session. The ambiguity
  // challenge itself (returning needs_clarification chips) runs further down
  // once withDebugPayload is in scope.
  // ---------------------------------------------------------------------------
  const capturedImageSourceChoice = parseImageSourceChoiceFromMessage(sanitizedMessage)
  if (capturedImageSourceChoice) {
    imageSourcePreferenceBySession.set(body.session, capturedImageSourceChoice)
  }
  const activeImageSourcePreference: ImageSourcePreference | undefined =
    capturedImageSourceChoice ?? imageSourcePreferenceBySession.get(body.session)
  plannerMessage = applyImageSourceHint(plannerMessage, sanitizedMessage, activeImageSourcePreference)

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
  const parsedSiteContext: Record<string, unknown> = (() => {
    if (!body.siteContext) return {}
    if (typeof body.siteContext === "object") return body.siteContext as Record<string, unknown>
    try { return JSON.parse(body.siteContext) as Record<string, unknown> } catch { return {} }
  })()
  const gdriveFolderId: string | undefined = typeof parsedSiteContext.gdriveFolderId === "string" ? parsedSiteContext.gdriveFolderId.trim() || undefined : undefined
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

  if (ctx.evalCandidates && body.message) {
    const draftMap = getSessionDraft(body.session)
    const fixture = Array.from(draftMap.values()).map((page) => structuredClone(page))
    ctx.evalCandidates.start({
      id: chatRequestId,
      session: body.session,
      slug: effectiveSlug,
      prompt: body.message,
      fixture,
      activeBlockId: planningActiveBlockId,
      activeEditablePath: planningActiveEditablePath
    })
  }

  const requestedProvider = body.provider ?? (ctx.availableProviders[0] as AIProvider | undefined)
  const provider: AIProvider = resolveEffectiveProvider({
    requestedProvider,
    availableProviders: ctx.availableProviders,
    fallbackProvider: ctx.availableProviders[0] ?? "openai"
  })
  const baseModelKey = resolveModelKeyForProvider({
    requestedModelKey: body.modelKey,
    provider,
    modelLookup: ctx.modelLookup,
    defaultModelKey: (process.env.OPENAI_MODEL_KEY as ModelKey | undefined) ?? "balanced"
  })
  const modelKey =
    !body.modelKey &&
    baseModelKey !== "fast" &&
    ctx.modelLookup[provider].fast &&
    shouldPreferFastModelForMessage(plannerMessage)
      ? ("fast" as const)
      : baseModelKey
  const modelUsed = ctx.modelLookup[provider][modelKey]
  const plannerSource = resolvePlannerSource(provider)

  // Auto-escalate to extended thinking for complex/ambiguous Anthropic prompts.
  // Only applies when provider = anthropic (other providers ignore `thinking`).
  // User can disable with CHAT_AUTO_REASONING=0.
  const reasoningAutoEnabled = process.env.CHAT_AUTO_REASONING !== "0"
  const parsedReasoningBudget = Number(process.env.CHAT_AUTO_REASONING_BUDGET ?? 2048)
  const reasoningBudgetTokens = Math.max(
    1024,
    Number.isFinite(parsedReasoningBudget) ? parsedReasoningBudget : 2048
  )
  if (!Number.isFinite(parsedReasoningBudget)) {
    ctx.log.warn({
      event: "reasoning_budget_invalid",
      raw: process.env.CHAT_AUTO_REASONING_BUDGET
    }, "CHAT_AUTO_REASONING_BUDGET is not a number; falling back to 2048")
  }
  const reasoningEnabled =
    reasoningAutoEnabled &&
    plannerSource === "anthropic" &&
    shouldEnableReasoningForMessage(plannerMessage)
  const thinkingConfig = reasoningEnabled ? { budgetTokens: reasoningBudgetTokens } : undefined
  if (reasoningEnabled) {
    ctx.log.info({
      event: "reasoning_auto_enabled",
      model: modelUsed,
      budgetTokens: reasoningBudgetTokens,
      promptLength: plannerMessage.length
    }, "Extended thinking auto-enabled for this request")
  }
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
      emitStatusTone("generating_plan")
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

  type PipelineStatusTone =
    | "analyzing"
    | "planning"
    | "understanding"
    | "breaking_down"
    | "generating_plan"
    | "resolving_assets"
    | "applying"
    | "validating"
    | "repairing"
    | "thinking"

  const pipelineStatusVariants: Record<PipelineStatusTone, readonly string[]> = {
    analyzing: [
      "Analyzing your request...",
      "Reviewing your request...",
      "Looking over your request..."
    ],
    planning: [
      "Planning edits...",
      "Drafting the edit plan...",
      "Mapping out the changes..."
    ],
    understanding: [
      "Understanding your request...",
      "Interpreting your request...",
      "Confirming intent..."
    ],
    breaking_down: [
      "Breaking down your request...",
      "Splitting your request into steps...",
      "Organizing requested changes..."
    ],
    generating_plan: [
      "Generating plan...",
      "Composing edit plan...",
      "Building execution plan..."
    ],
    resolving_assets: [
      "Resolving image assets...",
      "Collecting image assets...",
      "Preparing image assets..."
    ],
    applying: [
      "Applying changes...",
      "Applying edits...",
      "Updating draft..."
    ],
    validating: [
      "Validating plan...",
      "Checking plan integrity...",
      "Reviewing plan safety..."
    ],
    repairing: [
      "Repairing plan and retrying...",
      "Fixing plan details and retrying...",
      "Adjusting plan and trying again..."
    ],
    thinking: [
      "Thinking...",
      "Working through the request...",
      "Refining the plan..."
    ]
  }
  const pipelineStatusCursor = new Map<PipelineStatusTone, number>()
  const emitStatusTone = (tone: PipelineStatusTone) => {
    const variants = pipelineStatusVariants[tone]
    const nextIdx = (pipelineStatusCursor.get(tone) ?? 0) % variants.length
    pipelineStatusCursor.set(tone, nextIdx + 1)
    emitStatus(variants[nextIdx] ?? variants[0] ?? "Working...")
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
      modelUsed,
      plannerSource,
      executionMode,
      currentPage: effectiveSlug,
      siteId: body.siteId || undefined,
      activeBlockId: planningActiveBlockId || undefined,
      activeEditablePath: planningActiveEditablePath || undefined,
      ...(planningAttempts > 1 ? { planningAttempts } : {}),
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

  let current = getPage(body.session, effectiveSlug)
  if (!current) {
    // Allow page-creation requests through by providing an empty stub page
    const looksLikeCreatePage = body.message && /\b(create|add|make|build|generate|new)\b.*\b(page|homepage|landing)\b/i.test(body.message)
    if (!looksLikeCreatePage) return { code: 404, payload: { error: "page not found" } }
    current = { id: effectiveSlug, slug: effectiveSlug, title: "", updatedAt: new Date().toISOString(), blocks: [] }
  }

  // Layer 3: upfront image-source choice. Ask once when the prompt is a
  // generic image intent and both Unsplash + GenAI are configured. Choice is
  // remembered for the session (imageSourcePreferenceBySession) so subsequent
  // prompts skip the question.
  if (!activeImageSourcePreference && body.message) {
    const hasUnsplash = Boolean(process.env.UNSPLASH_ACCESS_KEY?.trim())
    const hasGenAI = Boolean(process.env.OPENAI_API_KEY?.trim() || process.env.GOOGLE_GENAI_API_KEY?.trim())
    if (detectImageSourceAmbiguity(sanitizedMessage, { hasUnsplash, hasGenAI })) {
      pendingClarificationBySession.set(body.session, {
        baseRequest: sanitizedMessage,
        updatedAt: new Date().toISOString()
      })
      return {
        code: 200,
        payload: withDebugPayload({
          status: "needs_clarification",
          summary: "Where should this image come from?",
          changes: [],
          suggestions: [
            "Use Unsplash photo",
            "Generate with AI",
            "Either's fine — pick for me"
          ],
          mentionedSlugs: [effectiveSlug],
          previewVersion: versions.get(body.session) ?? 0,
          plannerSource,
          modelUsed,
          modelKey
        } satisfies ChatResult, { outcome: "needs_clarification", reasonCategory: "ambiguity" })
      }
    }
  }

  // "describe this image" on an image field — return the current image URL and suggest alt text
  if (body.message && /\bdescribe\s+(?:this|the|that)\s+(?:image|photo|picture|icon|logo|illustration)\b/i.test(body.message) && body.activeEditablePath) {
    const isImageField = /(?:imageUrl|image\.?src|\.url)$/i.test(body.activeEditablePath)
    if (isImageField && body.activeBlockId) {
      const block = current.blocks.find((b) => b.id === body.activeBlockId)
      if (block) {
        const imageUrl = getValueAtPath(block.props, body.activeEditablePath)
        const summary = typeof imageUrl === "string" && imageUrl.startsWith("http")
          ? `This image is: ${imageUrl}`
          : "No image URL is currently set for this field."
        return {
          code: 200,
          payload: withDebugPayload({
            status: "info",
            summary,
            changes: [],
            suggestions: [
              "Write alt text for this image",
              "Replace this image",
              "Search for a new image"
            ],
            previewVersion: versions.get(body.session) ?? 0,
            plannerSource,
            modelUsed,
            modelKey
          } satisfies ChatResult, { outcome: "info" })
        }
      }
    }
  }

  if (body.message && isInfoQuery(body.message) && !isBatchAddRequest(body.message)) {
    const info = infoResponse({ body, current, plannerSource, modelUsed, modelKey })
    return { code: info.code, payload: withDebugPayload(info.payload, { outcome: "info" }) }
  }
  if (body.message && isAdviceQuery(body.message) && !isBatchAddRequest(body.message)) {
    const advice = adviceResponse({ body, current, plannerSource, modelUsed, modelKey })
    return { code: advice.code, payload: withDebugPayload(advice.payload, { outcome: "advice" }) }
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
    if (body.activeBlockId) {
      // Route to the dedicated variation pipeline and return its result directly.
      // The editor detects the VariationResult shape (status "ok" + variations array)
      // and opens the variation modal, same as it does for /chat/variations responses.
      const variationResult = await runVariationPipeline(ctx, {
        session: body.session,
        slug: effectiveSlug,
        message: body.message,
        activeBlockId: body.activeBlockId,
        activeBlockType: body.activeBlockType,
        modelKey,
        provider: body.provider,
        sitePurpose: body.sitePurpose,
        siteHosting: body.siteHosting,
        businessContext: body.businessContext,
        siteContext: body.siteContext
      })
      return variationResult as { code: number; payload: ChatResult | { error: string } }
    }
    // No block selected — ask which block
    return {
      code: 200,
      payload: withDebugPayload({
        status: "needs_clarification",
        summary: "Select a block first, then ask for variants.",
        changes: [],
        suggestions: [
          "Click on a block to select it, then try again.",
          "Example: select the Hero block, then say 'generate 3 variations'."
        ],
        previewVersion: versions.get(body.session) ?? 0,
        plannerSource,
        modelUsed,
        modelKey
      } satisfies ChatResult, { outcome: "variation_request_redirect", reasonCategory: "ambiguity" })
    }
  }

  emitStatusTone("analyzing")

  // Content queries (read-only questions about page content) need full props for the LLM
  const contentQuery = body.message ? isContentQuery(body.message) : false

  const contextPack = plannerContextPack({
    session: body.session,
    slug: effectiveSlug,
    message: plannerMessage,
    currentPage: current,
    activeBlockId: planningActiveBlockId,
    activeBlockType: body.activeBlockType,
    activeEditablePath: planningActiveEditablePath,
    includeFullProps: translationScope === "page" || contentQuery
  })
  const compactContextExperimentEnabled = /^(1|true|yes|on)$/i.test((process.env.CHAT_COMPACT_CONTEXT_EXPERIMENT ?? "").trim())
  const minimalContextExperimentEnabled = /^(1|true|yes|on)$/i.test((process.env.CHAT_MINIMAL_CONTEXT_EXPERIMENT ?? "").trim())
  const intentComplexity = !contentQuery
    ? classifyMessageComplexity({
        message: plannerMessage,
        currentPage: current,
        activeBlockId: planningActiveBlockId,
        activeEditablePath: planningActiveEditablePath,
        translationScope
      })
    : ("standard" as const)
  let isLightweightEdit = intentComplexity === "simple"
  const basePlannerContext =
    (compactContextExperimentEnabled || isLightweightEdit)
      ? compactPlannerContextPack({ contextPack, message: plannerMessage, translationScope })
      : contextPack
  const useMinimalPlannerContext = !contentQuery && (minimalContextExperimentEnabled || isLightweightEdit) && shouldUseMinimalPlannerContext({
    message: plannerMessage,
    translationScope,
    activeBlockId: planningActiveBlockId,
    activeEditablePath: planningActiveEditablePath
  })
  let plannerContext =
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

  const guardrailFailureResponse = (args: { reason: string; source: "openai" | "anthropic" | "gemini" | "demo" }) => {
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
  let deferredNativeImageCalls: DeferredNativeImageCall[] = []

  const respondFromPlan = async (
    plan: EditPlan,
    source: "openai" | "anthropic" | "gemini" | "demo",
    applyMode: "apply_now" | "plan_only" = "apply_now",
    optionsOverride?: { preResolvedPlan?: boolean; preApplied?: boolean; undoSnapshot?: PageDoc },
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

      // Strip hallucinated props (planner promising changes to fields the
      // block schema doesn't have — e.g. "colors" on Stats). Appends a note
      // to summary_for_user and change_log so the user isn't misled.
      const hallucinationResult = validateAndStripHallucinatedProps({
        plan: resolvedPlan,
        draft: getSessionDraft(body.session!)
      })
      if (hallucinationResult.hallucinatedProps.length > 0) {
        for (const entry of hallucinationResult.hallucinatedProps) {
          ctx.log.warn(
            {
              event: "planner_hallucinated_prop",
              chatRequestId,
              session: body.session!,
              slug: effectiveSlug,
              blockId: entry.blockId,
              blockType: entry.blockType,
              propName: entry.propName,
              plannerSource: source,
              modelKey,
              modelUsed
            },
            "Planner generated an unsupported prop; stripped before apply"
          )
        }
      }

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
        // Decide whether to hold for approval. Image resolution alone is
        // deterministic background work — if the plan is nothing but image
        // updates, auto-apply and resolve in the background so the user sees
        // "Added a spring avocados image" → shimmer → real image without a
        // redundant "approve" button. Compound plans (structural changes,
        // text updates, multi-op) keep the approval gate.
        const imageOnlyPlan = isImageOnlyUpdatePropsPlan(resolvedPlan)
        if (!imageOnlyPlan) {
          effectiveApplyMode = "plan_only"
        }

        // Strip placeholder imageUrl values from ops so preview shows current image.
        // For approval flow: values are restored to "pending" before withUnsplashHeroImage.
        // For auto-apply flow: the deferred resolution path restores them (see below).
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
          // If stripping left the patch empty, write a shimmer placeholder so
          // applyOpsAtomically doesn't reject the op as a no-op (which aborts
          // the deferred image resolution before it can swap in the real URL).
          if (Object.keys(patchCandidate).length === 0) {
            const primary = imgOps[0]
            const placeholder = primary.provider === "unsplash" ? SEARCHING_IMAGE_PLACEHOLDER : GENERATING_IMAGE_PLACEHOLDER
            if (typeof primary.path === "string" && primary.path.length > 0) {
              setValueAtPath(patchCandidate, primary.path, placeholder)
            } else {
              patchCandidate.imageUrl = placeholder
            }
          }
        }

        // Annotate change_log with image work.
        // Phrasing differs: approval flow uses future tense ("Will ..."),
        // auto-apply uses present tense ("Adding ...") so the summary reads
        // sensibly even though the image arrives a moment later.
        // Per prompt rule (prompts.ts: HERO_IMAGE_URL_BASE) we never mention
        // the image source (Unsplash / AI) in user-facing copy — just "image".
        for (const imgOp of detectedImageOps) {
          const query = imgOp.query && imgOp.query.trim().length > 0 ? imgOp.query.trim() : null
          const subject = query ? `: "${query}"` : ""
          const pendingImageMessage = imageOnlyPlan
            ? `Finding an image${subject}…`
            : `Will find an image${subject}.`
          resolvedPlan.change_log = [...resolvedPlan.change_log, pendingImageMessage]
        }

        if (imageOnlyPlan) {
          // Auto-apply path: tag the plan so the post-apply deferred block
          // resolves the real image and streams it back via onOpApplied.
          ;(resolvedPlan as EditPlan & { _deferredImageResolution?: true })._deferredImageResolution = true
          ;(resolvedPlan as EditPlan & { _deferredImageArgs?: unknown })._deferredImageArgs = {
            message: plannerMessage,
            slug: effectiveSlug,
            currentPage: current,
            activeBlockId: planningActiveBlockId,
            activeEditablePath: planningActiveEditablePath,
            chatRequestId,
            gdriveFolderId,
            preferredImageOps: detectedImageOps
          }

          // Mirror the else-branch's progress markers so the editor gets instant
          // "plan ready" feedback while images resolve in the background.
          options?.onPlanMeta?.({
            intent: resolvedPlan.intent,
            summary: effectiveApplyMode === "plan_only" ? pastToFutureTense(resolvedPlan.summary_for_user) : resolvedPlan.summary_for_user,
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
        }
      } else {
        // Emit plan metadata and progress markers so the UI gets instant feedback
        // while images resolve in the background after ops are applied.
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

        // Defer image resolution: apply text/structural ops immediately, then
        // resolve images in the background and patch them in via follow-up events.
        // This avoids blocking the user for 1-15s while images are fetched/generated.
        const deferImageResolution = !/^(0|false|no|off)$/i.test((process.env.CHAT_DEFER_IMAGE_RESOLUTION ?? "1").trim())
        if (!usedNativeUnsplashTool && !usedNativeImageTool && deferImageResolution) {
          // Tag the plan with deferred image metadata so the apply step can
          // resolve images after text ops are visible.
          ;(resolvedPlan as EditPlan & { _deferredImageResolution?: true })._deferredImageResolution = true
          ;(resolvedPlan as EditPlan & { _deferredImageArgs?: unknown })._deferredImageArgs = {
            message: plannerMessage,
            slug: effectiveSlug,
            currentPage: current,
            activeBlockId: planningActiveBlockId,
            activeEditablePath: planningActiveEditablePath,
            chatRequestId,
            gdriveFolderId
          }
        } else if (!usedNativeUnsplashTool && !usedNativeImageTool) {
          // Legacy blocking path (deferred disabled via env)
          const imageResolutionStartMs = Date.now()
          emitStatusTone("resolving_assets")
          resolvedPlan = await withUnsplashHeroImage({
            plan: resolvedPlan,
            message: plannerMessage,
            slug: effectiveSlug,
            currentPage: current,
            activeBlockId: planningActiveBlockId,
            activeEditablePath: planningActiveEditablePath,
            chatRequestId,
            gdriveFolderId,
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
          activeEditablePath: planningActiveEditablePath,
          locale: body.locale
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

    const explicitCtaCoverageGap = findExplicitCtaTargetCoverageGap({
      plan: resolvedPlan,
      message: plannerMessage,
      currentPage: current,
      slug: effectiveSlug
    })
    if (explicitCtaCoverageGap) return { done: false as const, reason: explicitCtaCoverageGap }

    // Tier-1 destructive-action gate. Hold any edit_plan containing destructive
    // ops (remove_page on a page with content, multi-page scope, bulk deletes)
    // for explicit approval — undo protects recovery but not accidental intent.
    let destructiveReasons: string[] = []
    if (resolvedPlan.intent === "edit_plan" && resolvedPlan.ops.length > 0) {
      const destructiveEval = evaluateDestructiveActions(resolvedPlan, (slug) => getPage(body.session!, slug))
      if (destructiveEval.requiresApproval) {
        effectiveApplyMode = "plan_only"
        destructiveReasons = destructiveEval.messages
      }
    }

    // Emit plan metadata if not already emitted (deferred image path and other branches skip the early emit above)
    if (!stageTimeline.some((item) => item.stage === "first_structured_progress")) {
      options?.onPlanMeta?.({
        intent: resolvedPlan.intent,
        summary: effectiveApplyMode === "plan_only" ? pastToFutureTense(resolvedPlan.summary_for_user) : resolvedPlan.summary_for_user,
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

    if (resolvedPlan.intent === "content_answer") {
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
        outcome: "content_answer",
        intent: resolvedPlan.intent,
        opCount: 0,
        opTypes: [],
        plannerTier,
        ...plannerContextTelemetryFields,
        ...timingFields()
      })
      if (body.message) pushChatHistory(body.session!, body.message, resolvedPlan.summary_for_user)
      return {
        done: true as const,
        response: {
          code: 200,
          payload: withDebugPayload({
            status: "info",
            summary: resolvedPlan.summary_for_user,
            changes: resolvedPlan.change_log,
            mentionedSlugs: collectMentionedSlugsFromPlan(resolvedPlan, effectiveSlug),
            suggestions: resolvedPlan.suggested_next_actions ?? [],
            previewVersion: versions.get(body.session!) ?? 0,
            plannerSource: source,
            modelUsed,
            modelKey
          } satisfies ChatResult, {
            outcome: "content_answer",
            intent: resolvedPlan.intent,
            opCount: 0,
            opTypes: [],
            ...usageFields
          })
        }
      }
    }

    if (resolvedPlan.intent === "needs_clarification") {
      // If the message already had a clarification suffix and still failed, clear the
      // pending context — the clarification chain is not converging and further stacking
      // will only produce incoherent prompts.
      const alreadyHadClarification = plannerMessage.includes("\nClarification from user:")
      if (alreadyHadClarification) {
        pendingClarificationBySession.delete(body.session!)
      } else {
        pendingClarificationBySession.set(body.session!, { baseRequest: plannerMessage, updatedAt: new Date().toISOString() })
      }
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
      // Planner prompts instruct past tense on the assumption ops are applied
      // immediately, but the approval gate holds the plan. Flip to future tense
      // so the copy matches the "Approve plan" UX.
      const approvalSummary = pastToFutureTense(resolvedPlan.summary_for_user)
      const approvalChangeLog = resolvedPlan.change_log.map(pastToFutureTense)
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
        ...(detectedImageOps.length > 0 ? { pendingImageOps: detectedImageOps } : {}),
        ...(destructiveReasons.length > 0 ? { destructiveReasons } : {})
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
            summary: approvalSummary,
            changes: approvalChangeLog,
            mentionedSlugs: collectMentionedSlugsFromPlan(resolvedPlan, effectiveSlug),
            previewVersion: versions.get(body.session!) ?? 0,
            plannerSource: source,
            modelUsed,
            modelKey,
            pendingPlanId,
            ...(destructiveReasons.length > 0 ? { destructiveReasons } : {})
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
    const hasCreatePage = resolvedPlan.ops.some((op) => op.op === "create_page")
    if (!previous && !hasCreatePage) {
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
          } satisfies ChatResult, { outcome: "no_effective_change", plannerTier })
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
            changes: ["Expose GET /api/editor/blocks with a valid manifest to enable structural operations."],
            mentionedSlugs: [effectiveSlug],
            previewVersion: versions.get(body.session!) ?? 0,
            plannerSource: source,
            modelUsed,
            modelKey
          } satisfies ChatResult, { outcome: "blocked_structural_capability" })
        }
      }
    }

    // Demo-mode guard: returns a friendly "needs_clarification" before we
    // hit the ops-engine hard gate. The engine gate still runs as a safety
    // net (`enforceDemoOps` in ops-engine.ts) — this one exists purely for
    // UX so the user sees an example prompt instead of a generic error.
    if (isDemoModeEnabled()) {
      const stagedForDemo = new Map<string, PageDoc>()
      for (const [slug, page] of getSessionDraft(body.session!)) {
        stagedForDemo.set(slug, page)
      }
      const demoSplit = splitDemoOps(resolvedPlan.ops, stagedForDemo)
      if (demoSplit.rejected.length > 0) {
        const allowedBlockLabel = getDemoAllowedBlockTypes().join(" / ")
        return {
          done: true as const,
          response: {
            code: 200,
            payload: withDebugPayload({
              status: "needs_clarification",
              summary: `This demo only supports editing the ${allowedBlockLabel} section. Try a hero-focused request — everything else is locked for now.`,
              changes: [
                "Try: \"change the hero headline to Welcome to my new site\"",
                "Try: \"make the hero subheading sound more playful\"",
                "Try: \"update the hero CTA to Get Started\""
              ],
              mentionedSlugs: [effectiveSlug],
              previewVersion: versions.get(body.session!) ?? 0,
              plannerSource: source,
              modelUsed,
              modelKey
            } satisfies ChatResult, { outcome: "blocked_demo_mode" })
          }
        }
      }
    }

    let applyStartedAtMs: number | null = null
    let skippedOps: SkippedOperation[] = []

    // When ops were already applied incrementally during LLM streaming (preApplied),
    // skip the validation/apply step and go straight to post-apply bookkeeping.
    const skipApply = Boolean(optionsOverride?.preApplied)

    try {
      if (!skipApply) {
      // Validate ops against the canonical Zod schema at the NLP → ops-engine
      // boundary. Post-planner transforms (image rewriting, UI normalization)
      // could theoretically produce malformed ops; this catches them early.
      validateOperations(resolvedPlan.ops)

      emitStatusTone("applying")
      applyStartedAtMs = Date.now()
      const hasPageStructuralOps = resolvedPlan.ops.some(
        (op) => op.op === "create_page" || op.op === "rename_page" || op.op === "remove_page" || op.op === "move_page" || op.op === "duplicate_page"
      )
      if (incrementalApplyEnabled && options?.onOpApplied && !hasPageStructuralOps) {
        // Snapshot the entire session draft so we can restore it wholesale after preflight.
        const sessionDraft = getSessionDraft(body.session!)
        const preFlightSnapshot = new Map<string, PageDoc>()
        for (const [slug, page] of sessionDraft) {
          preFlightSnapshot.set(slug, structuredClone(page))
        }

        // Validate the whole plan from the current state before progressive apply.
        const preflight = await applyOpsAtomically(body.session!, resolvedPlan.ops, { componentsManifest })
        skippedOps = preflight.skippedOps

        // Restore pre-apply state wholesale so we can replay ops progressively.
        sessionDraft.clear()
        for (const [slug, page] of preFlightSnapshot) {
          setPage(body.session!, structuredClone(page))
        }

        const total = resolvedPlan.ops.length
        try {
          for (let index = 0; index < total; index += 1) {
            throwIfCanceled(options?.signal)
            const stepStartedAtMs = Date.now()
            const op = resolvedPlan.ops[index]
            const stepResult = await applyOpsAtomically(body.session!, [op], { componentsManifest })
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
          sessionDraft.clear()
          for (const [slug, page] of preFlightSnapshot) {
            setPage(body.session!, structuredClone(page))
          }
          options?.onRollbackDone?.({ restoredVersion: versions.get(body.session!) ?? 0 })
          throw progressiveError
        }
      } else {
        const applyResult = await applyOpsAtomically(body.session!, resolvedPlan.ops, { componentsManifest })
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
                gdriveFolderId,
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
                await applyOpsAtomically(body.session!, [patchOp], { componentsManifest })
                const patchVersion = bumpVersion(body.session!)
                options.onOpApplied({
                  index: 1,
                  total: 1,
                  op: patchOp,
                  previewVersion: patchVersion,
                  focusBlockId: deferred.blockId
                })
                const deferredBlockType = getPage(body.session!, deferred.pageSlug)?.blocks?.find((b) => b.id === deferred.blockId)?.type ?? "block"
                resolvedPlan.change_log = [...resolvedPlan.change_log, `Generated AI image for ${deferredBlockType} on ${fmtSlug(deferred.pageSlug)}`]
                ctx.log.info(
                  { event: "deferred_hero_image_resolved", chatRequestId, pageSlug: deferred.pageSlug, blockId: deferred.blockId, source: imageResult.source, durationMs: deferredImageDurationMs },
                  `Deferred hero image resolved and applied in ${deferredImageDurationMs}ms`
                )
              }
            } catch (err) {
              cleanupImagePlaceholders(body.session!)
              if (isCancelError(err)) throw err
              ctx.log.warn(
                { event: "deferred_hero_image_failed", chatRequestId, pageSlug: deferred.pageSlug, blockId: deferred.blockId, error: toErrorDetail(err) },
                "Deferred hero image resolution failed — page remains with placeholder"
              )
              options?.onStatusUpdate?.("Image generation failed — you can try again or set an image manually.")
            }
          }
        }
      }

      // Deferred image resolution for non-create_page ops: resolve images after
      // text/structural ops are already visible in the preview, then patch them in.
      const deferredImageArgs = (resolvedPlan as EditPlan & { _deferredImageResolution?: boolean; _deferredImageArgs?: {
        message: string; slug: string; currentPage: PageDoc; activeBlockId?: string; activeEditablePath?: string; chatRequestId: string; gdriveFolderId?: string; preferredImageOps?: PendingImageGeneration[]
      } })._deferredImageArgs
      if ((resolvedPlan as EditPlan & { _deferredImageResolution?: boolean })._deferredImageResolution && deferredImageArgs && options?.onOpApplied && deferredNativeImageCalls.length === 0) {
        try {
          const imageResolutionStartMs = Date.now()
          emitStatusTone("resolving_assets")

          const preferredImageOps = deferredImageArgs.preferredImageOps ?? []

          // When auto-apply runs for an image-only plan, the original patches
          // had their imageUrl/imageAlt stripped. Apply shimmer placeholders
          // so the preview shows "Searching…" / "Generating…" while we resolve.
          // This mirrors the approval-flow UX in chat-pipeline.ts (pending plan block).
          if (preferredImageOps.length > 0) {
            const shimmerOps: Operation[] = preferredImageOps.map((imgOp) => {
              const placeholder = imgOp.provider === "unsplash" ? SEARCHING_IMAGE_PLACEHOLDER : GENERATING_IMAGE_PLACEHOLDER
              const patchProps: Record<string, unknown> = {}
              if (typeof imgOp.path === "string" && imgOp.path.length > 0) {
                setValueAtPath(patchProps, imgOp.path, placeholder)
              } else {
                patchProps.imageUrl = placeholder
              }
              return { op: "update_props" as const, pageSlug: imgOp.pageSlug, blockId: imgOp.blockId, patch: { props: patchProps } }
            })
            try {
              await applyOpsAtomically(body.session!, shimmerOps, { componentsManifest })
              const shimmerVersion = bumpVersion(body.session!)
              const firstShimmer = shimmerOps[0]
              options.onOpApplied({
                index: 1,
                total: 1,
                op: firstShimmer,
                previewVersion: shimmerVersion,
                focusBlockId: firstShimmer.op === "update_props" ? firstShimmer.blockId : undefined
              })
            } catch (shimmerErr) {
              ctx.log.debug(
                { event: "deferred_image_shimmer_failed", chatRequestId, error: toErrorDetail(shimmerErr) },
                "Shimmer placeholder injection failed; continuing with resolution"
              )
            }
          }

          // Restore "pending" imageUrl/imageAlt into ops whose patch was stripped,
          // so withUnsplashHeroImage's `hasImageUrlInPatch` check passes and image
          // resolution actually runs for these ops.
          const planForResolve = structuredClone(resolvedPlan) as EditPlan
          for (const imgOp of preferredImageOps) {
            const op = planForResolve.ops.find(
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

          const resolvedImagePlan = await raceCancel(withUnsplashHeroImage({
            plan: preferredImageOps.length > 0 ? planForResolve : resolvedPlan,
            message: deferredImageArgs.message,
            slug: deferredImageArgs.slug,
            currentPage: deferredImageArgs.currentPage,
            preferredImageOps: preferredImageOps.length > 0 ? preferredImageOps : undefined,
            activeBlockId: deferredImageArgs.activeBlockId,
            activeEditablePath: deferredImageArgs.activeEditablePath,
            chatRequestId: deferredImageArgs.chatRequestId,
            gdriveFolderId: deferredImageArgs.gdriveFolderId,
            log: ctx.log,
            onStatusUpdate: options?.onStatusUpdate,
            onImageProgress: options?.onImageProgress
          }), options?.signal)
          imageResolutionDurationMs += Date.now() - imageResolutionStartMs

          // Find image-bearing ops that changed between the original and resolved plan
          for (const resolvedOp of resolvedImagePlan.ops) {
            if (resolvedOp.op !== "update_props") continue
            const origOp = resolvedPlan.ops.find((o) => o.op === "update_props" && o.blockId === resolvedOp.blockId && o.pageSlug === resolvedOp.pageSlug)
            const resolvedPatch = resolvedOp.patch as Record<string, unknown>
            const origPatch = origOp && origOp.op === "update_props" ? (origOp.patch as Record<string, unknown>) : {}
            const resolvedProps = (typeof resolvedPatch.props === "object" && resolvedPatch.props !== null && !Array.isArray(resolvedPatch.props))
              ? resolvedPatch.props as Record<string, unknown> : resolvedPatch
            const origProps = (typeof origPatch.props === "object" && origPatch.props !== null && !Array.isArray(origPatch.props))
              ? origPatch.props as Record<string, unknown> : origPatch
            const imageUrl = resolvedProps.imageUrl
            if (typeof imageUrl === "string" && imageUrl.length > 0 && imageUrl !== origProps.imageUrl) {
              const patchOp: Operation = {
                op: "update_props",
                pageSlug: resolvedOp.pageSlug,
                blockId: resolvedOp.blockId,
                patch: {
                  props: {
                    imageUrl,
                    ...(typeof resolvedProps.imageAlt === "string" ? { imageAlt: resolvedProps.imageAlt } : {})
                  }
                }
              }
              await applyOpsAtomically(body.session!, [patchOp], { componentsManifest })
              const patchVersion = bumpVersion(body.session!)
              options.onOpApplied({
                index: 1,
                total: 1,
                op: patchOp,
                previewVersion: patchVersion,
                focusBlockId: resolvedOp.blockId
              })
              const resolvedBlockType = getPage(body.session!, resolvedOp.pageSlug)?.blocks?.find((b) => b.id === resolvedOp.blockId)?.type ?? "block"
              resolvedPlan.change_log = [...resolvedPlan.change_log, `Resolved image for ${resolvedBlockType} on ${fmtSlug(resolvedOp.pageSlug)}`]
            }
          }
        } catch (deferredErr) {
          cleanupImagePlaceholders(body.session!)
          if (isCancelError(deferredErr)) throw deferredErr
          ctx.log.warn(
            { event: "deferred_image_resolution_failed", chatRequestId, error: toErrorDetail(deferredErr) },
            "Deferred image resolution failed — preview remains without images"
          )
          options?.onStatusUpdate?.("Image resolution failed — you can try again or set images manually.")
        }
      }

      // Deferred native image tool execution: the LLM called image.generate or
      // unsplash.search during planning, but we returned placeholders to unblock
      // text streaming. Now execute the real tools and patch results into the preview.
      if (deferredNativeImageCalls.length > 0 && options?.onOpApplied) {
        // Helper: clear shimmer placeholders left behind by a failed deferred
        // tool call so the UI doesn't get stuck on "Generating image…".
        const emitPlaceholderClearPatches = async (reason: string) => {
          for (const op of resolvedPlan.ops) {
            if (op.op !== "update_props") continue
            const patch = op.patch as Record<string, unknown>
            const props = (typeof patch.props === "object" && patch.props !== null && !Array.isArray(patch.props))
              ? patch.props as Record<string, unknown>
              : patch
            if (!isGeneratingPlaceholder(String(props.imageUrl ?? ""))) continue
            const clearOp: Operation = {
              op: "update_props",
              pageSlug: op.pageSlug,
              blockId: op.blockId,
              patch: { props: { imageUrl: "" } }
            }
            try {
              await applyOpsAtomically(body.session!, [clearOp], { componentsManifest })
              const clearVersion = bumpVersion(body.session!)
              options.onOpApplied!({
                index: 1,
                total: 1,
                op: clearOp,
                previewVersion: clearVersion,
                focusBlockId: op.blockId
              })
            } catch (clearErr) {
              ctx.log.warn(
                { event: "deferred_native_image_clear_failed", reason, chatRequestId, error: toErrorDetail(clearErr) },
                "Failed to clear shimmer placeholder after deferred image tool failure"
              )
            }
          }
          // Also clear any stray placeholders still in session state (e.g. nested in arrays)
          cleanupImagePlaceholders(body.session!)
        }

        try {
          const imageResolutionStartMs = Date.now()
          emitStatusTone("resolving_assets")

          for (const deferred of deferredNativeImageCalls) {
            try {
              const result = await raceCancel(executeToolCall({
                runtime: ctx.toolRuntime,
                toolName: deferred.toolName,
                input: deferred.input,
                context: {
                  siteId: body.siteId ?? "default",
                  sessionId: body.session ?? "dev",
                  traceId: chatRequestId,
                  plannerProvider: "anthropic",
                  onStatusUpdate: options?.onStatusUpdate,
                  onImageProgress: options?.onImageProgress
                },
                policy: ctx.toolRuntime?.defaultPolicy
              }), options?.signal)

              if (!result.ok) {
                ctx.log.warn(
                  { event: "deferred_native_image_tool_error", toolName: deferred.toolName, chatRequestId, errorCode: result.error?.code, errorMessage: result.error?.message },
                  `Deferred ${deferred.toolName} returned error — clearing placeholder`
                )
                options?.onStatusUpdate?.("Image generation failed — you can try again or set images manually.")
                await emitPlaceholderClearPatches("tool_error")
                continue
              }

              // Extract the real imageUrl from the tool result
              const data = result.data as Record<string, unknown>
              const realImageUrl = deferred.toolName === "image.generate"
                ? (data.imageUrl as string | undefined)
                : ((data.items as Array<{ imageUrl?: string }> | undefined)?.[0]?.imageUrl)
              if (!realImageUrl) {
                ctx.log.warn(
                  { event: "deferred_native_image_empty_result", toolName: deferred.toolName, chatRequestId },
                  `Deferred ${deferred.toolName} returned no imageUrl — clearing placeholder`
                )
                await emitPlaceholderClearPatches("empty_result")
                continue
              }

              const realAlt = deferred.toolName === "image.generate"
                ? (data.alt as string | undefined)
                : ((data.items as Array<{ alt?: string }> | undefined)?.[0]?.alt)

              // Find ops that used the placeholder URL and patch the real image in
              for (const op of resolvedPlan.ops) {
                if (op.op !== "update_props") continue
                const patch = op.patch as Record<string, unknown>
                const props = (typeof patch.props === "object" && patch.props !== null && !Array.isArray(patch.props))
                  ? patch.props as Record<string, unknown>
                  : patch
                if (isGeneratingPlaceholder(String(props.imageUrl ?? ""))) {
                  const patchOp: Operation = {
                    op: "update_props",
                    pageSlug: op.pageSlug,
                    blockId: op.blockId,
                    patch: {
                      props: {
                        imageUrl: realImageUrl,
                        ...(realAlt ? { imageAlt: realAlt } : {})
                      }
                    }
                  }
                  await applyOpsAtomically(body.session!, [patchOp], { componentsManifest })
                  const patchVersion = bumpVersion(body.session!)
                  options.onOpApplied({
                    index: 1,
                    total: 1,
                    op: patchOp,
                    previewVersion: patchVersion,
                    focusBlockId: op.blockId
                  })
                  const nativeBlockType = getPage(body.session!, op.pageSlug)?.blocks?.find((b) => b.id === op.blockId)?.type ?? "block"
                  resolvedPlan.change_log = [...resolvedPlan.change_log, `Generated image for ${nativeBlockType} on ${fmtSlug(op.pageSlug)}`]
                }
              }
            } catch (singleErr) {
              if (isCancelError(singleErr)) throw singleErr
              ctx.log.warn(
                { event: "deferred_native_image_failed", toolName: deferred.toolName, chatRequestId, error: toErrorDetail(singleErr) },
                `Deferred ${deferred.toolName} failed — clearing placeholder`
              )
              options?.onStatusUpdate?.("Image generation failed — you can try again or set images manually.")
              await emitPlaceholderClearPatches("exception")
            }
          }
          imageResolutionDurationMs += Date.now() - imageResolutionStartMs
        } catch (deferredErr) {
          if (isCancelError(deferredErr)) throw deferredErr
          ctx.log.warn(
            { event: "deferred_native_image_resolution_failed", chatRequestId, error: toErrorDetail(deferredErr) },
            "Deferred native image resolution failed"
          )
          options?.onStatusUpdate?.("Image generation failed — you can try again or set images manually.")
          await emitPlaceholderClearPatches("outer_exception")
        }
      }

      } // end if (!skipApply)

      const undoSnapshot = skipApply && optionsOverride?.undoSnapshot
        ? optionsOverride.undoSnapshot
        : previous
      // For create_page: push null under the new page's slug (undo = delete it).
      // For remove_page: previous was captured before apply, push it under effectiveSlug.
      // For normal edits: push previous under effectiveSlug.
      // undoTargetSlug tracks where the undo snapshot lives so the editor sends the right slug.
      let undoTargetSlug = effectiveSlug
      if (hasCreatePage) {
        for (const op of resolvedPlan.ops) {
          if (op.op === "create_page") {
            pushUndo(body.session!, op.page.slug, null)
            undoTargetSlug = op.page.slug
          }
        }
      } else {
        pushUndo(body.session!, effectiveSlug, undoSnapshot)
      }
      pendingClarificationBySession.delete(body.session!)
      pendingApprovalPlanBySession.delete(body.session!)
      const planUpdatedSlug = pickUpdatedSlug(body.session!, effectiveSlug, resolvedPlan.ops)
      const updatedSlug = planUpdatedSlug ?? (effectiveSlug !== requestedSlug ? effectiveSlug : undefined)
      pushRecentEdit(body.session!, { slug: updatedSlug ?? effectiveSlug, summary: futureToPastTense(resolvedPlan.summary_for_user), ops: resolvedPlan.ops })
      if (body.message) pushChatHistory(body.session!, body.message, futureToPastTense(resolvedPlan.summary_for_user))
      const previewVersion = options?.onOpApplied ? (versions.get(body.session!) ?? 0) : bumpVersion(body.session!)
      const versionEntrySlug = updatedSlug ?? effectiveSlug
      const versionSnapshot = getPage(body.session!, versionEntrySlug)
      pushVersionEntry(body.session!, {
        version: previewVersion,
        slug: versionEntrySlug,
        summary: futureToPastTense(resolvedPlan.summary_for_user),
        opTypes: resolvedPlan.ops.map((op) => op.op),
        opCount: resolvedPlan.ops.length,
        source: "chat",
        snapshot: versionSnapshot ? structuredClone(versionSnapshot) : null
      })
      schedulePersistState(ctx.log)
      const focusBlockId = pickFocusBlockId(resolvedPlan.ops)
      const aiInsightChanges = buildAiInsightChanges({ plan: resolvedPlan, message: plannerMessage })
      const metaChangeLogEntries = buildMetaChangeLogEntries(resolvedPlan.ops)
      const opChangeLogEntries = buildOpChangeLogEntries(resolvedPlan.ops, {
        getBlockType: (slug, blockId) => {
          const page = getPage(body.session!, slug)
          return page?.blocks?.find((b) => b.id === blockId)?.type
        }
      })
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
            changes: [...opChangeLogEntries, ...metaChangeLogEntries, ...aiInsightChanges, ...skippedSummary],
            mentionedSlugs: collectMentionedSlugsFromPlan(resolvedPlan, updatedSlug ?? effectiveSlug),
            suggestions: resolvedPlan.suggested_next_actions ?? postEditSuggestions({ plan: resolvedPlan, current, body }),
            previewVersion,
            focusBlockId,
            updatedSlug,
            undoSlug: undoTargetSlug,
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
            plannerTier,
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
            } satisfies ChatResult, { outcome: "no_effective_change", plannerTier })
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
        emitStatusTone("resolving_assets")
        const imageMessage = pending.originalMessage ?? (typeof body.message === "string" ? body.message : "")
        const planClone = structuredClone(approvalPlan)

        // Show shimmer placeholders in the live preview while images are being generated.
        const placeholderOps: Operation[] = pending.pendingImageOps.map((imgOp) => {
          const placeholder = imgOp.provider === "unsplash" ? SEARCHING_IMAGE_PLACEHOLDER : GENERATING_IMAGE_PLACEHOLDER
          const patchProps: Record<string, unknown> = {}
          if (typeof imgOp.path === "string" && imgOp.path.length > 0) {
            setValueAtPath(patchProps, imgOp.path, placeholder)
          } else {
            patchProps.imageUrl = placeholder
          }
          return { op: "update_props" as const, pageSlug: imgOp.pageSlug, blockId: imgOp.blockId, patch: { props: patchProps } }
        })
        try {
          await applyOpsAtomically(body.session!, placeholderOps, { componentsManifest })
          const ver = versions.get(body.session) ?? 0
          options?.onOpApplied?.({ index: 0, total: placeholderOps.length, op: placeholderOps[0], previewVersion: ver })
        } catch (e) {
          ctx.log.debug({ error: e instanceof Error ? e.message : String(e) }, "Shimmer placeholder injection failed, continuing")
        }

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
          gdriveFolderId,
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
  emitStatusTone("planning")
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

  // Deterministic selected-text rewrite disabled — let AI planner handle creative rewrites.

  const forcedCreatePlan = deterministicCreatePagePlan({ session: body.session, message: plannerMessage, hasPageTemplates: !!siteContextBlock?.includes("Page templates:\n") })
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
      emitStatusTone("planning")
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
        }, { outcome: "planner_exception", reasonCategory: classifyGuardrailError(reason), reason: reason.slice(0, 300), plannerTier: "demo" })
      }
    }
  }

  const isHighConfidence = !contentQuery && isHighConfidenceDeterministicCase({
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
      emitStatusTone("planning")
      const deterministicPlan = compileDeterministicPlan({
        session: body.session,
        intent: deterministicIntent,
        message: plannerMessage,
        slug: effectiveSlug,
        currentPage: current,
        activeBlockId: planningActiveBlockId,
        activeEditablePath: planningActiveEditablePath,
        locale: body.locale
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

  // --- Compound deterministic decomposition ---
  // When a single deterministic check fails due to compound actions
  // ("remove the hero and add a CTA"), try decomposing into sub-intents.
  if (!contentQuery && !isHighConfidence) {
    const compoundPlan = tryCompoundDeterministicPlan({
      session: body.session,
      message: plannerMessage,
      slug: effectiveSlug,
      currentPage: current,
      activeBlockId: planningActiveBlockId,
      activeEditablePath: planningActiveEditablePath
    })
    if (compoundPlan?.intent === "edit_plan" && compoundPlan.ops.length > 0) {
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
        outcome: "compound_deterministic_plan_ready",
        intent: compoundPlan.intent,
        opCount: compoundPlan.ops.length,
        opTypes: compoundPlan.ops.map((op) => op.op),
        plannerTier: "deterministic"
      })
      const compoundOutcome = await respondFromPlan(compoundPlan, plannerSource, applyMode, undefined, "deterministic")
      if (compoundOutcome.done) return compoundOutcome.response
    }
  }

  const llmIntentRouterEnabled = !/^(0|false|no|off)$/i.test((process.env.CHAT_LLM_INTENT_ROUTER ?? "1").trim())
  // Skip the intent router for batch-add requests — the router's deterministic
  // compile can't generate meaningful content for "add 3 blocks" without specific
  // block types, so go straight to the full planner which can handle it.
  const batchAddSkipsRouter = isBatchAddRequest(plannerMessage)
  const shouldTryLlmIntentRouter =
    !contentQuery &&
    !batchAddSkipsRouter &&
    llmIntentRouterEnabled &&
    shouldUseLlmIntentRouter(plannerMessage) &&
    (plannerSource === "openai" || plannerSource === "anthropic" || plannerSource === "gemini")

  // --- Parallel intent router + full planner ---
  // When intent routing is enabled, launch both the fast intent router and the
  // full planner concurrently. The router gets a ~200ms head start. If it succeeds
  // and produces a valid plan, we abort the full planner and return immediately.
  // If it fails, the full planner is already running — no wasted time.
  const parallelPlannerEnabled = !/^(0|false|no|off)$/i.test((process.env.CHAT_PARALLEL_PLANNER ?? "1").trim())
  const routerHeadStartMs = Math.max(0, Math.min(Number(process.env.CHAT_ROUTER_HEAD_START_MS ?? 200), 1000))

  // Request-scoped registry. Closures over *Impl vars so test hooks
  // (setGeneratePlanWith*ForTests) still take effect.
  const plannerRegistry = createPlannerRegistry({
    openai: {
      source: "openai",
      supportsNativeTools: false,
      parseIntent: (a) => {
        const { log: _log, ...rest } = a
        return parseIntentWithOpenAIImpl(rest)
      },
      generatePlan: (a) => {
        const { onStatusUpdate: _s, onImageProgress: _i, log: _l, ...rest } = a
        return generatePlanWithOpenAIImpl(rest)
      },
    },
    anthropic: {
      source: "anthropic",
      supportsNativeTools: true,
      parseIntent: (a) => parseIntentWithAnthropicImpl(a),
      generatePlan: (a) => generatePlanWithAnthropicImpl(a),
    },
    gemini: {
      source: "gemini",
      supportsNativeTools: true,
      parseIntent: (a) => parseIntentWithGeminiImpl(a),
      generatePlan: (a) => generatePlanWithGeminiImpl(a),
    },
  })
  // `plannerSource === "demo"` is handled earlier; here it's always a real planner.
  const planner = plannerRegistry.get(plannerSource)!
  const supportsNativeTools = planner.supportsNativeTools
  const generatePlanImpl = planner.generatePlan
  const maxPlanningAttempts = 3
  let initialPlan: EditPlan | null = null
  let routerDetectedInfo = false
  const planningErrors: string[] = []

  if (shouldTryLlmIntentRouter && parallelPlannerEnabled) {
    const routerModel =
      ctx.modelLookup[provider]?.fast ??
      ctx.modelLookup[provider]?.balanced ??
      modelUsed

    // AbortController for the full planner — allows router success to cancel it
    const fullPlannerAbort = new AbortController()
    const combinedSignal = options?.signal
      ? AbortSignal.any([options.signal, fullPlannerAbort.signal])
      : fullPlannerAbort.signal

    // Track router completion for complexity downgrade
    let routerComplexity: "simple" | "standard" | null = null

    // Intent router promise
    emitStatusTone("understanding")
    const routerPromise = (async () => {
      const routedIntent = await planner.parseIntent({
        message: plannerMessage,
        slug: effectiveSlug,
        currentPage: current,
        activeBlockId: planningActiveBlockId,
        activeBlockType: body.activeBlockType,
        activeEditablePath: planningActiveEditablePath,
        model: routerModel,
        log: ctx.log
      })

      const routedPlan = compileDeterministicPlan({
        session: body.session!,
        intent: routedIntent,
        message: plannerMessage,
        slug: effectiveSlug,
        currentPage: current,
        activeBlockId: planningActiveBlockId,
        activeEditablePath: planningActiveEditablePath,
        locale: body.locale
      })

      routerComplexity = routedIntent.complexity ?? null
      if (routedIntent.action === "info") {
        routerDetectedInfo = true
      }

      if (routedPlan?.intent === "edit_plan" && routedPlan.ops.length > 0) {
        return { plan: routedPlan, outcome: "llm_router_plan_ready" as const }
      }
      if (routedPlan?.intent === "needs_clarification" && shouldReturnDeterministicClarification(plannerMessage)) {
        return { plan: routedPlan, outcome: "llm_router_needs_clarification" as const }
      }
      return null // Router didn't produce a usable result
    })()

    // Full planner promise — starts after head-start delay.
    // When the regex heuristic already suspects a simple edit, we await the
    // router fully (adds ~200-500ms) to get the LLM complexity signal — worth
    // it because the fast model saves 5-10s on the main plan.
    // Exception: if the model is already "fast" (heuristic already selected it),
    // skip the await — the router can't downgrade further.
    const likelySimple = shouldPreferFastModelForMessage(plannerMessage)
    const alreadyFastModel = modelKey === "fast"

    const fullPlannerPromise = (async () => {
      if (likelySimple && !alreadyFastModel) {
        // Await the router to get its complexity verdict before choosing model
        try { await routerPromise } catch { /* router failure is non-fatal */ }
      } else if (routerHeadStartMs > 0) {
        throwIfCanceled(combinedSignal)
        await sleepMs(routerHeadStartMs)
      }
      throwIfCanceled(combinedSignal)

      // Use router's complexity signal to downgrade model when appropriate
      let plannerModel = modelUsed
      if (routerComplexity === "simple" && ctx.modelLookup[provider]?.fast) {
        plannerModel = ctx.modelLookup[provider].fast
        ctx.log.info({ event: "complexity_downgrade", from: modelUsed, to: plannerModel }, "Router signaled simple — downgrading planner to fast model")
      }

      markPlanningStart()
      emitStatusTone("thinking")
      const result = await raceCancel(generatePlanImpl({
        message: plannerMessage,
        slug: effectiveSlug,
        currentPage: current,
        contextPack: plannerContext,
        model: plannerModel,
        locale: body.locale,
        history: isLightweightEdit ? [] : sessionChatHistory,
        siteContextBlock: isLightweightEdit ? undefined : siteContextBlock,
        toolRuntime: supportsNativeTools && !isLightweightEdit ? ctx.toolRuntime : undefined,
        toolCallContext: supportsNativeTools && !isLightweightEdit
          ? {
              siteId: body.siteId ?? "default",
              sessionId: body.session ?? "dev",
              traceId: chatRequestId,
              gdriveFolderId
            }
          : undefined,
        onStatusUpdate: options?.onStatusUpdate,
        onImageProgress: options?.onImageProgress,
        onToolExecution: supportsNativeTools && !isLightweightEdit
          ? (event) => {
              if (event.ok && !event.deferred && event.toolName === "unsplash.search") usedNativeUnsplashTool = true
              if (event.ok && !event.deferred && event.toolName === "image.generate") usedNativeImageTool = true
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
        onThinking: options?.onThinking,
        onFieldDraft: options?.onFieldDraft,
        onSummaryChunk: options?.onSummaryChunk,
        onChangeLogEntry: options?.onChangeLogEntry,
        onPlannedOp: incrementalPlanStreamEnabled
          ? (op, index) => {
              markFirstStructuredProgress()
              options?.onPlannedOp?.({ op, index })
            }
          : undefined,
        componentsManifest,
        lightweight: routerComplexity === "simple" || likelySimple,
        signal: combinedSignal,
        // Disable thinking on router-downgraded simple plans — thinking only makes
        // sense on the full planner path.
        thinking: routerComplexity === "simple" ? undefined : thinkingConfig
      }), combinedSignal)
      return result
    })()

    // Helper to extract plan result from the full planner promise
    const consumeFullPlannerResult = (plannerResult: { plan: EditPlan; usage: TokenUsage; schemaContext: PlannerSchemaContextMeta; deferredNativeImageCalls?: DeferredNativeImageCall[] }) => {
      initialPlan = plannerResult.plan
      planUsage = plannerResult.usage
      if (plannerResult.deferredNativeImageCalls?.length) {
        deferredNativeImageCalls = plannerResult.deferredNativeImageCalls
      }
      if (plannerResult.schemaContext) {
        plannerContextTelemetryFields.contractMode = plannerResult.schemaContext.contractMode
        plannerContextTelemetryFields.contractBytes = plannerResult.schemaContext.contractBytes
        plannerContextTelemetryFields.contractBlockCount = plannerResult.schemaContext.contractBlockCount
        plannerContextTelemetryFields.strictJsonEnabled = plannerResult.schemaContext.strictJsonEnabled
      }
      markPlanningFinish()
      emitStatusTone("validating")
    }

    // Race: router vs full planner
    try {
      const routerResult = await Promise.race([
        routerPromise.then((r) => ({ source: "router" as const, result: r })),
        fullPlannerPromise.then((r) => ({ source: "planner" as const, result: r }))
      ])

      if (routerResult.source === "router" && routerResult.result) {
        // Router won with a usable plan — quality gate before using it
        const { plan: routedPlan, outcome } = routerResult.result

        // Quality gate: if the message requests content generation but the
        // router plan only has default/shallow props, wait briefly for the
        // full planner which can produce richer content.
        if (isRouterPlanTooShallow(plannerMessage, routedPlan)) {
          ctx.log.info({ event: "router_plan_too_shallow" }, "Router plan shallow for content-generating message — waiting for full planner")
          try {
            const betterResult = await Promise.race([
              fullPlannerPromise.then((r) => ({ got: "planner" as const, result: r })),
              sleepMs(routerHeadStartMs).then(() => ({ got: "timeout" as const, result: null }))
            ])
            if (betterResult.got === "planner" && betterResult.result) {
              consumeFullPlannerResult(betterResult.result)
              suppressCancelOnly(routerPromise, ctx.log, "router_after_quality_gate")
              // Skip to post-race handling with initialPlan set
            } else {
              // Planner didn't finish in time — fall through to use router plan below
            }
          } catch (qualityGateErr) {
            if (isCancelError(qualityGateErr)) throw qualityGateErr
            ctx.log.warn({ event: "quality_gate_planner_error", error: toErrorDetail(qualityGateErr) }, "Quality gate: full planner errored — using router plan")
          }
        }

        // If full planner didn't beat the router (or quality gate didn't fire), use router plan
        if (!initialPlan) {
          markPlanningFinish()
          emitStatusTone("planning")
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
            outcome,
            intent: routedPlan.intent,
            opCount: routedPlan.ops.length,
            opTypes: routedPlan.ops.map((op) => op.op),
            plannerTier: "llm_intent_router",
            ...timingFields()
          })
          const routedOutcome = await respondFromPlan(routedPlan, plannerSource, applyMode, undefined, "llm_intent_router")
          if (routedOutcome.done) {
            // For needs_clarification: only short-circuit for deterministic scenarios
            // (page deletes, renames, etc.). Otherwise fall through to the full planner —
            // the router may have refused a valid batch-add request like "populate this page".
            if (routedPlan.intent === "needs_clarification" && !shouldReturnDeterministicClarification(plannerMessage)) {
              // Fall through — wait for the full planner result below
            } else {
              // Success — abort the full planner (fire and forget)
              fullPlannerAbort.abort("router_succeeded")
              suppressCancelOnly(fullPlannerPromise, ctx.log, "planner_after_router_success")
              return routedOutcome.response
            }
          }
        }
        // Router plan failed validation or was a non-deterministic clarification — fall through to wait for full planner
      }

      if (routerResult.source === "router") {
        if (routerDetectedInfo) {
          // Info query — abort the in-flight planner (it has wrong context)
          fullPlannerAbort.abort("router_info_rebuild")
          suppressCancelOnly(fullPlannerPromise, ctx.log, "planner_after_router_info")
          // Fall through to post-race context rebuild below
        } else {
          // Router returned null or failed validation — await the full planner
          try {
            const plannerResult = await fullPlannerPromise
            consumeFullPlannerResult(plannerResult)
          } catch (plannerFallbackError) {
            if (isCancelError(plannerFallbackError)) throw plannerFallbackError
            // Full planner also failed — fall through to retry loop
          }
        }
      } else {
        // Full planner won the race — use its result
        consumeFullPlannerResult(routerResult.result as { plan: EditPlan; usage: TokenUsage; schemaContext: PlannerSchemaContextMeta })
        // Let router finish in the background (no side effects)
        suppressCancelOnly(routerPromise, ctx.log, "router_after_planner_won")
      }
    } catch (parallelError) {
      if (isCancelError(parallelError)) throw parallelError
      // Both failed — fall through to sequential full planner retry loop
      fullPlannerAbort.abort("parallel_error")
      suppressCancelOnly(fullPlannerPromise, ctx.log, "planner_after_parallel_error")
      suppressCancelOnly(routerPromise, ctx.log, "router_after_parallel_error")
      ctx.log.warn({ err: toErrorDetail(parallelError), event: "parallel_planner_error" }, "Parallel intent router + planner failed, falling back to sequential planner")
    }
  } else if (shouldTryLlmIntentRouter) {
    // Sequential intent router (parallel disabled via env)
    try {
      emitStatusTone("understanding")
      const routerModel =
        ctx.modelLookup[provider]?.fast ??
        ctx.modelLookup[provider]?.balanced ??
        modelUsed

      const routedIntent = await planner.parseIntent({
        message: plannerMessage,
        slug: effectiveSlug,
        currentPage: current,
        activeBlockId: planningActiveBlockId,
        activeBlockType: body.activeBlockType,
        activeEditablePath: planningActiveEditablePath,
        model: routerModel,
        log: ctx.log
      })

      emitStatusTone("planning")
      const routedPlan = compileDeterministicPlan({
        session: body.session,
        intent: routedIntent,
        message: plannerMessage,
        slug: effectiveSlug,
        currentPage: current,
        activeBlockId: planningActiveBlockId,
        activeEditablePath: planningActiveEditablePath,
        locale: body.locale
      })

      if (routedIntent.action === "info") {
        routerDetectedInfo = true
      }

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

  // Router detected a content query the regex missed — rebuild context with full props
  // so the full planner retry loop has the page content it needs for content_answer.
  if (routerDetectedInfo && !initialPlan && !contentQuery) {
    plannerContext = plannerContextPack({
      session: body.session,
      slug: effectiveSlug,
      message: plannerMessage,
      currentPage: current,
      activeBlockId: planningActiveBlockId,
      activeBlockType: body.activeBlockType,
      activeEditablePath: planningActiveEditablePath,
      includeFullProps: true
    })
    isLightweightEdit = false
  }

  // --- Continuation chain decomposition ---
  // If the message looks like a multi-step request and we haven't already entered a chain,
  // decompose it into steps and execute only the first one through the normal planner.
  if (
    !initialPlan &&
    executionMode === "auto" &&
    !continuationChainBySession.has(body.session) &&
    isMultiStepCandidate(plannerMessage) &&
    (plannerSource === "openai" || plannerSource === "anthropic" || plannerSource === "gemini")
  ) {
    try {
      emitStatusTone("breaking_down")
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
        siteContextBlock,
        locale: body.locale
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

  // Guard: if the planner returned content_answer for a message that clearly
  // requests an edit, discard the plan so the retry loop runs with the
  // original (non-downgraded) model.  This prevents the fast model from
  // hallucinating "already set" when the user explicitly asks to update text.
  if (
    (initialPlan as EditPlan | null)?.intent === "content_answer" &&
    /\b(update|change|set|replace|make|rewrite|edit|rename|translate|fix)\b/i.test(plannerMessage)
  ) {
    ctx.log.info({ event: "content_answer_rejected_for_edit", model: modelUsed }, "Rejected content_answer for an edit request — retrying with full model")
    ;(initialPlan as unknown) = null
  }

  markPlanningStart()

  // Streamed per-op apply: apply ops as they stream from the LLM, so the user
  // sees changes at ~800ms intervals instead of waiting for the full plan.
  const streamedPerOpApplyEnabled =
    incrementalApplyEnabled &&
    incrementalPlanStreamEnabled &&
    !/^(0|false|no|off)$/i.test((process.env.CHAT_STREAMED_OP_APPLY ?? "1").trim()) &&
    Boolean(options?.onOpApplied)
  const streamApplyState = {
    appliedCount: 0,
    failedAtIndex: null as number | null,
    hasStructuralOps: false,
    /** Snapshots per slug — `null` means the page didn't exist before streaming (needs removal on rollback). */
    rollbackSnapshots: new Map<string, PageDoc | null>()
  }

  // Skip the planning loop if the parallel race already produced an initialPlan
  for (let attempt = initialPlan ? maxPlanningAttempts + 1 : 1; attempt <= maxPlanningAttempts; attempt += 1) {
    throwIfCanceled(options?.signal)
    planningAttempts = attempt
    try {
      if (attempt === 1) emitStatusTone("thinking")
      else emitStatus(`Retrying plan generation (${attempt}/${maxPlanningAttempts})...`)
      const result = await raceCancel(generatePlanImpl({
        message: plannerMessage,
        slug: effectiveSlug,
        currentPage: current,
        contextPack: plannerContext,
        model: modelUsed,
        locale: body.locale,
        history: isLightweightEdit ? [] : sessionChatHistory,
        siteContextBlock: isLightweightEdit ? undefined : siteContextBlock,
        toolRuntime: supportsNativeTools && !isLightweightEdit ? ctx.toolRuntime : undefined,
        toolCallContext: supportsNativeTools && !isLightweightEdit
          ? {
              siteId: body.siteId ?? "default",
              sessionId: body.session ?? "dev",
              traceId: chatRequestId,
              gdriveFolderId
            }
          : undefined,
        onStatusUpdate: options?.onStatusUpdate,
        onImageProgress: options?.onImageProgress,
        onToolExecution: supportsNativeTools && !isLightweightEdit
          ? (event) => {
              if (event.ok && !event.deferred && event.toolName === "unsplash.search") usedNativeUnsplashTool = true
              if (event.ok && !event.deferred && event.toolName === "image.generate") usedNativeImageTool = true
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
        onThinking: options?.onThinking,
        thinking: thinkingConfig,
        onFieldDraft: options?.onFieldDraft,
        onSummaryChunk: options?.onSummaryChunk,
        onChangeLogEntry: options?.onChangeLogEntry,
        onPlannedOp: incrementalPlanStreamEnabled
          ? async (op, index) => {
              markFirstStructuredProgress()
              options?.onPlannedOp?.({ op, index })

              // Streamed per-op apply: validate and apply each op as it streams
              // in from the LLM, so the user sees changes progressively instead
              // of waiting for the entire plan.
              if (streamedPerOpApplyEnabled && options?.onOpApplied) {
                try {
                  // Snapshot the target page before we touch it (once per slug)
                  const opSlug = ("pageSlug" in op && typeof op.pageSlug === "string") ? op.pageSlug : effectiveSlug
                  if (!streamApplyState.rollbackSnapshots.has(opSlug)) {
                    const existingPage = getPage(body.session!, opSlug)
                    streamApplyState.rollbackSnapshots.set(opSlug, existingPage ? structuredClone(existingPage) : null)
                  }
                  // Skip ops that need the full plan context before applying:
                  //   - Page-level structural ops (create_page, rename_page, etc.) can't
                  //     be applied piecemeal because they affect navigation/history state.
                  //   - remove_block requires the complete op list so the tier-1
                  //     destructive-action gate (bulk deletes, majority-wipe) can evaluate
                  //     the full scope before any blocks are deleted from the preview.
                  //     Applying remove_block mid-stream would erase blocks before the gate
                  //     runs, then surface an "Approve" card for already-deleted content.
                  const isStructural = op.op === "create_page" || op.op === "rename_page" || op.op === "remove_page" || op.op === "move_page" || op.op === "duplicate_page" || op.op === "remove_block"
                  if (isStructural) {
                    streamApplyState.hasStructuralOps = true
                    return
                  }
                  validateOperations([op])
                  const stepResult = await applyOpsAtomically(body.session!, [op], { componentsManifest })
                  if (stepResult.skippedOps.length > 0) {
                    options?.onOpSkipped?.({
                      index,
                      total: index, // total unknown during streaming
                      op,
                      reason: stepResult.skippedOps[0]!.reason
                    })
                    return
                  }
                  streamApplyState.appliedCount += 1
                  if (firstApplyMs === null) {
                    firstApplyMs = Date.now() - pipelineStartedAtMs
                    stageTimeline.push({ stage: "first_op_applied", atMs: firstApplyMs })
                  }
                  const previewVersion = bumpVersion(body.session!)
                  options.onOpApplied({
                    index,
                    total: index, // total unknown during streaming
                    op,
                    previewVersion,
                    focusBlockId: pickFocusBlockId([op])
                  })
                } catch (streamApplyErr) {
                  // If an op fails, mark for full rollback+re-apply after streaming
                  streamApplyState.failedAtIndex = index
                  ctx.log.warn(
                    { event: "streamed_op_apply_failed", chatRequestId, opIndex: index, error: toErrorDetail(streamApplyErr) },
                    "Streamed op apply failed — will re-apply full plan after streaming"
                  )
                }
              }
            }
          : undefined,
        componentsManifest,
        lightweight: shouldPreferFastModelForMessage(plannerMessage),
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
      emitStatusTone("validating")
      break
    } catch (error) {
      if (isCancelError(error)) throw error
      const reason = toErrorDetail(error)

      // API-level errors (rate limits, auth, quota) — surface immediately, don't retry
      const errorMsg = error instanceof Error ? error.message : ""
      const isApiError = /usage limit|rate limit|quota|unauthorized|billing/i.test(errorMsg) || /\b40[0-13]\b/.test(errorMsg)
      if (isApiError) {
        markPlanningFinish()
        const providerLabel = plannerSource === "anthropic" ? "Anthropic" : plannerSource === "openai" ? "OpenAI" : plannerSource === "gemini" ? "Google Gemini" : "The AI provider"
        const consoleUrl = plannerSource === "anthropic" ? "https://console.anthropic.com/settings/billing" : plannerSource === "openai" ? "https://platform.openai.com/usage" : plannerSource === "gemini" ? "https://console.cloud.google.com/billing" : ""
        const consoleLink = consoleUrl ? ` [Check your ${providerLabel} console](${consoleUrl}).` : ""
        const userSummary = /usage limit/i.test(errorMsg)
          ? `${providerLabel} API usage limit has been reached.${consoleLink} You can also switch to a different provider.`
          : /rate limit/i.test(errorMsg)
            ? `${providerLabel} is rate-limiting requests. Please wait a moment and try again.`
            : /unauthorized|api.key|authentication/i.test(errorMsg)
              ? `${providerLabel} API key is invalid or expired.${consoleLink} Please check your API key configuration.`
              : `${providerLabel} error: ${errorMsg.slice(0, 200)}`
        ctx.log.error({ event: "api_error", model: modelUsed, error: errorMsg.slice(0, 300) }, userSummary)
        return {
          code: 503,
          payload: withDebugPayload({
            status: "error",
            summary: userSummary,
            changes: [],
            previewVersion: versions.get(body.session!) ?? 0,
            plannerSource,
            modelUsed,
            modelKey
          } satisfies ChatResult, { outcome: "api_error", reason: errorMsg.slice(0, 300) })
        }
      }

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
          }, { outcome: "planning_incomplete", reasonCategory, reason: reason.slice(0, 300), plannerTier: "full_llm" })
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
          }, { outcome: "planning_exhausted", reasonCategory, reason: reason.slice(0, 300), plannerTier: "full_llm" })
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
      }, { outcome: "planning_missing", plannerTier: "full_llm" })
    }
  }

  // If streamed per-op apply already applied all ops successfully and no structural
  // ops are pending, skip the normal apply step in respondFromPlan.
  const streamedApplyComplete =
    streamedPerOpApplyEnabled &&
    streamApplyState.appliedCount > 0 &&
    streamApplyState.failedAtIndex === null &&
    !streamApplyState.hasStructuralOps
  // If streamed apply partially failed, roll back and let respondFromPlan re-apply everything
  if (streamedPerOpApplyEnabled && streamApplyState.failedAtIndex !== null && streamApplyState.rollbackSnapshots.size > 0) {
    const rolledBackSlugs: string[] = []
    for (const [slug, snapshot] of streamApplyState.rollbackSnapshots) {
      if (snapshot) {
        setPage(body.session!, { ...snapshot, slug })
      } else {
        removePage(body.session!, slug)
      }
      rolledBackSlugs.push(slug)
    }
    ctx.log.warn(
      { event: "streamed_op_rollback", chatRequestId, appliedCount: streamApplyState.appliedCount, failedAtIndex: streamApplyState.failedAtIndex, rolledBackSlugs },
      `Rolled back ${rolledBackSlugs.length} page(s) after streamed op failure at index ${streamApplyState.failedAtIndex}`
    )
  }
  const initialOutcome = await respondFromPlan(
    initialPlan,
    plannerSource,
    applyMode,
    streamedApplyComplete
      ? { preApplied: true, undoSnapshot: streamApplyState.rollbackSnapshots.get(effectiveSlug) ?? undefined }
      : undefined,
    "full_llm"
  )
  if (initialOutcome.done) return initialOutcome.response

  if (!isDeterministicRepairEligible(initialOutcome.reason)) {
    return guardrailFailureResponse({ reason: initialOutcome.reason, source: plannerSource })
  }

  let repairedPlan: EditPlan
  try {
    throwIfCanceled(options?.signal)
    emitStatusTone("repairing")
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
      : /explicit cta target coverage/i.test(initialOutcome.reason)
        ? `${initialOutcome.reason}. Repair for multi-target CTA completeness: update both hero and footer CTA text targets requested by the user, keep all CTA links/hrefs unchanged, and preserve user constraints such as punctuation bans.`
        : buildDeterministicRepairFeedback(initialOutcome.reason)
    const repairResult = await raceCancel(generatePlanImpl({
      message: plannerMessage,
      slug: effectiveSlug,
      currentPage: current,
      contextPack: plannerContext,
      model: modelUsed,
      locale: body.locale,
      history: sessionChatHistory,
      feedback: repairFeedback,
      forceFullSchemaContracts: true,
      siteContextBlock,
      onToken: onPlanningToken,
      onThinking: options?.onThinking,
      thinking: thinkingConfig,
      onFieldDraft: options?.onFieldDraft,
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
      }, { outcome: "repair_failed", reasonCategory: classifyGuardrailError(reason), reason: reason.slice(0, 300), plannerTier: "full_llm" })
    }
  }

  const repairedOutcome = await respondFromPlan(repairedPlan, plannerSource, applyMode)
  if (repairedOutcome.done) return repairedOutcome.response
  const repairedReason = repairedOutcome.reason
  const ctaCoverageRepairFailed = /explicit cta target coverage/i.test(repairedReason)
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
  if (ctaCoverageRepairFailed) {
    return {
      code: 200,
      payload: withDebugPayload({
        status: "needs_clarification",
        summary: "Please confirm the exact CTA wording for both the hero CTA and footer CTA so I can apply both safely.",
        changes: [],
        mentionedSlugs: [effectiveSlug],
        previewVersion: versions.get(body.session) ?? 0,
        plannerSource,
        modelUsed,
        modelKey
      }, { outcome: "needs_clarification", reasonCategory: "schema_violation" })
    }
  }
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
    }, { outcome: "repair_failed", reasonCategory: "schema_violation", reason: repairedReason.slice(0, 300), plannerTier: "full_llm" })
  }
}
