import { z } from "zod"
import {
  allowedBlockTypes,
  blockSchemas,
  editPlanSchema,
  getAllBlockMeta,
  getPropDisplayName,
  type BlockType,
  type EditPlan,
  type Operation,
  type PageDoc
} from "@ai-site-editor/shared"
import {
  extractRouteMentions,
  firstRouteMention,
  isStandalonePageOperation,
  normalizeRouteCandidate,
  parseCreatePageRequest,
  toSeedSlug
} from "./intent-helpers.js"
import {
  type ChatRequestBody,
  isAdviceQuery,
  isBatchAddRequest,
  isBlockCatalogQuery,
  isInfoQuery,
  normalizeForIntent,
  stripSiteContextEnvelope,
  extractSiteContextLineValue,
  extractMentionedBlockTypes
} from "./intent-detection.js"
import {
  defaultPropsForType,
  inferBlockTypeFromText,
  nextBlockId,
  pageIdFromSlug,
  pageTitleFromSlug,
  patchObject
} from "./plan-normalizer.js"
import {
  type ModelKey,
  getSessionDraft,
  getPage,
  getRecentEdits,
  orderSlugsHomeFirst
} from "../state/session-state.js"

export function extractAudienceTarget(message: string) {
  return extractAudienceTargets(message)[0]
}

