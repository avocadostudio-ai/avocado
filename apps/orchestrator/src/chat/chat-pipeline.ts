import { randomUUID } from "node:crypto"
import type { FastifyBaseLogger } from "fastify"
import type { EditPlan, Operation, PageDoc } from "@ai-site-editor/shared"
import type { UnsplashImage } from "../variation-images.js"
import { isStandalonePageOperation, normalizeRouteCandidate, parseCreatePageRequest, requestsContentGeneration } from "../nlp/intent-helpers.js"
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
  type AIProvider,
  type ModelKey,
  type PendingImageGeneration,
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
  postEditSuggestions,
  demoPlanFromMessage,
  plannerContextPack,
  compileDeterministicPlan,
  inferDeterministicIntent
} from "../nlp/deterministic-planner.js"
import { generatePlanWithOpenAI } from "./planner.js"
import { generatePlanWithAnthropic } from "./anthropic-planner.js"
import { type TokenUsage, estimateUsd } from "../telemetry/usage.js"
import {
  heroImageQueryFromContext,
  imageKeywordsFromQuery,
  generateVariationImageWithOpenAI,
  resolveUnsplashImage,
  isExplicitImageGenRequest,
  extractImagePromptFromMessage
} from "../image/image-helpers.js"

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

// ---------------------------------------------------------------------------
// Pipeline context
// ---------------------------------------------------------------------------

