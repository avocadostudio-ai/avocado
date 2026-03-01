import { randomUUID } from "node:crypto"
import type { FastifyBaseLogger } from "fastify"
import type { EditPlan, Operation, PageDoc } from "@ai-site-editor/shared"
import type { UnsplashImage } from "../variation-images.js"
import { normalizeRouteCandidate, parseCreatePageRequest } from "../nlp/intent-helpers.js"
import {
  type ChatRequestBody,
  type ChatResult,
  isBlockCatalogQuery,
  isInfoQuery,
  isAdviceQuery,
  adviceResponse,
  plannerMessageWithPendingContext,
  withSiteContext,
  infoResponse
} from "../nlp/intent-detection.js"
import type { createChatTelemetryStore } from "../telemetry/chat-telemetry.js"
import {
  type ModelKey,
  versions,
  pendingClarificationBySession,
  chatHistoryBySession,
  pendingApprovalPlanBySession,
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
  applyOpsAtomically,
  pickFocusBlockId,
  pickUpdatedSlug
} from "../ops/ops-engine.js"
import {
  buildCreatePagePlan,
  clarificationSuggestions,
  demoPlanFromMessage,
  plannerContextPack,
  compileDeterministicPlan
} from "../nlp/deterministic-planner.js"
import { generatePlanWithOpenAI } from "./planner.js"
import {
  heroImageQueryFromContext,
  imageKeywordsFromQuery,
  generateVariationImageWithOpenAI,
  resolveUnsplashImage
} from "../image/image-helpers.js"

// ---------------------------------------------------------------------------
// Pipeline context
// ---------------------------------------------------------------------------