function cleanAudienceCandidate(raw: string) {
  const cleaned = raw
    .replace(/\b(?:an?|the|only|just)\b/g, " ")
    .replace(/\b(?:audience|audiences|segment|segments)\b/g, " ")
    .replace(/[.?!:;"'`()[\]{}]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
  if (cleaned.length <= 1) return undefined
  const rejectWords = new Set([
    "a while",
    "now",
    "later",
    "free",
    "this",
    "these",
    "that",
    "those",
    "me",
    "you",
    "testing",
    "demo",
    "it",
    "here",
    "there",
    "sure",
    "fun",
    "good",
    "better",
    "best",
    "while"
  ])
  if (rejectWords.has(cleaned.toLowerCase())) return undefined
  const stopwords = new Set(["a", "an", "the", "is", "it", "to", "of", "in", "on", "for", "and", "or", "so", "if"])
  const words = cleaned.toLowerCase().split(/\s+/)
  if (words.every((w) => stopwords.has(w))) return undefined
  return cleaned
}

function splitAudienceList(raw: string) {
  return raw
    .split(/\s*(?:,|&|\band\b|\bor\b|\/)\s*/i)
    .map((part) => cleanAudienceCandidate(part))
    .filter((part): part is string => Boolean(part))
}

export function extractAudienceTargets(message: string) {
  const lower = message.toLowerCase()
  const patternMatches = [
    lower.match(/\bfor\s+([a-z0-9 ,&/-]{2,80}?)\s+(?:audience|users?|customers?|buyers?|founders?|teams?|developers?|marketers?|parents?|students?)\b/),
    lower.match(/\bfor\s+([a-z0-9 ,&/-]{2,160})$/),
    lower.match(/\btarget(?:ing)?\s+([a-z0-9 ,&/-]{2,80})\b/),
    lower.match(/\bpages?\s+for\s+([a-z0-9 ,&/-]{2,160})(?:$|[.!?])/),
    lower.match(/\bfor\s+([a-z0-9 ,&/-]{2,160})\s+pages?\b/),
    lower.match(/\b(?:create|generate|build|make|draft)\s+(?:only\s+)?([a-z0-9 ,&/-]{2,160})\s+pages?\b/)
  ]
  const raw = patternMatches.find(Boolean)?.[1]
  if (!raw) return []
  const candidates = splitAudienceList(raw)
  return [...new Set(candidates)]
}

export function titleCaseWords(text: string) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word.length > 2 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ")
}

export function addAudienceSuffix(value: string, audience: string) {
  const normalized = value.trim()
  if (!normalized) return normalized
  const audienceRe = new RegExp(`\\b${audience.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
  if (audienceRe.test(normalized)) return normalized
  return `${normalized} for ${audience}`
}

export function audiencePatchForBlock(block: PageDoc["blocks"][number], audience: string) {
  const props = block.props as Record<string, unknown>
  if (block.type === "Hero") {
    const heading = typeof props.heading === "string" ? props.heading : ""
    const subheading = typeof props.subheading === "string" ? props.subheading : ""
    const nextHeading = addAudienceSuffix(heading, audience)
    const nextSubheading = addAudienceSuffix(subheading, audience)
    const patch: Record<string, unknown> = {}
    if (nextHeading && nextHeading !== heading) patch.heading = nextHeading
    if (nextSubheading && nextSubheading !== subheading) patch.subheading = nextSubheading
    return patch
  }
  if (block.type === "RichText") {
    const body = typeof props.body === "string" ? props.body : ""
    const nextBody = body.toLowerCase().includes(audience.toLowerCase()) ? body : `For ${audience}: ${body}`
    return nextBody !== body ? { body: nextBody } : {}
  }
  if (block.type === "CTA") {
    const title = typeof props.title === "string" ? props.title : ""
    const nextTitle = addAudienceSuffix(title, audience)
    return nextTitle !== title ? { title: nextTitle } : {}
  }
  if (block.type === "FeatureGrid" || block.type === "Testimonials" || block.type === "FAQAccordion" || block.type === "CardGrid" || block.type === "Card") {
    const title = typeof props.title === "string" ? props.title : ""
    const nextTitle = addAudienceSuffix(title, audience)
    return nextTitle !== title ? { title: nextTitle } : {}
  }
  return {}
}

export function nextAvailableSlug(session: string, baseSlug: string) {
  const draft = getSessionDraft(session)
  if (!draft.has(baseSlug)) return baseSlug
  let idx = 2
  while (draft.has(`${baseSlug}-${idx}`)) idx += 1
  return `${baseSlug}-${idx}`
}

export function titleCaseSentence(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return trimmed
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
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

  const heroHeading = asksIntentPage ? "Purpose of This Site" : pageTitle
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

export function editablePropsFromBlock(block: PageDoc["blocks"][number]) {
  if (!block || !block.props || typeof block.props !== "object") return []
  return Object.keys(block.props as Record<string, unknown>)
}

export function promptFromPropKey(propKey: string) {
  const labels: Record<string, string> = {
    heading: "Change heading to \"...\"",
    subheading: "Change subheading to \"...\"",
    ctaText: "Change CTA text to \"...\"",
    ctaHref: "Change CTA link to \"/...\"",
    imageUrl: "Update hero image (e.g. cherries, sunset landscape)",
    imageAlt: "Change image alt text to \"...\"",
    secondaryCtaText: "Add secondary CTA button \"...\"",
    secondaryCtaHref: "Change secondary CTA link to \"/...\"",
    body: "Edit body text to \"...\"",
    title: "Change title to \"...\"",
    description: "Change description to \"...\"",
    features: "Update feature list",
    items: "Update items",
    cards: "Update cards"
  }
  return labels[propKey] ?? `Change ${propKey} to \"...\"`
}

export function userFacingPropNames(blockType: BlockType, keys: string[]) {
  return keys.map((key) => getPropDisplayName(blockType, key))
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"]

export function humanizeArrayPath(root: string): string {
  const match = root.match(/^([a-zA-Z_]+)\[(\d+)\]$/)
  if (!match) return root
  const [, listName, indexStr] = match
  const index = Number(indexStr)
  const ordinal = ORDINALS[index] ?? `#${index + 1}`
  const singular: Record<string, string> = {
    cards: "card",
    features: "feature",
    items: "item",
    stats: "stat",
    columns: "column"
  }
  const noun = singular[listName] ?? listName.replace(/s$/, "")
  return `the ${ordinal} ${noun}`
}

export function childSuggestions(args: { selected: PageDoc["blocks"][number]; editablePath: string }) {
  const { selected, editablePath } = args
  const path = editablePath.trim()
  if (!path) return []
  const root = path.split(".")[0] ?? path
  const human = humanizeArrayPath(root)

  if (selected.type === "CardGrid" && root.startsWith("cards[")) {
    return [
      `Update ${human}'s title to \"...\"`,
      `Update ${human}'s description to \"...\"`,
      `Update ${human}'s CTA text to \"...\"`,
      `Update ${human}'s CTA link to \"/...\"`
    ]
  }

  if (selected.type === "FeatureGrid" && root.startsWith("features[")) {
    return [`Update ${human}'s title to \"...\"`, `Update ${human}'s description to \"...\"`]
  }

  if (selected.type === "Testimonials" && root.startsWith("items[")) {
    return [`Update ${human}'s quote to \"...\"`, `Update ${human}'s author to \"...\"`]
  }

  if (selected.type === "FAQAccordion" && root.startsWith("items[")) {
    return [`Update ${human}'s question to \"...\"`, `Update ${human}'s answer to \"...\"`]
  }

  return [`Update ${human} ...`]
}

export function clarificationSuggestions(args: { body: ChatRequestBody; current: PageDoc; selected?: PageDoc["blocks"][number] | null }) {
  const { selected, current } = args
  if (selected) {
    const keys = editablePropsFromBlock(selected)
    if (keys.length > 0) return keys.slice(0, 4).map(promptFromPropKey)
    return [
      `Update ${selected.type} title to "..."`,
      `Move ${selected.type} to bottom`
    ]
  }
  const suggestions: string[] = []
  const existingTypes = new Set(current.blocks.map((b) => b.type))
  const first = current.blocks[0]
  if (first) suggestions.push(`Update ${first.type} heading to "..."`)
  if (!existingTypes.has("Testimonials")) suggestions.push("Add Testimonials section")
  else if (!existingTypes.has("FAQAccordion")) suggestions.push("Add FAQ section")
  else if (!existingTypes.has("CardGrid")) suggestions.push("Add Card Grid section")
  if (existingTypes.has("FAQAccordion")) suggestions.push("Move FAQ to bottom")
  else if (existingTypes.has("CTA")) suggestions.push("Update the CTA copy")
  if (suggestions.length === 0) suggestions.push("Change heading to \"...\"", "Add Testimonials section")
  return suggestions.slice(0, 4)
}

export function postEditSuggestions(args: { plan: EditPlan; current: PageDoc; body: ChatRequestBody }): string[] {
  const { plan, current } = args
  if (plan.ops.some((op) => op.op === "remove_page")) return []
  const suggestions: string[] = []
  const existingTypes = new Set(current.blocks.map((b) => b.type))

  for (const op of plan.ops) {
    if (op.op === "update_props") {
      const block = current.blocks.find((b) => b.id === op.blockId)
      if (block) {
        const patchKeys = Object.keys(op.patch as Record<string, unknown>)
        const otherKeys = editablePropsFromBlock(block).filter((k) => !patchKeys.includes(k))
        for (const key of otherKeys.slice(0, 2)) {
          suggestions.push(promptFromPropKey(key))
        }
      }
    } else if (op.op === "add_block") {
      suggestions.push(`Update the new ${op.block.type} content`)
    } else if (op.op === "remove_block") {
      if (!existingTypes.has("CTA")) suggestions.push("Add a CTA section")
    }
  }

  if (!existingTypes.has("Testimonials") && suggestions.length < 3) suggestions.push("Add a Testimonials section")
  if (!existingTypes.has("FAQAccordion") && suggestions.length < 3) suggestions.push("Add a FAQ section")
  if (!existingTypes.has("Stats") && suggestions.length < 4) suggestions.push("Add a Stats section")

  return suggestions.slice(0, 4)
}

export function demoPlanFromMessage(message: string, slug: string, activeBlockId?: string, activeBlockType?: string): EditPlan {
  const lower = message.toLowerCase()
  const quoted = /"([^"]+)"/.exec(message)?.[1]

  // SEO metadata patterns — checked early so "seo title" isn't mistaken for hero heading
  const hasSeoKeyword = /\b(seo|meta\s*desc|meta\s*title|og\s*image|open\s*graph)\b/.test(lower)
  if (hasSeoKeyword) {
    const seoGenerate = /\b(write|generate|create|add)\b.*\b(seo|meta)\b/.test(lower) && !quoted
    const seoSetMatch = lower.match(/\b(?:set|change|update|add)\b.*?\b(meta\s*desc(?:ription)?|seo\s*desc(?:ription)?)\b/)
      ?? lower.match(/\b(?:set|change|update|add)\b.*?\b(seo\s*title|meta\s*title)\b/)
      ?? lower.match(/\b(?:set|change|update|add)\b.*?\b(og\s*image|open\s*graph\s*image)\b/)

    if (seoSetMatch) {
      const fieldRaw = seoSetMatch[1].toLowerCase()
      const isTitle = /title/.test(fieldRaw)
      const isOgImage = /og|open\s*graph/.test(fieldRaw)

      const extractedQuoted = quoted
      const afterTo = message.match(/\bto\s+(.+)$/i)?.[1]?.trim()
      const value = extractedQuoted ?? afterTo ?? ""

      if (!value) {
        return {
          intent: "needs_clarification",
          summary_for_user: `Please provide the value — e.g. set ${isTitle ? "SEO title" : isOgImage ? "OG image" : "meta description"} to "Your value here".`,
          change_log: [],
          ops: []
        }
      }

      const patch: Record<string, string> = {}
      const fieldLabel = isTitle ? "SEO title" : isOgImage ? "OG image" : "Meta description"
      if (isTitle) patch.title = value
      else if (isOgImage) patch.ogImage = value
      else patch.description = value

      return {
        intent: "edit_plan",
        summary_for_user: `Updated the ${fieldLabel}.`,
        change_log: [`${fieldLabel} \u2192 "${value}".`],
        ops: [{ op: "update_page_meta", pageSlug: slug, patch }]
      }
    }

    if (seoGenerate) {
      return {
        intent: "needs_clarification",
        summary_for_user: "Demo mode cannot generate SEO metadata automatically. Please provide the exact title or description you'd like to set, for example: set meta description to \"Your description here\".",
        change_log: [],
        ops: []
      }
    }
  }

  if (lower.includes("make this shorter") && activeBlockId && activeBlockType === "Hero") {
    return {
      intent: "edit_plan",
      summary_for_user: "Shortened the selected hero copy.",
      change_log: ["Updated hero heading and subheading to be more concise."],
      ops: [
        {
          op: "update_props",
          pageSlug: slug,
          blockId: activeBlockId,
          patch: {
            heading: "Edit your site in seconds",
            subheading: "Describe a change and preview it instantly."
          }
        }
      ]
    }
  }

  if ((lower.includes("title") || lower.includes("heading")) && activeBlockId && activeBlockType === "Hero") {
    const headingText =
      quoted ??
      message
        .replace(/change/i, "")
        .replace(/hero/i, "")
        .replace(/title/i, "")
        .replace(/heading/i, "")
        .replace(/\bto\b/i, "")
        .trim()

    if (headingText) {
      return {
        intent: "edit_plan",
        summary_for_user: "Updated the hero title.",
        change_log: [`Changed hero heading to "${headingText}".`],
        ops: [
          {
            op: "update_props",
            pageSlug: slug,
            blockId: activeBlockId,
            patch: { heading: headingText }
          }
        ]
      }
    }
  }

  if (lower.includes("rich text") || lower.includes("richtext") || lower.includes("text block") || lower.includes("prose")) {
    if (lower.includes("add") || lower.includes("insert") || lower.includes("create")) {
      return {
        intent: "edit_plan",
        summary_for_user: "Added a rich text section.",
        change_log: ["Inserted RichText block."],
        ops: [
          {
            op: "add_block",
            pageSlug: slug,
            block: {
              id: `b_richtext_${Date.now()}`,
              type: "RichText",
              props: {
                title: "",
                body: "Add your content here.\n\nUse a second paragraph to break up the text into readable sections."
              }
            }
          }
        ]
      }
    }
    if (activeBlockId && activeBlockType === "RichText" && quoted) {
      return {
        intent: "edit_plan",
        summary_for_user: "Updated the rich text body.",
        change_log: [`Set body to "${quoted}".`],
        ops: [{ op: "update_props", pageSlug: slug, blockId: activeBlockId, patch: { body: quoted } }]
      }
    }
  }

  if (lower.includes("add testimonials")) {
    return {
      intent: "edit_plan",
      summary_for_user: "Added a testimonials section below the hero.",
      change_log: ["Inserted Testimonials block after the hero section."],
      ops: [
        {
          op: "add_block",
          pageSlug: slug,
          afterBlockId: "b_hero_home",
          block: {
            id: `b_testimonials_${Date.now()}`,
            type: "Testimonials",
            props: {
              title: "Loved by small teams",
              items: [
                { quote: "We launched in a day.", author: "Ana, Founder" },
                { quote: "Edits are now effortless.", author: "Chris, Marketer" }
              ]
            }
          }
        }
      ]
    }
  }

  if (lower.includes("remove") && activeBlockId) {
    return {
      intent: "edit_plan",
      summary_for_user: "Removed the selected block.",
      change_log: ["Deleted selected section from the page."],
      ops: [{ op: "remove_block", pageSlug: slug, blockId: activeBlockId }]
    }
  }

  return {
    intent: "needs_clarification",
    summary_for_user: "I need one clarification: what section should I change and what exactly should be updated?",
    change_log: [],
    ops: []
  }
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
  return mentionsRoute && asksRename && mentionsPage
}




export function pageMetaContractSummary() {
  return {
    op: "update_page_meta",
    fields: {
      title: "SEO/og title (falls back to page.title if absent). Max 60 chars; put primary keyword near front; avoid generic words like 'Home' or 'Welcome'; must be unique per page.",
      description: "Meta description for search engines and social sharing. 150-160 chars; front-load key info in first 110 chars (mobile truncation); include a CTA verb; use active voice; never use quotes; never repeat the title verbatim.",
      ogImage: "Open Graph image URL for social previews. Must be HTTPS; recommended dimensions 1200x630px."
    },
    notes: "Merge-patch semantics: only supplied keys are updated. Set a field to empty string to clear it. Always include the actual values you set in change_log so the user can see them (meta tags are not visible in the page preview)."
  }
}

/**
 * Per-block notes that supplement the auto-derived contract.
 * Only add entries here when the block needs guidance beyond what the registry
 * metadata can auto-generate (list-field shapes are derived automatically).
 */
const _blockNotes: Record<string, string> = {
  Hero: "Use heading for the main headline; never invent prop names. For imageUrl: use any placeholder value (the system resolves images separately); if the user provides an explicit URL, use that. Update imageAlt to describe the intended image. Do NOT mention a specific image source in summary_for_user. secondaryCtaText/secondaryCtaHref are optional: set them to add a ghost/outline secondary button beside the primary CTA; omit or set to empty string to hide it.",
  CTA: "Keep existing props unless the user asks to change them.",
  Card: "A standalone card with one CTA.",
  RichText: "body is a string; use \\n\\n to separate paragraphs. Supported inline syntax: **word** for bold, *word* for italic, [text](url) for links, '# Heading' lines become h3 headings. title is an optional section heading. Never invent prop names.",
  Stats: "stats must be a non-empty array of {value, label}. value is a short string like '10K+' or '99.9%'. title is an optional section heading.",
  TwoColumn: "Image + text side-by-side layout. imagePosition is 'left' or 'right' (default 'right'). body supports inline markdown (**bold**, *italic*, [link](url)). ctaText/ctaHref are optional: set both to show a CTA button. For imageUrl: use any placeholder value (the system resolves images separately).",
  Footer: "columns must be a non-empty array of {title, links}. links is a string with one 'Label|URL' per line (use \\n to separate). Example: 'Home|/\\nAbout|/about\\nBlog|/blog'."
}

type BlockContract = { allowedProps: string[]; required: string[]; optional?: string[]; notes: string }

/**
 * Derive block contracts from the registry so new blocks are automatically
 * included without maintaining a parallel hardcoded map.
 */
export function blockContractsSummary() {
  const allMeta = getAllBlockMeta()
  const result: Record<string, BlockContract> = {}

  for (const type of allowedBlockTypes) {
    const schema = blockSchemas[type]
    const meta = allMeta[type]
    if (!schema || !meta) continue

    // Derive allowed/required/optional from Zod schema shape
    const shape = schema.shape as Record<string, z.ZodTypeAny>
    const allProps = Object.keys(shape)
    const required: string[] = []
    const optional: string[] = []

    for (const key of allProps) {
      if (shape[key].isOptional() || shape[key] instanceof z.ZodDefault) {
        optional.push(key)
      } else {
        required.push(key)
      }
    }

    // Append list-field item shapes to notes for array props
    let autoNotes = ""
    if (meta.listFields) {
      const parts: string[] = []
      for (const [listKey, listMeta] of Object.entries(meta.listFields)) {
        const itemKeys = Object.keys(listMeta.itemFields).join(", ")
        parts.push(`${listKey} must be a non-empty array of {${itemKeys}}`)
      }
      if (parts.length > 0) autoNotes = parts.join(". ") + "."
    }

    const notes = _blockNotes[type] ?? (autoNotes || `${meta.description ?? type} Never invent prop names.`)

    const entry: BlockContract = {
      allowedProps: allProps,
      required,
      notes
    }
    if (optional.length > 0) entry.optional = optional

    result[type] = entry
  }

  return result
}

export function readPathValue(root: unknown, path: string) {
  if (!path) return undefined
  const parts: Array<string | number> = []
  const regex = /([^[.\]]+)|\[(\d+)\]/g
  for (const match of path.matchAll(regex)) {
    if (match[1]) parts.push(match[1])
    if (match[2]) parts.push(Number(match[2]))
  }
  let current: unknown = root
  for (const part of parts) {
    if (typeof part === "number") {
      if (!Array.isArray(current)) return undefined
      current = current[part]
      continue
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

export function selectedBlockSnapshot(args: { currentPage: PageDoc; activeBlockId?: string; activeEditablePath?: string }) {
  if (!args.activeBlockId) return null
  const block = args.currentPage.blocks.find((item) => item.id === args.activeBlockId)
  if (!block) return null
  const editablePath = typeof args.activeEditablePath === "string" && args.activeEditablePath.length > 0 ? args.activeEditablePath : null
  return {
    id: block.id,
    type: block.type,
    props: block.props,
    selectedEditablePath: editablePath,
    selectedEditableValue: editablePath ? readPathValue(block.props, editablePath) ?? null : null
  }
}

export const blockTypeEnum = z.enum(allowedBlockTypes as [BlockType, ...BlockType[]])
export const intentSchema = z.object({
  action: z.enum(["add", "move", "update", "remove", "info", "clarify"]),
  target_block_ref: z.string().min(1).optional(),
  target_block_type: blockTypeEnum.optional(),
  new_block_type: blockTypeEnum.optional(),
  position: z.enum(["top", "bottom", "before", "after"]).optional(),
  anchor_block_ref: z.string().min(1).optional(),
  patch: z.record(z.unknown()).optional(),
  summary: z.string().min(1).optional(),
  assumption: z.string().min(1).optional()
})
export type ParsedIntent = z.infer<typeof intentSchema>

function inferActionFromMessage(message: string): ParsedIntent["action"] | null {
  const lower = message.toLowerCase()
  const hasPageCreateCue = Boolean(parseCreatePageRequest(message))
  if (hasPageCreateCue) return "add"
  if (/\b(remove|delete)\b/.test(lower)) return "remove"
  if (/\b(move|reorder|re-arrange|rearrange)\b/.test(lower)) return "move"
  if (/\b(add|insert|create|include)\b/.test(lower)) return "add"
  if (/\b(update|change|edit|set|rewrit\w*|reword\w*|rephras\w*|replace|improve|shorten|polish\w*|refin\w*|refresh\w*|tighten\w*|clarif\w*)\b/.test(lower)) return "update"
  return null
}

function inferPatchFromMessage(args: {
  message: string
  action: ParsedIntent["action"]
  targetBlock?: PageDoc["blocks"][number]
  activeEditablePath?: string
}) {
  const { message, action, targetBlock, activeEditablePath } = args
  if (action !== "update") return undefined

  const directPatch = inferSimpleFieldPatchFromMessage(message)
  if (directPatch && Object.keys(directPatch).length > 0) return directPatch

  const quoted = quotedText(message)
  if (!quoted) return undefined

  if (activeEditablePath && /^[a-zA-Z0-9_]+$/.test(activeEditablePath)) {
    return { [activeEditablePath]: quoted }
  }

  const block = targetBlock
  if (!block) return undefined

  const allowedKeys = Object.keys(block.props as Record<string, unknown>)
  if (allowedKeys.length === 0) return undefined
  const hintedKey = inferFieldHintFromMessage(message, allowedKeys)
  if (!hintedKey) return undefined
  return { [hintedKey]: quoted }
}

export function inferDeterministicIntent(args: {
  message: string
  currentPage: PageDoc
  activeBlockId?: string
  activeEditablePath?: string
}): ParsedIntent | null {
  const raw = stripSiteContextEnvelope(args.message).trim()
  if (!raw) return null

  let action = inferActionFromMessage(raw)
  if (!action) return null

  // In focused inline-edit mode, "add image/photo" should update the selected image field,
  // not add a new block.
  if (
    action === "add" &&
    typeof args.activeEditablePath === "string" &&
    args.activeEditablePath.trim() === "imageUrl" &&
    /\b(image|photo|picture)\b/i.test(raw)
  ) {
    action = "update"
  }

  const refs = resolveReferencesFromMessage({
    message: raw,
    currentPage: args.currentPage,
    activeBlockId: args.activeBlockId
  })

  let targetBlock = refs.target
    ? args.currentPage.blocks.find((block) => block.id === refs.target?.id) ?? null
    : null
  if (!targetBlock && args.activeBlockId) {
    targetBlock = args.currentPage.blocks.find((block) => block.id === args.activeBlockId) ?? null
  }

  const inferred: ParsedIntent = { action }

  if (targetBlock) {
    inferred.target_block_ref = targetBlock.id
    inferred.target_block_type = targetBlock.type
  } else {
    const typeFromMessage = inferBlockTypeFromText(raw)
    if (typeFromMessage) inferred.target_block_type = typeFromMessage
  }

  if (action === "add") {
    const inferredAddType =
      inferAddedBlockTypeFromMessage(raw) ??
      inferBlockTypeFromText(raw) ??
      targetBlock?.type
    if (inferredAddType) inferred.new_block_type = inferredAddType
  }

  if (action === "move" || action === "add") {
    const lower = raw.toLowerCase()
    if (/\b(top|first|start|beginning)\b/.test(lower)) inferred.position = "top"
    else if (/\b(bottom|last|end)\b/.test(lower)) inferred.position = "bottom"
    else if (/\b(before|above)\b/.test(lower)) inferred.position = "before"
    else if (/\b(after|below|under)\b/.test(lower)) inferred.position = "after"

    if (refs.anchor?.id) inferred.anchor_block_ref = refs.anchor.id
  }

  const patch = inferPatchFromMessage({
    message: raw,
    action,
    targetBlock: targetBlock ?? undefined,
    activeEditablePath: args.activeEditablePath
  })
  if (patch && Object.keys(patch).length > 0) inferred.patch = patch

  return inferred
}

export function inferAddedBlockTypeFromMessage(message: string): BlockType | undefined {
  const normalized = message.toLowerCase()
  const addMatch = normalized.match(/\b(add|create|insert)\b\s+(?:(?:a|an)\b)?\s*([a-z -]+)/)
  if (!addMatch?.[2]) return undefined
  const chunk = addMatch[2]
    .trim()
    .replace(/^(?:new|another)\s+/, "")
  if (chunk.startsWith("card grid") || chunk.startsWith("cardgrid")) return "CardGrid"
  if (chunk.startsWith("card")) return "Card"
  if (chunk.startsWith("feature grid") || chunk.startsWith("featuregrid") || chunk.startsWith("features")) return "FeatureGrid"
  if (chunk.startsWith("testimonial") || chunk.startsWith("social proof") || chunk.startsWith("review") || chunk.startsWith("quote")) return "Testimonials"
  if (chunk.startsWith("faq")) return "FAQAccordion"
  if (chunk.startsWith("two column") || chunk.startsWith("twocolumn") || chunk.startsWith("2 column")) return "TwoColumn"
  if (chunk.startsWith("stats") || chunk.startsWith("statistics") || chunk.startsWith("metrics") || chunk.startsWith("numbers")) return "Stats"
  if (chunk.startsWith("cta")) return "CTA"
  if (chunk.startsWith("hero")) return "Hero"
  if (chunk.startsWith("rich text") || chunk.startsWith("richtext") || chunk.startsWith("rich-text") || chunk.startsWith("prose") || chunk.startsWith("text block") || chunk.startsWith("section") || chunk.startsWith("paragraph") || chunk.startsWith("copy")) return "RichText"
  if (chunk.startsWith("benefit") || chunk.startsWith("advantage")) return "FeatureGrid"
  if (chunk.startsWith("pricing")) return "CardGrid"
  return undefined
}

export function resolveBlockRef(args: {
  ref?: string
  currentPage: PageDoc
  activeBlockId?: string
  fallbackType?: BlockType
}): PageDoc["blocks"][number] | null {
  const { ref, currentPage, activeBlockId, fallbackType } = args
  const blocks = currentPage.blocks
  if (typeof ref === "string" && ref.length > 0) {
    const exact = blocks.find((b) => b.id === ref)
    if (exact) return exact
    const key = ref.toLowerCase().replace(/[\s_-]/g, "")
    if (["selected", "active", "current", "this"].includes(key) && activeBlockId) {
      const selected = blocks.find((b) => b.id === activeBlockId)
      if (selected) return selected
    }
    const byType = inferBlockTypeFromText(key)
    if (byType) {
      const found = blocks.find((b) => b.type === byType)
      if (found) return found
    }
    const contains = blocks.find((b) => b.id.toLowerCase().includes(key))
    if (contains) return contains
  }

  if (activeBlockId) {
    const selected = blocks.find((b) => b.id === activeBlockId)
    if (selected) return selected
  }
  if (fallbackType) {
    const found = blocks.find((b) => b.type === fallbackType)
    if (found) return found
  }
  return null
}

export function ordinalToIndex(value: string) {
  const key = value.toLowerCase()
  if (key === "first" || key === "1st") return 0
  if (key === "second" || key === "2nd") return 1
  if (key === "third" || key === "3rd") return 2
  if (key === "fourth" || key === "4th") return 3
  if (key === "fifth" || key === "5th") return 4
  if (key === "last") return -1
  return null
}

export function resolveByDescriptor(args: { descriptor: string; currentPage: PageDoc; activeBlockId?: string }) {
  const { descriptor, currentPage, activeBlockId } = args
  const normalized = descriptor.trim().toLowerCase()
  if (!normalized) return null
  if (["this", "this block", "this section", "selected", "selected block", "current block"].includes(normalized)) {
    if (!activeBlockId) return null
    return currentPage.blocks.find((b) => b.id === activeBlockId) ?? null
  }

  const exact = currentPage.blocks.find((b) => b.id.toLowerCase() === normalized)
  if (exact) return exact

  const type = inferBlockTypeFromText(normalized)
  if (!type) return null
  const typed = currentPage.blocks.filter((b) => b.type === type)
  if (typed.length === 0) return null

  const ord = normalized.match(/\b(first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)\b/)?.[1]
  const idx = ord ? ordinalToIndex(ord) : 0
  if (idx === null) return typed[0]
  if (idx === -1) return typed[typed.length - 1]
  return typed[idx] ?? typed[0]
}

export function resolveReferencesFromMessage(args: { message: string; currentPage: PageDoc; activeBlockId?: string }) {
  const { message, currentPage, activeBlockId } = args
  const lower = message.toLowerCase()

  const mentioned = new Map<string, { id: string; type: BlockType; reason: string }>()
  const addMention = (block: PageDoc["blocks"][number] | null, reason: string) => {
    if (!block) return
    if (!mentioned.has(block.id)) mentioned.set(block.id, { id: block.id, type: block.type, reason })
  }

  if (activeBlockId) {
    const selected = currentPage.blocks.find((b) => b.id === activeBlockId) ?? null
    addMention(selected, "active_selection")
  }

  const descriptorMatches = lower.match(
    /\b(first|second|third|fourth|fifth|last)?\s*(hero|feature grid|features|testimonials?|faq|cta|card grid|card)s?\b/g
  )
  for (const match of descriptorMatches ?? []) {
    addMention(resolveByDescriptor({ descriptor: match, currentPage, activeBlockId }), "descriptor_match")
  }

  for (const block of currentPage.blocks) {
    if (lower.includes(block.id.toLowerCase())) addMention(block, "id_match")
  }

  const afterDescriptor = lower.match(/\b(?:after|below|under)\s+([a-z0-9_\-\s]+?)(?:[,.]|$)/)?.[1]?.trim()
  const beforeDescriptor = lower.match(/\b(?:before|above)\s+([a-z0-9_\-\s]+?)(?:[,.]|$)/)?.[1]?.trim()
  const primaryDescriptor = lower.match(/\b(?:update|change|edit|remove|delete|move)\s+([a-z0-9_\-\s]+?)(?:\b(?:to|into|with|after|before|above|below|under)\b|[,.]|$)/)?.[1]?.trim()

  const anchor = resolveByDescriptor({
    descriptor: afterDescriptor ?? beforeDescriptor ?? "",
    currentPage,
    activeBlockId
  })
  const target = resolveByDescriptor({
    descriptor: primaryDescriptor ?? "",
    currentPage,
    activeBlockId
  })
  addMention(anchor, "anchor_match")
  addMention(target, "target_match")

  return {
    target: target ? { id: target.id, type: target.type } : null,
    anchor: anchor ? { id: anchor.id, type: anchor.type } : null,
    mentionedBlocks: Array.from(mentioned.values()).slice(0, 8)
  }
}

export function arrayPropLengths(props: Record<string, unknown>) {
  const out: Record<string, { length: number; labels?: string[] }> = {}
  for (const [key, value] of Object.entries(props)) {
    if (!Array.isArray(value)) continue
    const labels: string[] = []
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue
      // Extract the first short string field as a label (title, heading, label, name, question)
      const obj = item as Record<string, unknown>
      const label =
        typeof obj.title === "string" ? obj.title :
        typeof obj.heading === "string" ? obj.heading :
        typeof obj.label === "string" ? obj.label :
        typeof obj.name === "string" ? obj.name :
        typeof obj.question === "string" ? obj.question :
        undefined
      if (label) labels.push(label.length > 60 ? label.slice(0, 57) + "..." : label)
    }
    out[key] = labels.length > 0 ? { length: value.length, labels } : { length: value.length }
  }
  return out
}

export function pageIntentSummary(args: { slug: string; currentPage: PageDoc }) {
  const { slug, currentPage } = args
  const typeCounts = new Map<string, number>()
  for (const block of currentPage.blocks) {
    typeCounts.set(block.type, (typeCounts.get(block.type) ?? 0) + 1)
  }
  const composition = Array.from(typeCounts.entries())
    .map(([type, count]) => (count > 1 ? `${type} x${count}` : type))
    .join(", ")
  const hero = currentPage.blocks.find((b) => b.type === "Hero")
  const heroHeading = hero && typeof (hero.props as Record<string, unknown>).heading === "string" ? (hero.props as { heading: string }).heading : ""
  const routeLabel = slug === "/" ? "Home page" : `Page ${slug}`
  const headingPart = heroHeading ? ` Hero message: "${heroHeading}".` : ""
  return `${routeLabel} with ${currentPage.blocks.length} blocks (${composition}).${headingPart}`
}

export function plannerContextPack(args: {
  session: string
  slug: string
  message: string
  currentPage: PageDoc
  activeBlockId?: string
  activeBlockType?: string
  activeEditablePath?: string
}) {
  const { session, slug, message, currentPage, activeBlockId, activeBlockType, activeEditablePath } = args
  const pageRoutes = orderSlugsHomeFirst(Array.from(getSessionDraft(session).keys()))
  const selectedIdx = activeBlockId ? currentPage.blocks.findIndex((b) => b.id === activeBlockId) : -1
  const neighbors =
    selectedIdx >= 0
      ? {
          previous: selectedIdx > 0 ? currentPage.blocks[selectedIdx - 1] : null,
          next: selectedIdx < currentPage.blocks.length - 1 ? currentPage.blocks[selectedIdx + 1] : null
        }
      : { previous: null, next: null }

  return {
    route: slug,
    pageRoutes,
    blockCount: currentPage.blocks.length,
    selected: {
      blockId: activeBlockId ?? null,
      blockType: activeBlockType ?? null,
      editablePath: activeEditablePath ?? null,
      block: selectedBlockSnapshot({ currentPage, activeBlockId, activeEditablePath })
    },
    neighbors: {
      previous: neighbors.previous ? { id: neighbors.previous.id, type: neighbors.previous.type } : null,
      next: neighbors.next ? { id: neighbors.next.id, type: neighbors.next.type } : null
    },
    pageOutline: currentPage.blocks.map((b) => {
      const bProps = b.props as Record<string, unknown>
      const arrProps = arrayPropLengths(bProps)
      // Selected block: send full props for precise editing context
      if (b.id === activeBlockId) {
        return { id: b.id, type: b.type, props: structuredClone(bProps), arrayProps: arrProps }
      }
      // Other blocks: scalar props only — keeps token count low
      const scalarProps: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(bProps)) {
        if (!Array.isArray(value) && (typeof value !== "object" || value === null)) {
          scalarProps[key] = value
        }
      }
      return { id: b.id, type: b.type, props: scalarProps, arrayProps: arrProps }
    }),
    pageMeta: currentPage.meta ?? null,
    pageIntent: pageIntentSummary({ slug, currentPage }),
    recentSuccessfulEdits: getRecentEdits(session, slug),
    resolvedReferences: resolveReferencesFromMessage({ message, currentPage, activeBlockId })
  }
}

export function coercePatchForBlock(block: PageDoc["blocks"][number], rawPatch: unknown) {
  if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) return {}
  const source =
    "props" in (rawPatch as Record<string, unknown>) &&
    (rawPatch as { props?: unknown }).props &&
    typeof (rawPatch as { props?: unknown }).props === "object" &&
    !Array.isArray((rawPatch as { props?: unknown }).props)
      ? ((rawPatch as { props: Record<string, unknown> }).props as Record<string, unknown>)
      : (rawPatch as Record<string, unknown>)

  const allowed = Object.keys(block.props as Record<string, unknown>)
  const normalizedToAllowed = new Map<string, string>()
  for (const key of allowed) normalizedToAllowed.set(key.toLowerCase(), key)

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (allowed.includes(key)) {
      out[key] = value
      continue
    }
    const mapped = normalizedToAllowed.get(key.toLowerCase())
    if (mapped) out[mapped] = value
  }

  if (block.type === "RichText" && typeof out.body === "string") {
    out.body = out.body
      .replace(/\r\n?/g, "\n")
      .replace(/([.!?])([A-Z])/g, "$1 $2")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  }

  return out
}