export type ChatPipelineContext = {
  log: FastifyBaseLogger
  chatTelemetry: ReturnType<typeof createChatTelemetryStore>
  modelLookup: Record<AIProvider, Record<ModelKey, string>>
  availableProviders: AIProvider[]
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
      // Strip internal block IDs like "b_hero_1772150570555" or "block b_hero_..."
      .replace(/\s*\bon\s+(?:block\s+)?b_[a-z]+_\d+\b/gi, "")
      .replace(/\b(?:block\s+)?b_[a-z]+_\d+\b/gi, "")

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

function blockHasImageUrlProp(
  block: PageDoc["blocks"][number] | null | undefined
): block is PageDoc["blocks"][number] {
  if (!block) return false
  const props = block.props as Record<string, unknown>
  return typeof props === "object" && props !== null && Object.prototype.hasOwnProperty.call(props, "imageUrl")
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
  onStatusUpdate?: (message: string) => void
}): Promise<EditPlan> {
  const lowerMessage = args.message.toLowerCase()
  if (args.plan.intent !== "edit_plan") return args.plan

  const explicitUnsplashRequest = lowerMessage.includes("unsplash")
  const explicitImageGen = isExplicitImageGenRequest(args.message)
  const userImagePrompt = extractImagePromptFromMessage(args.message)
  args.log.info(
    {
      event: "hero_image_rewrite_start",
      chatRequestId: args.chatRequestId,
      slug: args.slug,
      explicitUnsplashRequest,
      explicitImageGen,
      hasUserImagePrompt: Boolean(userImagePrompt),
      message: args.message
    },
    "Evaluating hero image rewrite"
  )

  const plan = structuredClone(args.plan)
  let changed = false
  let placeholderSkipped = false
  let sourceQuery: string | undefined
  let imageSource: "ai-generated" | "unsplash" | "placeholder" = "placeholder"

  for (const op of plan.ops) {
    if (op.op !== "update_props" || op.pageSlug !== args.slug) continue
    const target = args.currentPage.blocks.find((block) => block.id === op.blockId)
    if (!blockHasImageUrlProp(target)) continue

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
    const shouldReplace =
      !userProvidedExplicitUrl && touchesImage && (explicitUnsplashRequest || requestedImageUrl.length > 0 || explicitImageGen)
    if (!touchesImage || !shouldReplace) continue

    const query = heroImageQueryFromContext({
      message: args.message,
      currentPage: args.currentPage,
      targetBlock: target,
      patchCandidate
    })
    const targetProps = target.props as Record<string, unknown>
    const heading = typeof targetProps.heading === "string" ? targetProps.heading : ""
    const subheading = typeof targetProps.subheading === "string" ? targetProps.subheading : ""
    const title = typeof targetProps.title === "string" ? targetProps.title : ""
    const body = typeof targetProps.body === "string" ? targetProps.body : ""
    const sectionContext = [heading, subheading, title, body].filter(Boolean).join(" — ")
    const currentImageUrl = typeof targetProps.imageUrl === "string" ? targetProps.imageUrl : ""

    let resolved: UnsplashImage | null = null
    if (!explicitUnsplashRequest && process.env.OPENAI_API_KEY) {
      args.onStatusUpdate?.("Generating image...")

      // When the user provides a detailed image description (after "generate image: ..."),
      // use it directly as the prompt. Otherwise fall back to the generic prompt.
      let generatedPrompt: string
      let generatedAlt: string
      if (userImagePrompt) {
        generatedAlt = userImagePrompt.slice(0, 200)
        generatedPrompt = [
          "Use case: website section image",
          `Page: ${args.currentPage.title} (${args.slug})`,
          `Section: ${target.type} — ${sectionContext}`,
          userImagePrompt,
          "Constraints: no text, no logos, no watermark"
        ].join("\n")
      } else {
        generatedAlt = `AI-generated ${target.type} image featuring ${query}`
        generatedPrompt = [
          "Use case: website section image update",
          `Page: ${args.currentPage.title} (${args.slug})`,
          `Section: ${target.type} — ${sectionContext}`,
          `Primary subject: ${query}`,
          "Style: photorealistic editorial product photography",
          "Composition: clean landscape frame with clear focal subject",
          "Lighting: natural and vibrant",
          "Constraints: no text, no logos, no watermark"
        ].join("\n")
      }
      resolved = await generateVariationImageWithOpenAI({ prompt: generatedPrompt, altText: generatedAlt, log: args.log })
      if (resolved) imageSource = "ai-generated"
    }
    if (!resolved) {
      args.onStatusUpdate?.("Finding a suitable image...")
      // Pass current imageUrl as "used" so Unsplash returns a different image
      const usedImageUrls = currentImageUrl ? new Set([currentImageUrl]) : undefined
      resolved = await resolveUnsplashImage(query, { subjectKeywords: imageKeywordsFromQuery(query, 4), usedImageUrls }, { chatRequestId: args.chatRequestId, logger: args.log })
      if (resolved) imageSource = resolved.url.includes("unsplash") ? "unsplash" : "placeholder"
    }

    // Don't insert a random placeholder — a random unrelated image is worse than keeping
    // the current one. Remove image fields from the patch; other prop changes still apply.
    if (!resolved || imageSource === "placeholder") {
      delete patchCandidate.imageUrl
      delete patchCandidate.imageAlt
      args.log.warn(
        { event: "image_rewrite_skip_placeholder", chatRequestId: args.chatRequestId, query },
        "Skipping placeholder image — no relevant image source available"
      )
      placeholderSkipped = true
      continue
    }

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
        event: "image_rewrite_applied",
        chatRequestId: args.chatRequestId,
        slug: args.slug,
        blockId: op.blockId,
        query,
        explicitUnsplashRequest,
        previousImageUrl: requestedImageUrl,
        nextImageUrl: resolved.url,
        nextImageAlt: nextPatch.imageAlt
      },
      "Applied image rewrite"
    )
    changed = true
  }

  // Also resolve Hero images inside create_page ops (new pages with embedded Hero blocks).
  for (const op of plan.ops) {
    if (op.op !== "create_page") continue
    const page = (op as unknown as { page: PageDoc }).page
    if (!page?.blocks) continue
    for (const block of page.blocks) {
      if (block.type !== "Hero") continue
      const props = block.props as Record<string, unknown>
      const placeholderUrl = typeof props.imageUrl === "string" ? props.imageUrl.trim() : ""
      // Skip if the user provided an explicit URL in the message
      if (firstUrlFromText(args.message)) continue
      // Resolve when the Hero has no image or a local placeholder path (e.g. /hero-generated.svg).
      // Preserve explicit remote URLs that the planner/user already chose.
      if (shouldResolveCreatePageHeroImage(placeholderUrl)) {
        const heading = typeof props.heading === "string" ? props.heading : ""
        const subheading = typeof props.subheading === "string" ? props.subheading : ""
        const pageTitle = typeof page.title === "string" ? page.title : ""
        const candidates = [heading, subheading, pageTitle].filter(Boolean)
        const query = candidates.length > 0
          ? imageKeywordsFromQuery(candidates.join(" "), 4).join(" ") || pageTitle || "hero image"
          : "hero image"

        let resolved: UnsplashImage | null = null
        if (process.env.OPENAI_API_KEY) {
          args.onStatusUpdate?.("Generating image for new page...")
          const sectionContext = [heading, subheading].filter(Boolean).join(" — ")
          const generatedAlt = `AI-generated hero image featuring ${query}`
          const generatedPrompt = [
            "Use case: website hero image for a new page",
            `Page: ${pageTitle} (${page.slug})`,
            `Section: Hero — ${sectionContext}`,
            `Primary subject: ${query}`,
            "Style: photorealistic editorial product photography",
            "Composition: clean landscape frame with clear focal subject",
            "Lighting: natural and vibrant",
            "Constraints: no text, no logos, no watermark"
          ].join("\n")
          resolved = await generateVariationImageWithOpenAI({ prompt: generatedPrompt, altText: generatedAlt, log: args.log })
        }
        if (!resolved) {
          args.onStatusUpdate?.("Finding image for new page...")
          resolved = await resolveUnsplashImage(query, { subjectKeywords: imageKeywordsFromQuery(query, 4) }, { chatRequestId: args.chatRequestId, logger: args.log })
        }
        if (resolved) {
          props.imageUrl = resolved.url
          props.imageAlt = resolved.alt
          changed = true
          args.log.info(
            { event: "hero_image_create_page_resolved", chatRequestId: args.chatRequestId, pageSlug: page.slug, query, imageUrl: resolved.url },
            "Resolved hero image for create_page"
          )
        }
      }
    }
  }

  if (!changed && (explicitUnsplashRequest || explicitImageGen) && /\b(image|photo|picture|hero)\b/.test(lowerMessage)) {
    const selectedBlock =
      args.activeBlockId && args.currentPage.blocks.find((block) => block.id === args.activeBlockId)
        ? args.currentPage.blocks.find((block) => block.id === args.activeBlockId)
        : null
    const fallbackHero =
      blockHasImageUrlProp(selectedBlock)
        ? selectedBlock
        : args.currentPage.blocks.find((block) => blockHasImageUrlProp(block)) ?? null

    if (fallbackHero) {
      const query = heroImageQueryFromContext({
        message: args.message,
        currentPage: args.currentPage,
        targetBlock: fallbackHero
      })

      let resolved: UnsplashImage | null = null
      if (!explicitUnsplashRequest && process.env.OPENAI_API_KEY && (explicitImageGen || userImagePrompt)) {
        args.onStatusUpdate?.("Generating image...")
        const targetProps = fallbackHero.props as Record<string, unknown>
        const heading = typeof targetProps.heading === "string" ? targetProps.heading : ""
        const subheading = typeof targetProps.subheading === "string" ? targetProps.subheading : ""
        const sectionContext = [heading, subheading].filter(Boolean).join(" — ")

        let generatedPrompt: string
        let generatedAlt: string
        if (userImagePrompt) {
          generatedAlt = userImagePrompt.slice(0, 200)
          generatedPrompt = [
            "Use case: website section image",
            `Page: ${args.currentPage.title} (${args.slug})`,
            `Section: ${fallbackHero.type} — ${sectionContext}`,
            userImagePrompt,
            "Constraints: no text, no logos, no watermark"
          ].join("\n")
        } else {
          generatedAlt = `AI-generated ${fallbackHero.type} image featuring ${query}`
          generatedPrompt = [
            "Use case: website section image update",
            `Page: ${args.currentPage.title} (${args.slug})`,
            `Section: ${fallbackHero.type} — ${sectionContext}`,
            `Primary subject: ${query}`,
            "Style: photorealistic editorial product photography",
            "Composition: clean landscape frame with clear focal subject",
            "Lighting: natural and vibrant",
            "Constraints: no text, no logos, no watermark"
          ].join("\n")
        }
        resolved = await generateVariationImageWithOpenAI({ prompt: generatedPrompt, altText: generatedAlt, log: args.log })
        if (resolved) imageSource = "ai-generated"
      }
      if (!resolved) {
        args.onStatusUpdate?.("Finding a suitable image...")
        const fbProps = fallbackHero.props as Record<string, unknown>
        const fbCurrentUrl = typeof fbProps.imageUrl === "string" ? fbProps.imageUrl : ""
        const fbUsedUrls = fbCurrentUrl ? new Set([fbCurrentUrl]) : undefined
        resolved = await resolveUnsplashImage(
          query,
          { subjectKeywords: imageKeywordsFromQuery(query, 4), usedImageUrls: fbUsedUrls },
          { chatRequestId: args.chatRequestId, logger: args.log }
        )
        if (resolved) imageSource = resolved.url.includes("unsplash") ? "unsplash" : "placeholder"
      }
      // Don't push a new op just to insert a random placeholder
      if (!resolved || imageSource === "placeholder") {
        placeholderSkipped = true
      } else {
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
  }

  // Remove update_props ops left with empty patches after image field stripping
  if (placeholderSkipped) {
    plan.ops = plan.ops.filter((op) => {
      if (op.op !== "update_props") return true
      const patch = op.patch as Record<string, unknown>
      const inner =
        patch && typeof patch.props === "object" && patch.props !== null && !Array.isArray(patch.props)
          ? (patch.props as Record<string, unknown>)
          : patch
      return Object.keys(inner).filter((k) => k !== "props").length > 0
    })
  }

  if (placeholderSkipped && !changed) {
    plan.change_log = [
      ...plan.change_log,
      "Could not find a matching image — configure UNSPLASH_ACCESS_KEY for relevant image search."
    ]
  }

  if (changed) {
    const sourceLabel =
      imageSource === "ai-generated" ? "Generated a new image with AI"
      : imageSource === "unsplash" ? "Found a matching image from Unsplash"
      : "Set Hero image from placeholder"
    plan.change_log = [...plan.change_log, `${sourceLabel}.`]
    // Rewrite summary to not mislead about the actual image source
    plan.summary_for_user = plan.summary_for_user
      .replace(/\bUnsplash\s+/gi, "")
      .replace(/\bfrom unsplash\b/gi, "")
      .replace(/\ban?\s+unsplash\b/gi, "a new")
  } else {
    args.log.info(
      {
        event: "image_rewrite_skipped",
        chatRequestId: args.chatRequestId,
        slug: args.slug,
        explicitUnsplashRequest,
        message: args.message
      },
      "Skipped image rewrite"
    )
  }

  return plan
}

export function shouldResolveCreatePageHeroImage(imageUrl: string) {
  const normalized = imageUrl.trim()
  if (!normalized) return true
  return !/^https?:\/\//i.test(normalized)
}

// ---------------------------------------------------------------------------
// Synchronous image-op detection (no API calls)
// ---------------------------------------------------------------------------

export function detectImageOps(args: {
  plan: EditPlan
  message: string
  slug: string
  currentPage: PageDoc
  activeBlockId?: string
  activeEditablePath?: string
}): PendingImageGeneration[] {
  const lowerMessage = args.message.toLowerCase()
  if (args.plan.intent !== "edit_plan") return []

  const explicitUnsplashRequest = lowerMessage.includes("unsplash")
  const explicitImageGen = isExplicitImageGenRequest(args.message)
  const results: PendingImageGeneration[] = []

  for (const op of args.plan.ops) {
    if (op.op !== "update_props" || op.pageSlug !== args.slug) continue
    const target = args.currentPage.blocks.find((block) => block.id === op.blockId)
    if (!blockHasImageUrlProp(target)) continue

    const rawPatch = op.patch as Record<string, unknown>
    const patchCandidate =
      rawPatch && typeof rawPatch.props === "object" && rawPatch.props !== null && !Array.isArray(rawPatch.props)
        ? (rawPatch.props as Record<string, unknown>)
        : rawPatch

    const touchesImage =
      Object.prototype.hasOwnProperty.call(patchCandidate, "imageUrl") ||
      args.activeEditablePath === "imageUrl" ||
      /\b(image|photo|picture)\b/.test(lowerMessage)
    const userProvidedExplicitUrl = Boolean(firstUrlFromText(args.message))
    const hasImageUrlInPatch = typeof patchCandidate.imageUrl === "string" && patchCandidate.imageUrl.trim().length > 0
    const shouldReplace =
      !userProvidedExplicitUrl &&
      touchesImage &&
      (explicitUnsplashRequest || hasImageUrlInPatch || explicitImageGen)
    if (!touchesImage || !shouldReplace) continue

    const query = heroImageQueryFromContext({
      message: args.message,
      currentPage: args.currentPage,
      targetBlock: target,
      patchCandidate
    })
    const provider: PendingImageGeneration["provider"] =
      explicitUnsplashRequest ? "unsplash"
      : process.env.OPENAI_API_KEY ? "auto"
      : "unsplash"

    results.push({ blockId: op.blockId, pageSlug: op.pageSlug, query, provider })
  }

  // Fallback: explicit image request targeting a Hero block when no ops matched
  if (results.length === 0 && (explicitUnsplashRequest || explicitImageGen) && /\b(image|photo|picture|hero)\b/.test(lowerMessage)) {
    const selectedBlock =
      args.activeBlockId && args.currentPage.blocks.find((block) => block.id === args.activeBlockId)
        ? args.currentPage.blocks.find((block) => block.id === args.activeBlockId)
        : null
    const fallbackHero =
      blockHasImageUrlProp(selectedBlock)
        ? selectedBlock
        : args.currentPage.blocks.find((block) => blockHasImageUrlProp(block)) ?? null

    if (fallbackHero) {
      const query = heroImageQueryFromContext({
        message: args.message,
        currentPage: args.currentPage,
        targetBlock: fallbackHero
      })
      const provider: PendingImageGeneration["provider"] =
        explicitUnsplashRequest ? "unsplash"
        : process.env.OPENAI_API_KEY ? "auto"
        : "unsplash"
      results.push({ blockId: fallbackHero.id, pageSlug: args.slug, query, provider })
    }
  }

  return results
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

function buildMetaChangeLogEntries(ops: Operation[]): string[] {
  const lines: string[] = []
  for (const op of ops) {
    if (op.op !== "update_page_meta") continue
    const patch = op.patch as Record<string, unknown>
    if (typeof patch.title === "string" && patch.title.length > 0) {
      lines.push(`SEO title \u2192 "${patch.title}"`)
    }
    if (typeof patch.description === "string" && patch.description.length > 0) {
      lines.push(`Meta description \u2192 "${patch.description}"`)
    }
    if (typeof patch.ogImage === "string" && patch.ogImage.length > 0) {
      lines.push(`OG image \u2192 ${patch.ogImage}`)
    }
  }
  return lines
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

  // When the user asks for content generation beyond simple scaffolding,
  // defer to the AI planner which can produce meaningful content.
  if (requestsContentGeneration(args.message)) return null

  // When the slug is the generic fallback, defer to the LLM so it can derive
  // a meaningful slug from the page name (e.g. "Mountain Climbers" → /mountain-climbers).
  if (requestedSlug === "/new-page") return null

  return buildCreatePagePlan({ session: args.session, requestedSlug, userMessage: args.message })
}

function shouldReturnDeterministicClarification(message: string) {
  const lower = message.toLowerCase()
  return (
    isStandalonePageOperation(message) ||
    /\b(delete|remove)\b.*\b(page|home)\b/.test(lower) ||
    /\b(rename|move)\b.*\bpage\b/.test(lower)
  )
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
    onStatusUpdate?: (message: string) => void
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
  const messageWithContext = withSiteContext(body.message ?? "", {
    sitePurpose: body.sitePurpose,
    siteHosting: body.siteHosting,
    businessContext: body.businessContext,
    siteContext: body.siteContext
  })
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

  const requestedProvider = body.provider ?? (ctx.availableProviders[0] as AIProvider | undefined)
  const provider: AIProvider = requestedProvider && ctx.availableProviders.includes(requestedProvider) ? requestedProvider : "openai"
  const modelKey = body.modelKey && ctx.modelLookup[provider][body.modelKey] ? body.modelKey : (process.env.OPENAI_MODEL_KEY as ModelKey | undefined) ?? "balanced"
  const modelUsed = ctx.modelLookup[provider][modelKey]
  const plannerSource: "openai" | "anthropic" | "demo" =
    provider === "anthropic" && process.env.ANTHROPIC_API_KEY ? "anthropic" :
    provider === "openai" && process.env.OPENAI_API_KEY ? "openai" :
    process.env.OPENAI_API_KEY ? "openai" :
    process.env.ANTHROPIC_API_KEY ? "anthropic" : "demo"
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

  let planUsage: TokenUsage | undefined

  const respondFromPlan = async (
    plan: EditPlan,
    source: "openai" | "anthropic" | "demo",
    applyMode: "apply_now" | "plan_only" = "apply_now",
    optionsOverride?: { preResolvedPlan?: boolean }
  ) => {
    const usageFields = planUsage ? {
      inputTokens: planUsage.inputTokens,
      outputTokens: planUsage.outputTokens,
      totalTokens: planUsage.totalTokens,
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
      ...usageFields
    })
    let resolvedPlan = plan
    let detectedImageOps: PendingImageGeneration[] = []
    let effectiveApplyMode = applyMode
    if (!optionsOverride?.preResolvedPlan) {
      resolvedPlan = normalizePlanCopyForUi(plan, current)

      // Detect image ops synchronously before making any API calls
      detectedImageOps = detectImageOps({
        plan: resolvedPlan,
        message: plannerMessage,
        slug: effectiveSlug,
        currentPage: current,
        activeBlockId: body.activeBlockId,
        activeEditablePath: body.activeEditablePath
      })

      if (detectedImageOps.length > 0) {
        // Force plan approval so user can review before expensive image generation
        effectiveApplyMode = "plan_only"

        // Strip placeholder imageUrl values from ops so preview shows current image
        for (const op of resolvedPlan.ops) {
          if (op.op !== "update_props") continue
          const imgOp = detectedImageOps.find((io) => io.blockId === op.blockId && io.pageSlug === op.pageSlug)
          if (!imgOp) continue
          const rawPatch = op.patch as Record<string, unknown>
          const patchCandidate =
            rawPatch && typeof rawPatch.props === "object" && rawPatch.props !== null && !Array.isArray(rawPatch.props)
              ? (rawPatch.props as Record<string, unknown>)
              : rawPatch
          delete patchCandidate.imageUrl
          delete patchCandidate.imageAlt
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
        // No image ops detected — run withUnsplashHeroImage as before (will be a no-op)
        resolvedPlan = await withUnsplashHeroImage({
          plan: resolvedPlan,
          message: plannerMessage,
          slug: effectiveSlug,
          currentPage: current,
          activeBlockId: body.activeBlockId,
          activeEditablePath: body.activeEditablePath,
          chatRequestId,
          log: ctx.log,
          onStatusUpdate: options?.onStatusUpdate
        })
      }

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
        requestedSlug,
        effectiveSlug,
        summary: resolvedPlan.summary_for_user,
        source,
        modelUsed,
        modelKey,
        plan: structuredClone(resolvedPlan),
        ...(detectedImageOps.length > 0 ? { pendingImageOps: detectedImageOps, originalMessage: plannerMessage } : {})
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
        try {
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
        } catch (progressiveError) {
          // Roll back to pre-plan state so we don't leave a partially-applied plan.
          for (const [slug, snapshot] of rollbackBySlug) {
            setPage(body.session!, { ...snapshot, slug })
          }
          throw progressiveError
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
      const metaChangeLogEntries = buildMetaChangeLogEntries(resolvedPlan.ops)
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
        ...usageFields
      })
      return {
        done: true as const,
        response: {
          code: 200,
          payload: withDebugPayload({
            status: "applied",
            summary: resolvedPlan.summary_for_user,
            changes: [...resolvedPlan.change_log, ...metaChangeLogEntries, ...aiInsightChanges],
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
            ...usageFields
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
    // Run deferred image generation if the pending plan has image ops
    let approvalPlan = pending.plan
    try {
      if (pending.pendingImageOps && pending.pendingImageOps.length > 0) {
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
          if (!Object.prototype.hasOwnProperty.call(patchTarget, "imageUrl")) {
            patchTarget.imageUrl = "pending"
          }
        }

        approvalPlan = await withUnsplashHeroImage({
          plan: planClone,
          message: imageMessage,
          slug: pending.effectiveSlug,
          currentPage: current,
          activeBlockId: body.activeBlockId,
          activeEditablePath: body.activeEditablePath,
          chatRequestId,
          log: ctx.log,
          onStatusUpdate: options?.onStatusUpdate
        })
      }
      const approvedOutcome = await respondFromPlan(approvalPlan, pending.source, "apply_now", { preResolvedPlan: true })
      if (approvedOutcome.done) return approvedOutcome.response
      return guardrailFailureResponse({ reason: approvedOutcome.reason, source: pending.source })
    } catch (error) {
      const reason = toErrorDetail(error)
      ctx.log.error({ event: "apply_pending_plan_error", chatRequestId, error: reason }, "Pending plan execution failed")
      pendingApprovalPlanBySession.delete(body.session!)
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

  if (plannerSource === "demo") {
    try {
      const demoPlan = demoPlanFromMessageImpl(plannerMessage, effectiveSlug, body.activeBlockId, body.activeBlockType)
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

  const deterministicIntent = inferDeterministicIntent({
    message: plannerMessage,
    currentPage: current,
    activeBlockId: body.activeBlockId,
    activeEditablePath: body.activeEditablePath
  })

  if (deterministicIntent) {
    const deterministicPlan = compileDeterministicPlan({
      session: body.session,
      intent: deterministicIntent,
      message: plannerMessage,
      slug: effectiveSlug,
      currentPage: current,
      activeBlockId: body.activeBlockId,
      activeEditablePath: body.activeEditablePath
    })

    if (deterministicPlan?.intent === "edit_plan" && deterministicPlan.ops.length > 0) {
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
        opTypes: deterministicPlan.ops.map((op) => op.op)
      })
      const deterministicOutcome = await respondFromPlan(deterministicPlan, plannerSource, applyMode)
      if (deterministicOutcome.done) return deterministicOutcome.response
    }

    if (
      deterministicPlan?.intent === "needs_clarification" &&
      shouldReturnDeterministicClarification(plannerMessage)
    ) {
      const deterministicOutcome = await respondFromPlan(deterministicPlan, plannerSource, applyMode)
      if (deterministicOutcome.done) return deterministicOutcome.response
    }
  }

  const generatePlanImpl = plannerSource === "anthropic" ? generatePlanWithAnthropicImpl : generatePlanWithOpenAIImpl
  const maxPlanningAttempts = 3
  let initialPlan: EditPlan | null = null
  const planningErrors: string[] = []

  for (let attempt = 1; attempt <= maxPlanningAttempts; attempt += 1) {
    try {
      const result = await generatePlanImpl({
        message: plannerMessage,
        slug: effectiveSlug,
        currentPage: current,
        contextPack,
        model: modelUsed,
        history: sessionChatHistory,
        onToken: options?.onPlanningToken
      })
      initialPlan = result.plan
      planUsage = result.usage
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

  const initialOutcome = await respondFromPlan(initialPlan, plannerSource, applyMode)
  if (initialOutcome.done) return initialOutcome.response

  if (!isDeterministicRepairEligible(initialOutcome.reason)) {
    return guardrailFailureResponse({ reason: initialOutcome.reason, source: plannerSource })
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
    const repairResult = await generatePlanImpl({
      message: plannerMessage,
      slug: effectiveSlug,
      currentPage: current,
      contextPack,
      model: modelUsed,
      history: sessionChatHistory,
      feedback: buildDeterministicRepairFeedback(initialOutcome.reason),
      onToken: options?.onPlanningToken
    })
    repairedPlan = repairResult.plan
    planUsage = repairResult.usage
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

  const repairedOutcome = await respondFromPlan(repairedPlan, plannerSource, applyMode)
  if (repairedOutcome.done) return repairedOutcome.response
  return guardrailFailureResponse({ reason: repairedOutcome.reason, source: plannerSource })
}
