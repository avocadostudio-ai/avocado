import {
  type EditPlan,
  type PageDoc
} from "@ai-site-editor/shared"
import {
  normalizeRouteCandidate,
  toSeedSlug
} from "./intent-helpers.js"
import {
  stripSiteContextEnvelope,
  extractSiteContextLineValue
} from "./intent-detection.js"
import {
  defaultPropsForType,
  pageIdFromSlug,
  pageTitleFromSlug
} from "./plan-normalizer.js"
import { getSessionDraft } from "../state/session-state.js"
import { titleCaseSentence } from "./deterministic-planner-suggestions.js"

export function nextAvailableSlug(session: string, baseSlug: string) {
  const draft = getSessionDraft(session)
  if (!draft.has(baseSlug)) return baseSlug
  let idx = 2
  while (draft.has(`${baseSlug}-${idx}`)) idx += 1
  return `${baseSlug}-${idx}`
}

export function createPageBlocks(args: { requestedSlug: string; userMessage?: string }) {
  const seed = toSeedSlug(args.requestedSlug.replace(/^\//, "") || "new-page") || "new-page"
  const rawMessage = typeof args.userMessage === "string" ? args.userMessage : ""
  const cleanMessage = stripSiteContextEnvelope(rawMessage)
  const lowerMessage = cleanMessage.toLowerCase()

  const asksIntentPage = /\b(intent|purpose|mission)\b/.test(lowerMessage)
  const asksHero = /\bhero\b/.test(lowerMessage)
  const asksText = /\b(rich[\s-]?text|text(?:\s+section|\s+block)?|copy)\b/.test(lowerMessage)
  const asksCta = /\bcta\b|\bcall to action\b|\baction button\b/.test(lowerMessage)
  const asksFeatures = /\bfeatures?\b/.test(lowerMessage)
  const asksFaq = /\bfaq\b/.test(lowerMessage)
  const asksTestimonials = /\btestimonials?\b/.test(lowerMessage)
  const asksCards = /\bcards?\b/.test(lowerMessage)
  const asksStructuredSections = asksHero || asksText || asksCta || asksFeatures || asksFaq || asksTestimonials || asksCards
  const sitePurpose = extractSiteContextLineValue(rawMessage, "Site purpose")
  const pageTitle = pageTitleFromSlug(args.requestedSlug)

  // Extract explicit hero heading from message (e.g. "hero titled 'About Us'")
  const heroTitleMatch = cleanMessage.match(/hero\s+(?:titled?|called|named|with\s+(?:the\s+)?(?:title|heading))\s+['"]([^'"]+)['"]/i)
  const heroHeading = heroTitleMatch?.[1] ?? (asksIntentPage ? "Purpose of This Site" : pageTitle)
  const heroSubheading = sitePurpose
    ? `This page explains ${sitePurpose}.`
    : asksIntentPage
      ? "This page explains what this site is for, who it helps, and the value it provides."
      : `Use this page to introduce ${pageTitle}.`
  const ctaText = asksIntentPage ? "Explore the site" : "Get started"
  const ctaHref = "/"
  const ctaTitle = asksIntentPage ? "Ready to learn more?" : `Ready to explore ${pageTitle}?`
  const ctaDescription = sitePurpose
    ? `Continue to discover how ${sitePurpose} translates into concrete next steps.`
    : asksIntentPage
      ? "Review the key points, then continue to the next step."
      : "Continue to the next step."
  const richTextBody = sitePurpose
    ? `Site intent: ${titleCaseSentence(sitePurpose)}.\n\nUse this section to explain the problem the site solves, who it serves, and what users should do next.`
    : asksIntentPage
      ? "This page captures the site intent: why it exists, who it serves, and what outcomes it helps users achieve.\n\nUse this section to add concrete details and examples."
      : `Use this section to describe ${pageTitle} in detail.\n\nAdd context, benefits, and a clear next step for visitors.`

  const blocks: PageDoc["blocks"] = [
    {
      id: `b_hero_${seed}`,
      type: "Hero",
      props: {
        ...defaultPropsForType("Hero"),
        heading: heroHeading,
        subheading: heroSubheading,
        ctaText,
        ctaHref
      }
    }
  ]

  if (asksStructuredSections && asksText) {
    blocks.push({
      id: `b_richtext_${seed}`,
      type: "RichText",
      props: {
        ...defaultPropsForType("RichText"),
        body: richTextBody
      }
    })
  }

  if (asksStructuredSections && asksFeatures) {
    blocks.push({
      id: `b_features_${seed}`,
      type: "FeatureGrid",
      props: defaultPropsForType("FeatureGrid")
    })
  }

  if (asksStructuredSections && asksTestimonials) {
    blocks.push({
      id: `b_testimonials_${seed}`,
      type: "Testimonials",
      props: defaultPropsForType("Testimonials")
    })
  }

  if (asksStructuredSections && asksFaq) {
    blocks.push({
      id: `b_faq_${seed}`,
      type: "FAQAccordion",
      props: defaultPropsForType("FAQAccordion")
    })
  }

  if (asksStructuredSections && asksCards) {
    blocks.push({
      id: `b_cardgrid_${seed}`,
      type: "CardGrid",
      props: defaultPropsForType("CardGrid")
    })
  }

  if (asksStructuredSections && asksCta) {
    blocks.push({
      id: `b_cta_${seed}`,
      type: "CTA",
      props: {
        ...defaultPropsForType("CTA"),
        title: ctaTitle,
        description: ctaDescription,
        ctaText,
        ctaHref
      }
    })
  }

  return blocks
}

export function buildCreatePagePlan(args: { session: string; requestedSlug: string; assumptions?: string[]; userMessage?: string }) {
  const normalizedRequested = normalizeRouteCandidate(args.requestedSlug)
  if (!normalizedRequested || normalizedRequested === "/") return null
  const draft = getSessionDraft(args.session)
  if (draft.has(normalizedRequested)) {
    return {
      intent: "needs_clarification",
      summary_for_user: `Page ${normalizedRequested} already exists. Provide a different page path.`,
      change_log: args.assumptions ?? [],
      ops: []
    } satisfies EditPlan
  }

  const now = new Date().toISOString()
  const page: PageDoc = {
    id: pageIdFromSlug(normalizedRequested),
    slug: normalizedRequested,
    title: pageTitleFromSlug(normalizedRequested),
    updatedAt: now,
    blocks: createPageBlocks({ requestedSlug: normalizedRequested, userMessage: args.userMessage })
  }
  return {
    intent: "edit_plan",
    summary_for_user: `Created page ${normalizedRequested}.`,
    change_log: [...(args.assumptions ?? []), `Created new page ${normalizedRequested}.`],
    ops: [{ op: "create_page", page }]
  } satisfies EditPlan
}

export function isPageRouteRenameRequest(message?: string) {
  if (!message) return false
  const lower = message.toLowerCase()
  const mentionsRoute = lower.includes("slug") || lower.includes("path") || lower.includes("route") || /\/[a-z0-9/_-]*/i.test(message)
  const asksRename =
    lower.includes("rename") ||
    lower.includes("change") ||
    lower.includes("update") ||
    lower.includes("move") ||
    lower.includes("switch")
  const mentionsPage = lower.includes("page") || lower.includes("this page")
  if (mentionsRoute && asksRename && mentionsPage) return true
  // "rename page to Our community" — natural language name after "to"
  // Exclude position words (first/last/top/bottom) which indicate nav move, not rename
  const hasRenameVerb = lower.includes("rename") || lower.includes("change") || lower.includes("switch")
  const hasTarget = /\bto\s+[A-Za-z]/.test(message) &&
    !/\bto\s+(first|last|top|bottom|start|end|beginning)\b/i.test(message)
  if (hasRenameVerb && mentionsPage && hasTarget) return true
  // "rename to Olive oil" — implicit current page (no "page" keyword needed when verb is "rename")
  if (lower.includes("rename") && hasTarget) return true
  return false
}