export function parseIndexedPath(path: string) {
  const match = /^([a-zA-Z0-9_]+)\[(\d+)\](?:\.(.+))?$/.exec(path.trim())
  if (!match) return null
  return {
    listKey: match[1],
    index: Number(match[2]),
    leaf: match[3]
  }
}

export function inferSimpleFieldPatchFromMessage(message: string) {
  const m = message
    .replace(/[“”]/g, '"')
    .match(/\b(?:change|set|update|edit)\b[\s\w]*?\b(title|description|cta\s*text|cta|link|href|quote|author|question|answer|q|a)\b[\s\w]*?\b(?:to|as)\b\s+"?([^"\n]+)"?/i)
  if (!m) return null
  const rawField = m[1].toLowerCase().replace(/\s+/g, "")
  const value = m[2]?.trim()
  if (!value) return null
  const map: Record<string, string> = {
    title: "title",
    description: "description",
    ctatext: "ctaText",
    cta: "ctaText",
    link: "ctaHref",
    href: "ctaHref",
    quote: "quote",
    author: "author",
    question: "q",
    answer: "a",
    q: "q",
    a: "a"
  }
  const key = map[rawField]
  if (!key) return null
  return { [key]: value } as Record<string, unknown>
}

export function isRewriteRequest(message: string) {
  const lower = message.toLowerCase()
  return (
    /\brewrit\w*\b/.test(lower) ||
    /\breword\w*\b/.test(lower) ||
    /\brephras\w*\b/.test(lower) ||
    /\bpolish\w*\b/.test(lower) ||
    /\brefin\w*\b/.test(lower) ||
    /\brefresh\w*\b/.test(lower) ||
    /\btighten\w*\b/.test(lower) ||
    /\bclarif\w*\b/.test(lower) ||
    /\bclean\s*up\b/.test(lower) ||
    /\bfreshen\s*up\b/.test(lower) ||
    /\bredo\b.*\b(copy|text|wording|messaging)\b/.test(lower) ||
    /\bimprove\b/.test(lower) ||
    /\bsimplif\w*\b/.test(lower) ||
    /\bmake\b.*\b(shorter|clearer|crisper|concise)\b/.test(lower) ||
    /\bshorten\w*\b/.test(lower)
  )
}