export type ChatPipelineContext = {
  log: FastifyBaseLogger
  chatTelemetry: ReturnType<typeof createChatTelemetryStore>
  modelLookup: Record<ModelKey, string>
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

export function firstUrlFromText(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s"']+/)
  return match ? match[0] : undefined
}

// ---------------------------------------------------------------------------
// Slug collection
// ---------------------------------------------------------------------------

export function collectMentionedSlugsFromPlan(plan: EditPlan, fallbackSlug?: string) {
  const seen = new Set<string>()
  const removed = new Set<string>()
  const push = (slug?: string) => {
    if (!slug || typeof slug !== "string") return
    const normalized = normalizeRouteCandidate(slug)
    if (!normalized) return
    seen.add(normalized)
  }

  for (const op of plan.ops) {
    if (op.op === "create_page") {
      push(op.page.slug)
      continue
    }
    if (op.op === "rename_page") {
      push(op.newPageSlug)
      continue
    }
    if (op.op === "remove_page") {
      const normalized = normalizeRouteCandidate(op.pageSlug)
      if (normalized) removed.add(normalized)
      continue
    }
    if (op.op === "move_page") {
      push(op.pageSlug)
      push(op.afterPageSlug)
      continue
    }
    if (op.op === "duplicate_block") {
      if (typeof op.toPageSlug === "string" && op.toPageSlug.length > 0) push(op.toPageSlug)
      else push(op.pageSlug)
      continue
    }
    if (op.op === "duplicate_page") {
      push(op.pageSlug)
      push(op.newPageSlug)
      push(op.afterPageSlug)
      continue
    }
    push(op.pageSlug)
  }

  for (const slug of removed) seen.delete(slug)
  if (seen.size === 0) {
    const normalizedFallback = normalizeRouteCandidate(fallbackSlug)
    if (normalizedFallback && !removed.has(normalizedFallback)) seen.add(normalizedFallback)
  }
  return orderSlugsHomeFirst(Array.from(seen))
}

export function collectMentionedSlugsFromOps(ops: Operation[], fallbackSlug?: string) {
  return collectMentionedSlugsFromPlan(
    {
      intent: "edit_plan",
      summary_for_user: "",
      change_log: [],
      ops
    },
    fallbackSlug
  )
}

// ---------------------------------------------------------------------------
// Plan normalization for UI
// ---------------------------------------------------------------------------

export function normalizePlanCopyForUi(plan: EditPlan, currentPage: PageDoc): EditPlan {
  const rewrite = (text: string) =>
    text
      .replace(/\bhome page secondary cta\b/gi, "Hero secondary CTA")
      .replace(/\bsecondary cta\b/gi, "Hero secondary CTA")
      .replace(/\bhero block imageurl\b/gi, "Hero block image")
      .replace(/\bimageurl\b/gi, "Hero block image")
      .replace(/\bimagealt\b/gi, "Hero image alt text")

  const normalizedSummary = rewrite(plan.summary_for_user)
  const normalizedChangeLog = plan.change_log.map(rewrite)

  if (plan.intent !== "edit_plan" || plan.ops.length !== 1) return plan
  const [op] = plan.ops
  if (op.op !== "update_props") {
    if (normalizedSummary !== plan.summary_for_user || normalizedChangeLog.some((line, idx) => line !== plan.change_log[idx])) {
      return { ...plan, summary_for_user: normalizedSummary, change_log: normalizedChangeLog }
    }
    return plan
  }
  const block = currentPage.blocks.find((entry) => entry.id === op.blockId)
  if (!block || block.type !== "Hero") {
    if (normalizedSummary !== plan.summary_for_user || normalizedChangeLog.some((line, idx) => line !== plan.change_log[idx])) {
      return { ...plan, summary_for_user: normalizedSummary, change_log: normalizedChangeLog }
    }
    return plan
  }
  const patch = op.patch as Record<string, unknown>
  const hasSecondaryText = Object.prototype.hasOwnProperty.call(patch, "secondaryCtaText")
  const hasSecondaryHref = Object.prototype.hasOwnProperty.call(patch, "secondaryCtaHref")
  if (!hasSecondaryText && !hasSecondaryHref) return plan

  const nextSummary = "Renamed the Hero secondary CTA."
  const nextChangeLog = ["Updated the Hero secondary CTA text/link."]
  return {
    ...plan,
    summary_for_user: nextSummary,
    change_log: nextChangeLog
  }
}

// ---------------------------------------------------------------------------
// Unsplash hero image rewrite
// ---------------------------------------------------------------------------

export async function withUnsplashHeroImage(args: {
  plan: EditPlan
  message: string
  slug: string
  currentPage: PageDoc
  activeBlockId?: string
  activeEditablePath?: string
  chatRequestId?: string
  log: FastifyBaseLogger
}): Promise<EditPlan> {
  const lowerMessage = args.message.toLowerCase()
  if (args.plan.intent !== "edit_plan") return args.plan

  const explicitUnsplashRequest = lowerMessage.includes("unsplash")
  args.log.info(
    {
      event: "hero_image_rewrite_start",
      chatRequestId: args.chatRequestId,
      slug: args.slug,
      explicitUnsplashRequest,
      message: args.message
    },
    "Evaluating hero image rewrite"
  )

  const plan = structuredClone(args.plan)
  let changed = false
  let sourceQuery: string | undefined

  for (const op of plan.ops) {
    if (op.op !== "update_props" || op.pageSlug !== args.slug) continue
    const target = args.currentPage.blocks.find((block) => block.id === op.blockId)
    if (!target || target.type !== "Hero") continue

    const rawPatch = op.patch as Record<string, unknown>
    const patchCandidate =
      rawPatch && typeof rawPatch.props === "object" && rawPatch.props !== null && !Array.isArray(rawPatch.props)
        ? (rawPatch.props as Record<string, unknown>)
        : rawPatch

    const requestedImageUrl = typeof patchCandidate.imageUrl === "string" ? patchCandidate.imageUrl.trim() : ""
    const touchesImage =
      Object.prototype.hasOwnProperty.call(patchCandidate, "imageUrl") ||
      args.activeEditablePath === "imageUrl" ||
      /\b(image|photo|picture)\b/.test(lowerMessage)
    const userProvidedExplicitUrl = Boolean(firstUrlFromText(args.message))
    const shouldReplaceWithUnsplash =
      !userProvidedExplicitUrl && touchesImage && (explicitUnsplashRequest || requestedImageUrl.length > 0)
    if (!touchesImage || !shouldReplaceWithUnsplash) continue

    const query = heroImageQueryFromContext({
      message: args.message,
      currentPage: args.currentPage,
      targetBlock: target,
      patchCandidate
    })
    let resolved: UnsplashImage | null = null
    if (!explicitUnsplashRequest && process.env.OPENAI_API_KEY) {
      const generatedAlt = `AI-generated hero image featuring ${query}`
      const generatedPrompt = [
        "Use case: website hero image update",
        `Primary subject: ${query}`,
        "Style: photorealistic editorial product photography",
        "Composition: clean landscape frame with clear focal subject",
        "Lighting: natural and vibrant",
        "Constraints: no text, no logos, no watermark"
      ].join("\n")
      resolved = await generateVariationImageWithOpenAI({ prompt: generatedPrompt, altText: generatedAlt })
    }
    if (!resolved) {
      resolved = await resolveUnsplashImage(query, { subjectKeywords: imageKeywordsFromQuery(query, 4) }, { chatRequestId: args.chatRequestId, logger: args.log })
    }
    if (!resolved) continue

    const nextPatch: Record<string, unknown> = { ...patchCandidate, imageUrl: resolved.url }
    if (
      !Object.prototype.hasOwnProperty.call(nextPatch, "imageAlt") ||
      typeof nextPatch.imageAlt !== "string" ||
      nextPatch.imageAlt.trim().length === 0
    ) {
      nextPatch.imageAlt = resolved.alt
    }
    op.patch = nextPatch
    sourceQuery = resolved.query
    args.log.info(
      {
        event: "hero_image_rewrite_applied",
        chatRequestId: args.chatRequestId,
        slug: args.slug,
        blockId: op.blockId,
        query,
        explicitUnsplashRequest,
        previousImageUrl: requestedImageUrl,
        nextImageUrl: resolved.url,
        nextImageAlt: nextPatch.imageAlt
      },
      "Applied hero image rewrite"
    )
    changed = true
  }

  if (!changed && explicitUnsplashRequest && /\b(image|photo|picture|hero)\b/.test(lowerMessage)) {
    const selectedBlock =
      args.activeBlockId && args.currentPage.blocks.find((block) => block.id === args.activeBlockId)
        ? args.currentPage.blocks.find((block) => block.id === args.activeBlockId)
        : null
    const fallbackHero =
      selectedBlock?.type === "Hero" ? selectedBlock : args.currentPage.blocks.find((block) => block.type === "Hero") ?? null

    if (fallbackHero) {
      const query = heroImageQueryFromContext({
        message: args.message,
        currentPage: args.currentPage,
        targetBlock: fallbackHero
      })
      const resolved = await resolveUnsplashImage(
        query,
        { subjectKeywords: imageKeywordsFromQuery(query, 4) },
        { chatRequestId: args.chatRequestId, logger: args.log }
      )
      if (!resolved) return plan

      plan.ops.push({
        op: "update_props",
        pageSlug: args.slug,
        blockId: fallbackHero.id,
        patch: { imageUrl: resolved.url, imageAlt: resolved.alt }
      })
      sourceQuery = resolved.query
      changed = true
    }
  }

  if (changed) {
    const loggedQuery = sourceQuery ? ` from query "${sourceQuery}"` : ""
    plan.change_log = [...plan.change_log, `Set Hero image to a relevant result${loggedQuery}.`]
  } else {
    args.log.info(
      {
        event: "hero_image_rewrite_skipped",
        chatRequestId: args.chatRequestId,
        slug: args.slug,
        explicitUnsplashRequest,
        message: args.message
      },
      "Skipped hero image rewrite"
    )
  }

  return plan
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
// AI insight helpers
// ---------------------------------------------------------------------------

const AI_JUSTIFICATION_PREFIX = "__ai_justification__:"
const AI_PERFORMANCE_PREFIX = "__ai_performance__:"

function isRewriteLikeMessage(message: string) {
  const lower = message.toLowerCase()
  return (
    /\brewrite\b/.test(lower) ||
    /\brephrase\b/.test(lower) ||
    /\breword\b/.test(lower) ||
    /\bmake\b.*\b(shorter|clearer|crisper|concise)\b/.test(lower) ||
    /\bimprove\b.*\b(copy|text|wording|messaging)\b/.test(lower) ||
    /\bchange\b.*\b(tone|copy|wording)\b/.test(lower)
  )
}

function isPerformanceAwareMessage(message: string) {
  const lower = message.toLowerCase()
  return (
    /\bseo\b/.test(lower) ||
    /\bkeyword/.test(lower) ||
    /\bsemantic/.test(lower) ||
    /\bconversion/.test(lower) ||
    /\baccessibility/.test(lower) ||
    /\breadability/.test(lower) ||
    /\bcta\b/.test(lower) ||
    /\bperformance\b/.test(lower)
  )
}

function isLikelyTextField(key: string) {
  if (!key) return false
  return !/(^|\.)(?:href|url|image|icon|id)$/i.test(key)
}

function collectChangedTextFields(ops: Operation[]) {
  const out = new Set<string>()
  for (const op of ops) {
    if (op.op === "update_props") {
      const patch = op.patch as Record<string, unknown>
      for (const [key, value] of Object.entries(patch ?? {})) {
        if (typeof value !== "string" || value.trim().length === 0) continue
        if (!isLikelyTextField(key)) continue
        out.add(key)
      }
      continue
    }

    if (op.op === "update_item") {
      const patch = op.patch as Record<string, unknown>
      for (const [key, value] of Object.entries(patch ?? {})) {
        if (typeof value !== "string" || value.trim().length === 0) continue
        if (!isLikelyTextField(key)) continue
        out.add(`${op.listKey}.${key}`)
      }
    }
  }
  return Array.from(out)
}

function buildAiInsightChanges(args: { plan: EditPlan; message: string }) {
  if (args.plan.intent !== "edit_plan" || args.plan.ops.length === 0) return []

  const textFields = collectChangedTextFields(args.plan.ops)
  if (textFields.length === 0) return []

  const rewriteLike = isRewriteLikeMessage(args.message)
  const performanceAware = isPerformanceAwareMessage(args.message)

  const lines: string[] = []
  if (rewriteLike) {
    lines.push(`${AI_JUSTIFICATION_PREFIX}This version is more benefit-driven and action-oriented.`)
  }
  if (performanceAware) {
    lines.push(`${AI_PERFORMANCE_PREFIX}This wording improves semantic relevance and supports SEO, accessibility, and conversion checks.`)
  }
  return lines
}

// ---------------------------------------------------------------------------
// Deterministic create page shortcut
// ---------------------------------------------------------------------------

function deterministicCreatePagePlan(args: { session: string; message: string }) {
  const requestedSlug = parseCreatePageRequest(args.message)
  if (!requestedSlug) return null
  return buildCreatePagePlan({ session: args.session, requestedSlug, userMessage: args.message })
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

// ---------------------------------------------------------------------------
// Main chat pipeline
// ---------------------------------------------------------------------------

export async function runChatPipeline(
  ctx: ChatPipelineContext,
  body: ChatRequestBody,
  options?: {
    onPlanningToken?: (token: string) => void
    onOpApplied?: (event: { index: number; total: number; op: Operation; previewVersion: number; focusBlockId?: string }) => void
  }
): Promise<{ code: number; payload: ChatResult | { error: string } }> {
  const executionMode = body.executionMode ?? "auto"
  const requiresMessage = executionMode === "auto" || executionMode === "plan_only"
  if (!body.session || !body.slug || (requiresMessage && !body.message)) {
    return { code: 400, payload: { error: "session and slug are required; message is required for planning" } }
  }
  if (executionMode === "discard_pending_plan") {
    const existing = pendingApprovalPlanBySession.get(body.session)
    if (!existing) {
      return {
        code: 200,
        payload: {
          status: "canceled",
          summary: "No pending plan to stop.",
          changes: [],
          previewVersion: versions.get(body.session) ?? 0,
          plannerSource: process.env.OPENAI_API_KEY ? "openai" : "demo",
          modelUsed: ctx.modelLookup[(process.env.OPENAI_MODEL_KEY as ModelKey | undefined) ?? "balanced"],
          modelKey: (process.env.OPENAI_MODEL_KEY as ModelKey | undefined) ?? "balanced"
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
  const messageWithContext = withSiteContext(body.message ?? "", body.sitePurpose, body.siteHosting)
  const plannerMessage = plannerMessageWithPendingContext(body.session, messageWithContext)
  const sessionChatHistory = chatHistoryBySession.get(body.session) ?? []
  const chatRequestId = randomUUID()
  const requestedSlug = body.slug
  const effectiveSlug = resolveEffectiveSlug({
    session: body.session,
    requestedSlug,
    activeBlockId: body.activeBlockId
  })
  ctx.log.info(
    {
      event: "chat_pipeline_start",
      chatRequestId,
      session: body.session,
      requestedSlug,
      effectiveSlug,
      activeBlockId: body.activeBlockId,
      activeEditablePath: body.activeEditablePath,
      message: body.message
    },
    "Chat pipeline request received"
  )

  const modelKey = body.modelKey && ctx.modelLookup[body.modelKey] ? body.modelKey : (process.env.OPENAI_MODEL_KEY as ModelKey | undefined) ?? "balanced"
  const modelUsed = ctx.modelLookup[modelKey]
  const plannerSource: "openai" | "demo" = process.env.OPENAI_API_KEY ? "openai" : "demo"
  const promptHash = ctx.chatTelemetry.promptHash(plannerMessage)
  const promptExcerpt = ctx.chatTelemetry.promptExcerpt(plannerMessage)
  const withDebugPayload = (
    payload: ChatResult,
    extra?: Partial<NonNullable<ChatResult["debug"]>>
  ): ChatResult => ({
    ...payload,
    debug: {
      traceId: chatRequestId,
      promptHash,
      promptExcerpt,
      ...(payload.debug ?? {}),
      ...(extra ?? {})
    }
  })
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

  const current = getPage(body.session, effectiveSlug)
  if (!current) return { code: 404, payload: { error: "page not found" } }

  if (body.message && isInfoQuery(body.message)) {
    const info = infoResponse({ body, current, plannerSource, modelUsed, modelKey })
    return { code: info.code, payload: withDebugPayload(info.payload, { outcome: "info" }) }
  }
  if (body.message && isAdviceQuery(body.message)) {
    pendingClarificationBySession.delete(body.session)
    const advice = adviceResponse({ body, current, plannerSource, modelUsed, modelKey })
    return { code: advice.code, payload: withDebugPayload(advice.payload, { outcome: "advice" }) }
  }

  const contextPack = plannerContextPack({
    session: body.session,
    slug: effectiveSlug,
    message: plannerMessage,
    currentPage: current,
    activeBlockId: body.activeBlockId,
    activeBlockType: body.activeBlockType,
    activeEditablePath: body.activeEditablePath
  })

  const guardrailFailureResponse = (args: { reason: string; source: "openai" | "demo" }) => {
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
      reasonCategory: category
    })
    if (category === "ambiguity") {
      const selected =
        body.activeBlockId && current.blocks.find((b) => b.id === body.activeBlockId)
          ? current.blocks.find((b) => b.id === body.activeBlockId)
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

  const respondFromPlan = async (
    plan: EditPlan,
    source: "openai" | "demo",
    applyMode: "apply_now" | "plan_only" = "apply_now",
    optionsOverride?: { preResolvedPlan?: boolean }
  ) => {
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
      opTypes: plan.ops.map((op) => op.op)
    })
    let resolvedPlan = plan
    if (!optionsOverride?.preResolvedPlan) {
      resolvedPlan = normalizePlanCopyForUi(plan, current)
      resolvedPlan = await withUnsplashHeroImage({
        plan: resolvedPlan,
        message: plannerMessage,
        slug: effectiveSlug,
        currentPage: current,
        activeBlockId: body.activeBlockId,
        activeEditablePath: body.activeEditablePath,
        chatRequestId,
        log: ctx.log
      })

      if (resolvedPlan.intent === "needs_clarification" && body.activeBlockId) {
        const focusedFallback = compileDeterministicPlan({
          session: body.session ?? "dev",
          intent: { action: "clarify" },
          message: plannerMessage,
          slug: effectiveSlug ?? "/",
          currentPage: current,
          activeBlockId: body.activeBlockId,
          activeEditablePath: body.activeEditablePath
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
        opTypes: resolvedPlan.ops.map((op) => op.op)
      })
      if (body.message) pushChatHistory(body.session!, body.message, resolvedPlan.summary_for_user)
      const selected =
        body.activeBlockId && current.blocks.find((b) => b.id === body.activeBlockId)
          ? current.blocks.find((b) => b.id === body.activeBlockId)
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
            suggestions: clarificationSuggestions({ body, current, selected }),
            previewVersion: versions.get(body.session!) ?? 0,
            plannerSource: source,
            modelUsed,
            modelKey
          } satisfies ChatResult, {
            outcome: "needs_clarification",
            intent: resolvedPlan.intent,
            opCount: resolvedPlan.ops.length,
            opTypes: resolvedPlan.ops.map((op) => op.op)
          })
        }
      }
    }

    if (applyMode === "plan_only") {
      const pendingPlanId = randomUUID()
      pendingApprovalPlanBySession.set(body.session!, {
        id: pendingPlanId,
        createdAt: new Date().toISOString(),
        requestedSlug,
        effectiveSlug,
        summary: resolvedPlan.summary_for_user,
        source,
        modelUsed,
        modelKey,
        plan: structuredClone(resolvedPlan)
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
        opTypes: resolvedPlan.ops.map((op) => op.op)
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
            opTypes: resolvedPlan.ops.map((op) => op.op)
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

    try {
      const hasPageStructuralOps = resolvedPlan.ops.some(
        (op) => op.op === "create_page" || op.op === "rename_page" || op.op === "remove_page" || op.op === "move_page" || op.op === "duplicate_page"
      )
      if (options?.onOpApplied && !hasPageStructuralOps) {
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
        applyOpsAtomically(body.session!, resolvedPlan.ops)

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
        for (let index = 0; index < total; index += 1) {
          const op = resolvedPlan.ops[index]
          applyOpsAtomically(body.session!, [op])
          const previewVersion = bumpVersion(body.session!)
          options.onOpApplied({
            index: index + 1,
            total,
            op,
            previewVersion,
            focusBlockId: pickFocusBlockId([op])
          })
        }
      } else {
        applyOpsAtomically(body.session!, resolvedPlan.ops)
      }
      pushUndo(body.session!, effectiveSlug, previous)
      pendingClarificationBySession.delete(body.session!)
      pendingApprovalPlanBySession.delete(body.session!)
      const planUpdatedSlug = pickUpdatedSlug(body.session!, effectiveSlug, resolvedPlan.ops)
      const updatedSlug = planUpdatedSlug ?? (effectiveSlug !== requestedSlug ? effectiveSlug : undefined)
      pushRecentEdit(body.session!, { slug: updatedSlug ?? effectiveSlug, summary: resolvedPlan.summary_for_user, ops: resolvedPlan.ops })
      if (body.message) pushChatHistory(body.session!, body.message, resolvedPlan.summary_for_user)
      const previewVersion = options?.onOpApplied ? (versions.get(body.session!) ?? 0) : bumpVersion(body.session!)
      schedulePersistState(ctx.log)
      const focusBlockId = pickFocusBlockId(resolvedPlan.ops)
      const aiInsightChanges = buildAiInsightChanges({ plan: resolvedPlan, message: plannerMessage })
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
        opTypes: resolvedPlan.ops.map((op) => op.op)
      })
      return {
        done: true as const,
        response: {
          code: 200,
          payload: withDebugPayload({
            status: "applied",
            summary: resolvedPlan.summary_for_user,
            changes: [...resolvedPlan.change_log, ...aiInsightChanges],
            mentionedSlugs: collectMentionedSlugsFromPlan(resolvedPlan, updatedSlug ?? effectiveSlug),
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
            opTypes: resolvedPlan.ops.map((op) => op.op)
          })
        }
      }
    } catch (error) {
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
          reason: reason.slice(0, 300)
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
        reasonCategory: classifyGuardrailError(reason)
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
    const approvedOutcome = await respondFromPlan(pending.plan, pending.source, "apply_now", { preResolvedPlan: true })
    if (approvedOutcome.done) return approvedOutcome.response
    return guardrailFailureResponse({ reason: approvedOutcome.reason, source: pending.source })
  }

  const applyMode = executionMode === "plan_only" ? "plan_only" : "apply_now"

  const forcedCreatePlan = deterministicCreatePagePlan({ session: body.session, message: plannerMessage })
  if (forcedCreatePlan) {
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
      opTypes: forcedCreatePlan.ops.map((op) => op.op)
    })
    const forcedOutcome = await respondFromPlan(forcedCreatePlan, plannerSource, applyMode)
    if (forcedOutcome.done) return forcedOutcome.response
  }

  if (!process.env.OPENAI_API_KEY) {
    try {
      const demoPlan = demoPlanFromMessage(plannerMessage, effectiveSlug, body.activeBlockId, body.activeBlockType)
      const outcome = await respondFromPlan(demoPlan, "demo", applyMode)
      if (outcome.done) return outcome.response
      return guardrailFailureResponse({ reason: outcome.reason, source: "demo" })
    } catch (error) {
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
        reasonCategory: classifyGuardrailError(reason)
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

  const maxPlanningAttempts = 3
  let initialPlan: EditPlan | null = null
  const planningErrors: string[] = []

  for (let attempt = 1; attempt <= maxPlanningAttempts; attempt += 1) {
    try {
      initialPlan = await generatePlanWithOpenAI({
        message: plannerMessage,
        slug: effectiveSlug,
        currentPage: current,
        contextPack,
        model: modelUsed,
        history: sessionChatHistory,
        onToken: options?.onPlanningToken
      })
      break
    } catch (error) {
      const reason = toErrorDetail(error)
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
        reasonCategory: classifyGuardrailError(reason)
      })
      planningErrors.push(`Attempt ${attempt} planning failed: ${reason}`)
      if (attempt === maxPlanningAttempts) {
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
          reasonCategory: classifyGuardrailError(reason)
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
          }, { outcome: "planning_exhausted", reasonCategory: classifyGuardrailError(reason) })
        }
      }
    }
  }

  if (!initialPlan) {
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
      outcome: "planning_missing"
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

  const initialOutcome = await respondFromPlan(initialPlan, "openai", applyMode)
  if (initialOutcome.done) return initialOutcome.response

  if (!isDeterministicRepairEligible(initialOutcome.reason)) {
    return guardrailFailureResponse({ reason: initialOutcome.reason, source: "openai" })
  }

  let repairedPlan: EditPlan
  try {
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
      reasonCategory: classifyGuardrailError(initialOutcome.reason)
    })
    repairedPlan = await generatePlanWithOpenAI({
      message: plannerMessage,
      slug: effectiveSlug,
      currentPage: current,
      contextPack,
      model: modelUsed,
      history: sessionChatHistory,
      feedback: buildDeterministicRepairFeedback(initialOutcome.reason),
      onToken: options?.onPlanningToken
    })
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
      opTypes: repairedPlan.ops.map((op) => op.op)
    })
  } catch (error) {
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
      reasonCategory: classifyGuardrailError(reason)
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

  const repairedOutcome = await respondFromPlan(repairedPlan, "openai", applyMode)
  if (repairedOutcome.done) return repairedOutcome.response
  return guardrailFailureResponse({ reason: repairedOutcome.reason, source: "openai" })
}