export function isTranslationRequest(message: string) {
  const lower = message.toLowerCase()
  return /\btranslate|translation|localiz|in\s+[a-z]+\b/.test(lower)
}

export function shouldKeepRichTextTitleOnTranslate(args: {
  target: PageDoc["blocks"][number]
  activeEditablePath?: string
  message: string
  fullPatch: Record<string, unknown>
}) {
  const { target, activeEditablePath, message, fullPatch } = args
  if (target.type !== "RichText") return false
  if (activeEditablePath !== "body") return false
  if (!isTranslationRequest(message)) return false
  return Object.prototype.hasOwnProperty.call(fullPatch, "title")
}

export function inferFieldHintFromMessage(message: string, allowedKeys: string[]) {
  const lower = message.toLowerCase()
  const keyMap: Array<{ test: RegExp; key: string }> = [
    { test: /\btitle\b|\bheading\b/, key: "title" },
    { test: /\bdescription\b|\bbody\b|\bcopy\b/, key: "description" },
    { test: /\bcta\s*text\b|\bbutton\s*text\b/, key: "ctaText" },
    { test: /\bcta\s*link\b|\bhref\b|\blink\b|\burl\b/, key: "ctaHref" },
    { test: /\bquote\b/, key: "quote" },
    { test: /\bauthor\b/, key: "author" },
    { test: /\bquestion\b|\bfaq\s*q\b/, key: "q" },
    { test: /\banswer\b|\bfaq\s*a\b/, key: "a" }
  ]

  for (const entry of keyMap) {
    if (entry.test.test(lower) && allowedKeys.includes(entry.key)) return entry.key
  }
  return allowedKeys[0]
}

export function rewriteFromExisting(existing: string, message: string) {
  let next = existing
    .replace(/\bamazing\b/gi, "great")
    .replace(/\bincredible\b/gi, "powerful")
    .replace(/\breally\b/gi, "")
    .replace(/\bvery\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim()

  if (/short|shorter|concise|brief/i.test(message)) {
    const sentence = next.split(/[.!?]/)[0]?.trim()
    if (sentence) next = sentence.endsWith(".") ? sentence : `${sentence}.`
  }

  if (next === existing) {
    next = existing.endsWith(".") ? `${existing.slice(0, -1)} today.` : `${existing} today.`
  }
  return next
}

export function coercePatchForEditablePath(block: PageDoc["blocks"][number], editablePath: string | undefined, rawPatch: unknown, message: string) {
  if (!editablePath) return null
  const directKey = editablePath.trim()
  const blockProps = block.props as Record<string, unknown>
  if (directKey && Object.prototype.hasOwnProperty.call(blockProps, directKey)) {
    const source = patchObject(rawPatch) ?? inferSimpleFieldPatchFromMessage(message)
    let value: unknown

    if (source) {
      if (Object.prototype.hasOwnProperty.call(source, directKey)) value = source[directKey]
      else {
        const mapped = Object.keys(source).find((key) => key.toLowerCase() === directKey.toLowerCase())
        if (mapped) value = source[mapped]
      }
    }

    if (value === undefined) {
      const quoted = quotedText(message)
      if (quoted) value = quoted
    }
    if (value === undefined && isRewriteRequest(message)) {
      const existing = blockProps[directKey]
      if (typeof existing === "string" && existing.trim().length > 0) value = rewriteFromExisting(existing, message)
    }
    if (value === undefined) return null

    return {
      patch: { [directKey]: value } as Record<string, unknown>,
      changedKeys: [directKey],
      rootKey: directKey
    }
  }

  const parsed = parseIndexedPath(editablePath)
  if (!parsed) return null

  const list = (block.props as Record<string, unknown>)[parsed.listKey]
  if (!Array.isArray(list) || parsed.index < 0 || parsed.index >= list.length) return null
  const rowRaw = list[parsed.index]
  if (!rowRaw || typeof rowRaw !== "object" || Array.isArray(rowRaw)) return null
  const row = rowRaw as Record<string, unknown>

  const source = patchObject(rawPatch) ?? inferSimpleFieldPatchFromMessage(message)

  const allowedItemKeys = Object.keys(row)
  const normalizedToAllowed = new Map<string, string>()
  for (const key of allowedItemKeys) normalizedToAllowed.set(key.toLowerCase(), key)

  const itemPatch: Record<string, unknown> = {}
  if (source) {
    for (const [key, value] of Object.entries(source)) {
      const normalized = key.trim()
      const fromPathPrefix = `${parsed.listKey}[${parsed.index}].`
      const childKey = normalized.startsWith(fromPathPrefix) ? normalized.slice(fromPathPrefix.length) : normalized
      const mapped = normalizedToAllowed.get(childKey.toLowerCase())
      if (mapped) itemPatch[mapped] = value
    }
  }

  if (Object.keys(itemPatch).length === 0 && isRewriteRequest(message)) {
    const preferredKey =
      (parsed.leaf && normalizedToAllowed.get(parsed.leaf.toLowerCase())) ?? inferFieldHintFromMessage(message, allowedItemKeys)
    if (preferredKey) {
      const existing = row[preferredKey]
      if (typeof existing === "string" && existing.trim().length > 0) {
        itemPatch[preferredKey] = rewriteFromExisting(existing, message)
      }
    }
  }
  if (Object.keys(itemPatch).length === 0) return null

  const nextList = list.map((entry, idx) => {
    if (idx !== parsed.index || !entry || typeof entry !== "object" || Array.isArray(entry)) return entry
    return { ...(entry as Record<string, unknown>), ...itemPatch }
  })
  return {
    patch: { [parsed.listKey]: nextList } as Record<string, unknown>,
    changedKeys: Object.keys(itemPatch),
    rootKey: parsed.listKey
  }
}

export function quotedText(message: string) {
  return /"([^"]+)"/.exec(message)?.[1]?.trim()
}

export function buildListAppendPatch(block: PageDoc["blocks"][number], message: string) {
  const lower = message.toLowerCase()
  const quoted = quotedText(message)

  if (block.type === "FAQAccordion") {
    const existing = Array.isArray(block.props.items) ? (block.props.items as Array<Record<string, unknown>>) : []
    const q = quoted ?? (lower.includes("question") ? "New question" : "How does this work?")
    const next = [...existing, { q, a: "Add answer here." }]
    return { items: next }
  }

  if (block.type === "Testimonials") {
    const existing = Array.isArray(block.props.items) ? (block.props.items as Array<Record<string, unknown>>) : []
    const quote = quoted ?? "Great experience."
    const next = [...existing, { quote, author: "Customer" }]
    return { items: next }
  }

  if (block.type === "FeatureGrid") {
    const existing = Array.isArray(block.props.features) ? (block.props.features as Array<Record<string, unknown>>) : []
    const title = quoted ?? "New feature"
    const next = [...existing, { title, description: "Describe this feature." }]
    return { features: next }
  }

  if (block.type === "CardGrid") {
    const existing = Array.isArray(block.props.cards) ? (block.props.cards as Array<Record<string, unknown>>) : []
    const title = quoted ?? "New card"
    const next = [...existing, { title, description: "Add card description.", ctaText: "Learn more", ctaHref: "/" }]
    return { cards: next }
  }

  return null
}

export function compileDeterministicPlan(args: {
  session: string
  intent: ParsedIntent
  message: string
  slug: string
  currentPage: PageDoc
  activeBlockId?: string
  activeEditablePath?: string
}): EditPlan | null {
  const { session, intent, message, slug, currentPage, activeBlockId, activeEditablePath } = args
  const cleanMessage = stripSiteContextEnvelope(message)
  const lowerMessage = message.toLowerCase()
  const routeMentions = extractRouteMentions(cleanMessage)
  const assumptions: string[] = []
  if (intent.assumption) assumptions.push(intent.assumption)

  if (process.env.OPENAI_API_KEY && isRewriteRequest(message) && !quotedText(message)) return null

  const hasConditionalQualifier = /\bif\s+(required|needed|necessary)\b/.test(lowerMessage)
  const asksSectionReorder =
    /\b(reorder|re-order|rearrange|re-organize|reorganize)\b/.test(lowerMessage) &&
    /\b(section|sections|block|blocks|content|layout|flow|readability)\b/.test(lowerMessage)
  const hasExplicitPlacementCue = /\b(top|bottom|first|last|before|after|above|below|under|between)\b/.test(lowerMessage)
  const hasExplicitBlockMentionInMessage =
    /\bb_[a-z0-9_]+\b/.test(lowerMessage) ||
    /\b(hero|feature grid|features|testimonials?|faq|cta|card grid|cards?|rich[\s-]?text)\b/.test(lowerMessage)

  const selectedBlock = activeBlockId ? currentPage.blocks.find((b) => b.id === activeBlockId) ?? null : null
  const secondaryButtonMentioned =
    lowerMessage.includes("secondary cta") ||
    lowerMessage.includes("secondary button") ||
    lowerMessage.includes("second cta") ||
    lowerMessage.includes("second button") ||
    /sec\w*nd\w*ry\s+(cta|button)/.test(lowerMessage)
  const asksSecondaryCtaAdd =
    secondaryButtonMentioned &&
    (lowerMessage.includes("add") || lowerMessage.includes("create") || lowerMessage.includes("insert") || lowerMessage.includes("include"))

  const asksPageRename = isPageRouteRenameRequest(message)
  if ((intent.action === "update" || intent.action === "move" || intent.action === "clarify") && asksPageRename) {
    const mentionsCurrentPage = /\b(this|current|the)\s+page\b/.test(lowerMessage)
    let fromSlug = routeMentions[0] ?? slug
    let toSlug = routeMentions.length >= 2 ? routeMentions[routeMentions.length - 1] : undefined
    if (!toSlug && routeMentions.length === 1 && mentionsCurrentPage) {
      toSlug = routeMentions[0]
      fromSlug = slug
    }
    if (!toSlug || toSlug === fromSlug) {
      return {
        intent: "needs_clarification",
        summary_for_user: "Please provide the target page path, for example: rename page from /old to /new.",
        change_log: assumptions,
        ops: []
      }
    }
    return {
      intent: "edit_plan",
      summary_for_user: `Renamed page path from ${fromSlug} to ${toSlug}.`,
      change_log: [...assumptions, `Renamed page ${fromSlug} -> ${toSlug}.`],
      ops: [{ op: "rename_page", pageSlug: fromSlug, newPageSlug: toSlug }]
    }
  }

  const asksPageDelete = /\b(delete|remove)\b.*\bpage\b/.test(lowerMessage)
  if ((intent.action === "remove" || intent.action === "clarify") && asksPageDelete) {
    const targetSlug = routeMentions[0] ?? slug
    if (targetSlug === "/") {
      return {
        intent: "needs_clarification",
        summary_for_user: "Home page (/) cannot be deleted. Choose another page path.",
        change_log: assumptions,
        ops: []
      }
    }
    return {
      intent: "edit_plan",
      summary_for_user: `Deleted page ${targetSlug}.`,
      change_log: [...assumptions, `Removed page ${targetSlug}.`],
      ops: [{ op: "remove_page", pageSlug: targetSlug }]
    }
  }

  const requestedCreateSlug = parseCreatePageRequest(message)
  if ((intent.action === "add" || intent.action === "clarify" || intent.action === "update") && requestedCreateSlug) {
    const createPlan = buildCreatePagePlan({ session, requestedSlug: requestedCreateSlug, assumptions, userMessage: message })
    if (createPlan) return createPlan
  }

  const hasNavContext = /\b(nav|navigation|menu|first|last|position)\b/.test(lowerMessage) || routeMentions.length >= 2
  const asksNavMove =
    /\b(nav|navigation|menu|tabs?|tab order|page order)\b/.test(lowerMessage) ||
    /\bmove\b.*\btab\b/.test(lowerMessage) ||
    (/\bmove\b.*\bpage\b/.test(lowerMessage) && hasNavContext) ||
    /\breorder\b.*\b(page|nav|menu|tabs?)\b/.test(lowerMessage)
  if ((intent.action === "move" || intent.action === "clarify") && asksNavMove) {
    const sessionDraft = getSessionDraft(session)
    const slugsRaw = Array.from(sessionDraft.keys())
    const ordered = slugsRaw.includes("/") ? ["/", ...slugsRaw.filter((route) => route !== "/")] : slugsRaw
    const movedSlug = routeMentions[0] ?? slug
    if (!ordered.includes(movedSlug)) {
      return {
        intent: "needs_clarification",
        summary_for_user: `I could not find page ${movedSlug}.`,
        change_log: assumptions,
        ops: []
      }
    }
    if (movedSlug === "/") {
      return {
        intent: "needs_clarification",
        summary_for_user: "Home page (/) is fixed at the first position in navigation.",
        change_log: assumptions,
        ops: []
      }
    }

    let afterPageSlug: string | undefined
    if (/\b(top|first|start|beginning)\b/.test(lowerMessage)) {
      afterPageSlug = undefined
    } else if (/\b(bottom|last|end)\b/.test(lowerMessage)) {
      const tail = [...ordered].reverse().find((route) => route !== movedSlug)
      afterPageSlug = tail === "/" ? "/" : tail
    } else if (/\b(after|below|under)\b/.test(lowerMessage) && routeMentions.length >= 2) {
      afterPageSlug = routeMentions[1]
    } else if (/\b(before|above)\b/.test(lowerMessage) && routeMentions.length >= 2) {
      const anchor = routeMentions[1]
      if (anchor === "/") afterPageSlug = undefined
      else {
        const index = ordered.findIndex((route) => route === anchor)
        if (index === -1) {
          return {
            intent: "needs_clarification",
            summary_for_user: `I could not find anchor page ${anchor}.`,
            change_log: assumptions,
            ops: []
          }
        }
        const previous = ordered.slice(0, index).reverse().find((route) => route !== movedSlug)
        afterPageSlug = previous === "/" ? "/" : previous
      }
    } else if (routeMentions.length >= 2) {
      afterPageSlug = routeMentions[1]
    } else {
      return {
        intent: "needs_clarification",
        summary_for_user: "Specify where to place the page (first/last/before/after).",
        change_log: assumptions,
        ops: []
      }
    }

    return {
      intent: "edit_plan",
      summary_for_user:
        afterPageSlug === undefined
          ? `Moved ${movedSlug} to the first nav position (after Home).`
          : `Moved ${movedSlug} after ${afterPageSlug}.`,
      change_log: [...assumptions, `Reordered nav: ${movedSlug}`],
      ops: [{ op: "move_page", pageSlug: movedSlug, afterPageSlug }]
    }
  }

  const audiences = extractAudienceTargets(message)
  const audience = audiences[0]
  const asksAudienceCreatePage =
    audiences.length > 0 &&
    /\b(create|generate|build|make|draft)\b/.test(lowerMessage) &&
    /\b(pages?|landing pages?)\b/.test(lowerMessage)
  if (asksAudienceCreatePage && audience) {
    if (process.env.OPENAI_API_KEY) return null
    const now = new Date().toISOString()
    const reservedSlugs = new Set(getSessionDraft(session).keys())
    const allocateSlug = (requested: string) => {
      let candidate = requested
      if (!reservedSlugs.has(candidate)) {
        reservedSlugs.add(candidate)
        return candidate
      }
      let idx = 2
      while (reservedSlugs.has(`${requested}-${idx}`)) idx += 1
      candidate = `${requested}-${idx}`
      reservedSlugs.add(candidate)
      return candidate
    }
    const pages = audiences.map((aud, index) => {
      const seed = toSeedSlug(aud) || `audience-${index + 1}`
      const requestedSlug = routeMentions[index] ?? `/for-${seed}`
      const normalizedRequested = normalizeRouteCandidate(requestedSlug) ?? `/for-${seed}`
      const newSlug = allocateSlug(normalizedRequested)
      const label = titleCaseWords(aud)
      const page: PageDoc = {
        id: `p_for_${seed}`,
        slug: newSlug,
        title: `For ${label}`,
        updatedAt: now,
        blocks: [
          {
            id: `b_hero_${seed}`,
            type: "Hero",
            props: {
              heading: `Built for ${label}`,
              subheading: `Everything on this page is tailored for ${aud}.`,
              ctaText: "Get Started",
              ctaHref: "/",
              imageUrl: `https://picsum.photos/seed/${encodeURIComponent(seed)}/1600/900`,
              imageAlt: `Audience-focused hero image for ${label}`
            }
          },
          {
            id: `b_features_${seed}`,
            type: "FeatureGrid",
            props: {
              title: `Why ${label} choose this`,
              features: [
                { title: "Relevant messaging", description: `Copy aligned to ${aud} needs and language.` },
                { title: "Clear outcomes", description: "Benefits are framed around practical results." },
                { title: "Focused next step", description: "CTA is tuned for this audience journey." }
              ]
            }
          },
          {
            id: `b_faq_${seed}`,
            type: "FAQAccordion",
            props: {
              title: `FAQ for ${label}`,
              items: [
                { q: `Is this suitable for ${aud}?`, a: `Yes, this page is tailored for ${aud}.` },
                { q: "How quickly can I start?", a: "Most visitors can get started in minutes." },
                { q: "Can I customize later?", a: "Yes, content and sections can be updated anytime." }
              ]
            }
          },
          {
            id: `b_cta_${seed}`,
            type: "CTA",
            props: {
              title: `Start with a plan for ${label}`,
              description: "Take the next step with content designed for your audience.",
              ctaText: "Start now",
              ctaHref: "/"
            }
          }
        ]
      }
      return { page, audience: aud }
    })
    const createdAudienceLabels = pages.map((entry) => entry.audience)
    const summaryAudienceList = createdAudienceLabels.join(", ")
    return {
      intent: "edit_plan",
      summary_for_user:
        pages.length === 1
          ? `Created a new page tailored for ${audience}.`
          : `Created ${pages.length} new pages tailored for ${summaryAudienceList}.`,
      change_log: [
        ...assumptions,
        ...pages.map((entry) => `Created page ${entry.page.slug} for audience: ${entry.audience}.`)
      ],
      ops: pages.map((entry) => ({ op: "create_page", page: entry.page } satisfies Operation))
    }
  }

  const asksAudienceRetarget =
    Boolean(audience) &&
    !asksAudienceCreatePage &&
    (/\bfor\b/.test(lowerMessage) || /\baudience\b/.test(lowerMessage) || /\btarget\b/.test(lowerMessage))
  if (asksAudienceRetarget && audience) {
    if (process.env.OPENAI_API_KEY) return null
    const targets = selectedBlock
      ? [selectedBlock]
      : currentPage.blocks.filter((block) => block.type === "Hero" || block.type === "CTA" || block.type === "RichText").slice(0, 3)
    const ops: Operation[] = []
    for (const block of targets) {
      const patch = audiencePatchForBlock(block, audience)
      if (Object.keys(patch).length === 0) continue
      ops.push({ op: "update_props", pageSlug: slug, blockId: block.id, patch })
    }
    if (ops.length > 0) {
      return {
        intent: "edit_plan",
        summary_for_user: `Tailored this page for ${audience}.`,
        change_log: [...assumptions, `Retargeted copy for audience: ${audience}.`],
        ops
      }
    }
  }

  if (intent.action === "move" && hasConditionalQualifier && asksSectionReorder && !hasExplicitPlacementCue && !hasExplicitBlockMentionInMessage) {
    return {
      intent: "needs_clarification",
      summary_for_user: "I can reorder sections if needed, but please specify what should move (for example: move FAQ below Testimonials).",
      change_log: [...assumptions, "Skipped ambiguous conditional reorder request without explicit section or placement."],
      ops: []
    }
  }

  if (
    selectedBlock?.type === "Hero" &&
    asksSecondaryCtaAdd &&
    (intent.action === "add" || intent.action === "clarify" || intent.action === "update")
  ) {
    const heroProps = selectedBlock.props as Record<string, unknown>
    const existingText = typeof heroProps.secondaryCtaText === "string" ? heroProps.secondaryCtaText.trim() : ""
    const existingHref = typeof heroProps.secondaryCtaHref === "string" ? heroProps.secondaryCtaHref.trim() : ""
    const quoted = quotedText(message)
    const patch: Record<string, unknown> = {
      secondaryCtaText: quoted ?? (existingText.length > 0 ? existingText : "Learn more"),
      secondaryCtaHref: existingHref.length > 0 ? existingHref : "/"
    }

    return {
      intent: "edit_plan",
      summary_for_user: "Added a secondary CTA button to the selected Hero.",
      change_log: [...assumptions, `Updated ${selectedBlock.id}: secondaryCtaText, secondaryCtaHref`],
      ops: [{ op: "update_props", pageSlug: slug, blockId: selectedBlock.id, patch }]
    }
  }

  const asksInlineAdd =
    lowerMessage.includes("add") &&
    (lowerMessage.includes("inside") ||
      lowerMessage.includes("within") ||
      lowerMessage.includes("current") ||
      lowerMessage.includes("this one") ||
      lowerMessage.includes("more") ||
      lowerMessage.includes("another"))

  if ((intent.action === "add" || intent.action === "clarify") && asksInlineAdd) {
    let inlineTarget = selectedBlock
    if (!inlineTarget) {
      const typeMap: Array<{ test: RegExp; type: BlockType }> = [
        { test: /\btestimonial/, type: "Testimonials" },
        { test: /\b(faq|question)/, type: "FAQAccordion" },
        { test: /\bfeature/, type: "FeatureGrid" },
        { test: /\bcard/, type: "CardGrid" }
      ]
      for (const entry of typeMap) {
        if (entry.test.test(lowerMessage)) {
          const matches = currentPage.blocks.filter((b) => b.type === entry.type)
          if (matches.length === 1) inlineTarget = matches[0]
          break
        }
      }
    }
    if (inlineTarget) {
      const patch = buildListAppendPatch(inlineTarget, message)
      if (patch) {
        return {
          intent: "edit_plan",
          summary_for_user: `Updated ${inlineTarget.type}.`,
          change_log: [...assumptions, `Added one entry to ${inlineTarget.id}.`],
          ops: [{ op: "update_props", pageSlug: slug, blockId: inlineTarget.id, patch }]
        }
      }
    }
  }

  if (intent.action === "info" || (intent.action === "clarify" && !activeEditablePath)) {
    return {
      intent: "needs_clarification",
      summary_for_user: intent.summary ?? "Please specify the section and exact change you want.",
      change_log: assumptions,
      ops: []
    }
  }

  if (intent.action === "remove") {
    let target = resolveBlockRef({
      ref: intent.target_block_ref,
      currentPage,
      activeBlockId,
      fallbackType: intent.target_block_type
    })
    if (!target && !activeBlockId) {
      const inferredType = inferBlockTypeFromText(cleanMessage)
      if (inferredType) {
        const matches = currentPage.blocks.filter((b) => b.type === inferredType)
        if (matches.length === 1) target = matches[0]
      }
    }
    if (!target) {
      return {
        intent: "needs_clarification",
        summary_for_user: "I need to know which block to remove.",
        change_log: assumptions,
        ops: []
      }
    }
    return {
      intent: "edit_plan",
      summary_for_user: intent.summary ?? `Removed ${target.type}.`,
      change_log: [...assumptions, `Removed block ${target.id}.`],
      ops: [{ op: "remove_block", pageSlug: slug, blockId: target.id }]
    }
  }

  if (intent.action === "update" || (intent.action === "clarify" && !!activeEditablePath)) {
    const target = resolveBlockRef({
      ref: intent.target_block_ref,
      currentPage,
      activeBlockId,
      fallbackType: intent.target_block_type
    })
    if (!target) {
      return {
        intent: "needs_clarification",
        summary_for_user: "I need to know which block to update.",
        change_log: assumptions,
        ops: []
      }
    }
    const childPatch = coercePatchForEditablePath(target, activeEditablePath, intent.patch, message)
    const fullPatch = coercePatchForBlock(target, intent.patch)
    const mergedRichTextTranslationPatch = shouldKeepRichTextTitleOnTranslate({
      target,
      activeEditablePath,
      message,
      fullPatch
    })
      ? { ...fullPatch, ...(childPatch?.patch ?? {}) }
      : null
    const patch = mergedRichTextTranslationPatch ?? childPatch?.patch ?? fullPatch
    if (Object.keys(patch).length === 0) {
      const editableFields = userFacingPropNames(target.type, Object.keys(target.props))
      return {
        intent: "needs_clarification",
        summary_for_user: `Please specify at least one valid field for ${target.type}.`,
        change_log: [...assumptions, `Editable fields: ${editableFields.join(", ")}`],
        ops: []
      }
    }
    const changedKeys = userFacingPropNames(target.type, Object.keys(patch))
    return {
      intent: "edit_plan",
      summary_for_user: intent.summary ?? `Updated ${target.type}.`,
      change_log: [
        ...assumptions,
        childPatch
          ? `Updated ${target.id} ${activeEditablePath}: ${changedKeys.join(", ")}`
          : `Updated ${target.id}: ${changedKeys.join(", ")}`
      ],
      ops: [{ op: "update_props", pageSlug: slug, blockId: target.id, patch }]
    }
  }

  if (intent.action === "move") {
    const target = resolveBlockRef({
      ref: intent.target_block_ref,
      currentPage,
      activeBlockId,
      fallbackType: intent.target_block_type
    })
    if (!target) {
      return {
        intent: "needs_clarification",
        summary_for_user: "I need to know which block to move.",
        change_log: assumptions,
        ops: []
      }
    }

    let afterBlockId: string | undefined
    if (intent.position === "top") {
      afterBlockId = undefined
    } else if (intent.position === "bottom") {
      const tail = [...currentPage.blocks].reverse().find((b) => b.id !== target.id)
      afterBlockId = tail?.id
    } else if (intent.position === "after" || (intent.anchor_block_ref && !intent.position)) {
      const anchor = resolveBlockRef({ ref: intent.anchor_block_ref, currentPage })
      if (!anchor) {
        return {
          intent: "needs_clarification",
          summary_for_user: "I could not find the anchor block to move after.",
          change_log: assumptions,
          ops: []
        }
      }
      afterBlockId = anchor.id
    } else if (intent.position === "before") {
      const anchor = resolveBlockRef({ ref: intent.anchor_block_ref, currentPage })
      if (!anchor) {
        return {
          intent: "needs_clarification",
          summary_for_user: "I could not find the anchor block to move before.",
          change_log: assumptions,
          ops: []
        }
      }
      const idx = currentPage.blocks.findIndex((b) => b.id === anchor.id)
      if (idx > 0) afterBlockId = currentPage.blocks[idx - 1]?.id
      else afterBlockId = undefined
    } else if (message.toLowerCase().includes("bottom") || message.toLowerCase().includes("end")) {
      const tail = [...currentPage.blocks].reverse().find((b) => b.id !== target.id)
      afterBlockId = tail?.id
    } else {
      return {
        intent: "needs_clarification",
        summary_for_user: "Please specify where to move the block (top, bottom, before, after).",
        change_log: assumptions,
        ops: []
      }
    }

    return {
      intent: "edit_plan",
      summary_for_user: intent.summary ?? `Moved ${target.type}.`,
      change_log: [...assumptions, `Moved block ${target.id}.`],
      ops: [{ op: "move_block", pageSlug: slug, blockId: target.id, afterBlockId }]
    }
  }

  if (intent.action === "add") {
    // --- Batch add: "add 3 blocks: hero, cardgrid and CTA" ----------------
    if (isBatchAddRequest(message)) {
      const blockTypes = extractMentionedBlockTypes(message)
      if (blockTypes.length >= 2) {
        const ops: Operation[] = []
        const changeLog = [...assumptions]
        // Track blocks as we add them so nextBlockId generates unique IDs
        let pageSnapshot = currentPage
        for (const bt of blockTypes) {
          const blockId = nextBlockId(bt, pageSnapshot)
          const props = defaultPropsForType(bt)
          ops.push({ op: "add_block", pageSlug: slug, block: { id: blockId, type: bt, props } })
          changeLog.push(`Added ${bt} block ${blockId}.`)
          // Update snapshot so the next nextBlockId sees existing IDs
          pageSnapshot = { ...pageSnapshot, blocks: [...pageSnapshot.blocks, { id: blockId, type: bt, props }] }
        }
        return {
          intent: "edit_plan",
          summary_for_user: `Added ${blockTypes.join(", ")}.`,
          change_log: changeLog,
          ops
        }
      }
    }

    // --- Single add -------------------------------------------------------
    const blockType =
      intent.new_block_type ??
      inferAddedBlockTypeFromMessage(message) ??
      intent.target_block_type ??
      inferBlockTypeFromText(intent.target_block_ref ?? "") ??
      inferBlockTypeFromText(message)
    if (!blockType) {
      // No block type found — check if this is an image replacement request
      // e.g. "add unsplash image", "add a new photo", "add image"
      const isImageRequest = /\b(image|photo|picture)\b/.test(lowerMessage)
      if (isImageRequest) {
        const hero = selectedBlock?.type === "Hero"
          ? selectedBlock
          : currentPage.blocks.find((b) => b.type === "Hero") ?? null
        if (hero) {
          return {
            intent: "edit_plan",
            summary_for_user: "Updated the hero image.",
            change_log: [...assumptions, `Updated ${hero.id}: imageUrl`],
            ops: [{ op: "update_props", pageSlug: slug, blockId: hero.id, patch: { imageUrl: "pending" } }]
          }
        }
      }
      return {
        intent: "needs_clarification",
        summary_for_user: `Please specify which block type to add (${allowedBlockTypes.join(", ")}).`,
        change_log: assumptions,
        ops: []
      }
    }

    const blockId = nextBlockId(blockType, currentPage)
    const baseProps = defaultPropsForType(blockType)
    const patch = coercePatchForBlock({ id: blockId, type: blockType, props: baseProps }, intent.patch)
    const props = { ...baseProps, ...patch }

    const addOp: Operation = {
      op: "add_block",
      pageSlug: slug,
      block: { id: blockId, type: blockType, props }
    }

    let extraMoveTop: Operation | null = null
    if (intent.position === "after" || (intent.anchor_block_ref && !intent.position)) {
      const anchor = resolveBlockRef({ ref: intent.anchor_block_ref, currentPage })
      if (!anchor) {
        return {
          intent: "needs_clarification",
          summary_for_user: "I could not find the anchor block to place this after.",
          change_log: assumptions,
          ops: []
        }
      }
      addOp.afterBlockId = anchor.id
    } else if (intent.position === "before") {
      const anchor = resolveBlockRef({ ref: intent.anchor_block_ref, currentPage })
      if (!anchor) {
        return {
          intent: "needs_clarification",
          summary_for_user: "I could not find the anchor block to place this before.",
          change_log: assumptions,
          ops: []
        }
      }
      const idx = currentPage.blocks.findIndex((b) => b.id === anchor.id)
      if (idx > 0) addOp.afterBlockId = currentPage.blocks[idx - 1]?.id
      else extraMoveTop = { op: "move_block", pageSlug: slug, blockId, afterBlockId: undefined }
    } else if (intent.position === "top") {
      extraMoveTop = { op: "move_block", pageSlug: slug, blockId, afterBlockId: undefined }
    } else if (intent.position === "bottom" || !intent.position) {
      // no-op: add without anchor appends to bottom in applyOpsAtomically
    }

    const ops: Operation[] = extraMoveTop ? [addOp, extraMoveTop] : [addOp]
    return {
      intent: "edit_plan",
      summary_for_user: intent.summary ?? `Added ${blockType}.`,
      change_log: [...assumptions, `Added ${blockType} block ${blockId}.`],
      ops
    }
  }

  return null
}
