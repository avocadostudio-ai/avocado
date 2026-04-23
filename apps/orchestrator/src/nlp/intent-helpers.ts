export function toSeedSlug(raw: string) {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

export function normalizeRouteCandidate(candidate: unknown): string | null {
  if (typeof candidate !== "string") return null
  const trimmed = candidate.trim()
  if (!trimmed) return null
  if (trimmed === "/") return "/"
  if (trimmed.startsWith("/")) return trimmed
  if (/^[a-z0-9][a-z0-9/_-]*$/i.test(trimmed)) return `/${trimmed}`
  return null
}

export function firstRouteMention(message?: string) {
  if (!message) return null
  const match = message.match(/\/[a-z0-9/_-]*/i)
  if (!match) return null
  return normalizeRouteCandidate(match[0])
}

export function extractRouteMentions(message?: string) {
  if (!message) return []
  const matches = message.match(/\/[a-z0-9/_-]*/gi) ?? []
  const out: string[] = []
  for (const item of matches) {
    const normalized = normalizeRouteCandidate(item)
    if (!normalized) continue
    if (out.includes(normalized)) continue
    out.push(normalized)
  }
  return out
}

export function isLikelyClarificationFollowUp(message: string) {
  const normalized = message.toLowerCase().trim().replace(/\s+/g, " ")
  if (!normalized) return false
  const words = normalized.split(" ").filter(Boolean)
  // Detect common clarification openers regardless of length
  const hasClarificationOpener =
    /^(i mean\b|i meant\b|no[,.]|sorry[,.]|what i mean|not that[,.]|i was (?:talking|asking) about\b)/.test(normalized)
  if (hasClarificationOpener) return true
  // Detect confirmation / go-ahead responses to a previous clarification offer
  const hasConfirmationOpener =
    /^(yes\b|yeah\b|yep\b|sure\b|ok\b|okay\b|go ahead\b|do it\b|let'?s (?:see|go|do)\b|show me\b|sounds good\b|please\b)/.test(normalized)
  if (hasConfirmationOpener) return true
  if (isStandalonePageOperation(normalized)) return false
  const hasReferenceCue =
    /\b(selected|this|that|it|them|those|these|one|ones|same)\b/.test(normalized) ||
    /\bfirst|second|third|last\b/.test(normalized) ||
    /\b(?:all|the|both)\s+\d+\b/.test(normalized)
  const hasActionVerb = /\b(add|update|change|edit|remove|delete|move|rename|create|duplicate|set|rewrite|replace|translate|redesign|refocus|overhaul|rebuild)\b/.test(normalized)
  if (hasActionVerb && /\b(this|current|selected|the)\s+page\b/.test(normalized)) return false
  return (words.length <= 8 && hasReferenceCue) || (!hasActionVerb && words.length <= 5)
}

export function isStandalonePageOperation(message: string) {
  const normalized = message.toLowerCase().trim().replace(/\s+/g, " ")
  if (/\b(create|generate|add|make|build|populate|fill|remove|delete|rename|move|translate|redesign|refocus|overhaul|rebuild)\b.*\bpage\b/.test(normalized)) return true
  // "rename to Olive oil" — implicit page rename even without "page" keyword
  if (/\brename\b.*\bto\s+[a-z]/i.test(normalized) && !/\bto\s+(first|last|top|bottom|start|end|beginning)\b/i.test(normalized)) return true
  return false
}

export function parseCreatePageRequest(message: string) {
  // Strip [site context]...[/site context] metadata to prevent false route matches
  const stripped = message.replace(/\n?\[site context\][\s\S]*?\[\/site context\]\s*$/i, "").trim()
  const lower = stripped.toLowerCase().replace(/\s+/g, " ").trim()
  // Don't treat "remove/delete new page" as a create request
  if (/\b(remove|delete|drop|destroy)\b/.test(lower)) return null
  const mentionsCurrentPage = /\b(this|current|selected)\s+page\b/.test(lower)
  const hasExplicitRoute = Boolean(firstRouteMention(stripped) ?? extractRouteMentions(stripped)[0])
  const asksNewPage = /\bnew\s+page\b/.test(lower)
  const isCurrentPagePlacementPhrase =
    /\b(?:on|at|in|within|inside)\s+(?:this|the|current|selected)\s+page\b/.test(lower) ||
    /\b(?:end|top|bottom|start|beginning)\s+of\s+(?:this|the|current|selected)\s+page\b/.test(lower)
  if (mentionsCurrentPage && !asksNewPage && !hasExplicitRoute) return null
  if (isCurrentPagePlacementPhrase && !asksNewPage && !hasExplicitRoute) return null

  const hasPageWord = /\bpages?\b/.test(lower)
  if (!hasPageWord) return null
  const explicitCreatePhrase =
    /\b(create|generate|make|build|draft)\b[^.\n]{0,24}\b(new\s+)?pages?\b/.test(lower) ||
    /\badd\s+(a\s+)?(new\s+)?[^.\n]{0,24}\bpages?\b/.test(lower) ||
    /\bnew\s+pages?\b/.test(lower)
  const hasCreateVerb = /\b(create|generate|add|make|build|draft)\b/.test(lower)
  const hasRouteHint = /\/[a-z0-9/_-]*/i.test(stripped)
  if (!explicitCreatePhrase && !(hasCreateVerb && hasRouteHint && hasPageWord)) return null
  if (mentionsCurrentPage && !asksNewPage && !hasExplicitRoute) return null

  const directRoute = firstRouteMention(stripped) ?? extractRouteMentions(stripped)[0]
  if (directRoute) {
    const normalized = normalizeRouteCandidate(directRoute)
    if (normalized && normalized !== "/") return normalized
  }

  // Quoted page name: 'create a new page "Test"' → /test, "page called 'About Us'" → /about-us
  const quotedName = stripped.match(/["'\u201C\u201D\u2018\u2019]([^"'\u201C\u201D\u2018\u2019]{1,60})["'\u201C\u201D\u2018\u2019]/)
  if (quotedName) {
    const seed = toSeedSlug(quotedName[1].trim())
    if (seed) return `/${seed}`
  }

  const forAudience = lower.match(/\bpage\s+for\s+([a-z0-9 -]{2,60})$/)?.[1]
  if (forAudience) {
    const seed = toSeedSlug(forAudience)
    if (seed) return `/for-${seed}`
  }

  const aboutTopic = lower.match(/\b(?:new\s+)?page\s+(?:about|on|for)\s+([a-z0-9 -]{2,60})\b/)?.[1]
  if (aboutTopic) {
    // Trim at structural words that introduce block layout ("with a Hero section...")
    const trimmed = aboutTopic.replace(/\s+(?:with|including|containing|featuring|that\s+has|having)\s+.*$/, "").trim()
    const seed = toSeedSlug(trimmed || aboutTopic)
    if (seed) return `/${seed}`
  }

  // "create/add/make [a] [new] <PageName> page" — extract name before "page"
  const namedPage = lower.match(/\b(?:create|add|make|build|generate)\b\s+(?:a\s+)?(?:new\s+)?([a-z][a-z0-9 ]{1,40}?)\s+pages?\b/)
  if (namedPage) {
    const seed = toSeedSlug(namedPage[1].trim())
    if (seed && seed !== "new") return `/${seed}`
  }

  // "page called/named/titled <PageName>"
  const calledPage = lower.match(/\bpages?\s+(?:called|named|titled)\s+['"]?([a-z][a-z0-9 ]{1,40})['"]?$/)
  if (calledPage) {
    const seed = toSeedSlug(calledPage[1].trim())
    if (seed) return `/${seed}`
  }

  return "/new-page"
}

export function parseDuplicatePageRequest(message: string, args?: { currentSlug?: string }) {
  const stripped = message.replace(/\n?\[site context\][\s\S]*?\[\/site context\]\s*$/i, "").trim()
  const lower = stripped.toLowerCase().replace(/\s+/g, " ").trim()
  if (!/\b(duplicate|copy|clone)\b/.test(lower)) return null
  if (!/\bpage\b/.test(lower) && !/\b(this|current|selected)\b/.test(lower) && !/\/[a-z0-9/_-]+/i.test(stripped)) return null

  const routeMentions = extractRouteMentions(stripped)
  const byCommandRoute = stripped.match(/\b(?:duplicate|copy|clone)\s+(?:the\s+)?(?:page\s+)?(\/[a-z0-9/_-]+)/i)?.[1]
  const byToRoute = stripped.match(/\b(?:to|into|as)\s+(\/[a-z0-9/_-]+)/i)?.[1]
    ?? stripped.match(/\b(?:with\s+)?(?:url|path|route|slug)\s+(\/[a-z0-9/_-]+)/i)?.[1]

  const usesCurrentPage =
    /\b(this|current|selected)\s+page\b/.test(lower) ||
    /\b(?:duplicate|copy|clone)\s+(this|current|selected)\b/.test(lower)
  // When user says "this page", source is the current page — don't grab route mentions as source
  const normalizedByTo = normalizeRouteCandidate(byToRoute ?? null)
  const sourceRouteCandidate = usesCurrentPage
    ? null
    : byCommandRoute ?? routeMentions.find((r) => normalizeRouteCandidate(r) !== normalizedByTo) ?? null
  let sourceSlug = normalizeRouteCandidate(sourceRouteCandidate)
  if (!sourceSlug && usesCurrentPage) sourceSlug = normalizeRouteCandidate(args?.currentSlug ?? null)

  let targetSlug = normalizeRouteCandidate(byToRoute ?? null)
  if (!targetSlug) {
    const secondRoute = routeMentions.length >= 2 ? normalizeRouteCandidate(routeMentions[1] ?? null) : null
    if (secondRoute && secondRoute !== sourceSlug) targetSlug = secondRoute
  }
  if (!targetSlug) {
    const nameMatch = stripped.match(/\b(?:called|named)\s+["']?([a-z0-9][a-z0-9 _-]{1,60})["']?/i)?.[1]?.trim()
    if (nameMatch) {
      const seed = toSeedSlug(nameMatch)
      if (seed) targetSlug = `/${seed}`
    }
  }

  if (!targetSlug || targetSlug === "/") return null
  if (!sourceSlug) sourceSlug = normalizeRouteCandidate(args?.currentSlug ?? null)
  if (!sourceSlug || sourceSlug === "/") return {
    sourceSlug: sourceSlug ?? null,
    targetSlug
  }
  return { sourceSlug, targetSlug }
}

/** Returns true when the message asks for AI-generated content alongside a page create. */
export function requestsContentGeneration(message: string) {
  const stripped = message.replace(/\n?\[site context\][\s\S]*?\[\/site context\]\s*$/i, "").trim()
  const lower = stripped.toLowerCase()
  const asksContent =
    /\bcontent\b/.test(lower) ||
    /\b(fill|populate)\b.*\b(page|it)\b/.test(lower) ||
    /\b(write|describe|explain)\b.*\b(about|for|on)\b/.test(lower) ||
    /\b(analyze|analyse|suggest|improve|rethink|rework)\b/.test(lower) ||
    /\balternate\s+(version|layout)\b/.test(lower) ||
    /\bbased\s+on\s+(the\s+)?(existing|current|original)\b/.test(lower)
  // Strip route paths before checking for block types so /faq doesn't match "faq"
  const withoutRoutes = lower.replace(/\/[a-z0-9/_-]+/g, "")
  const hasExplicitBlockTypes =
    /\b(hero|cta|call to action|rich\s?text|text\s+(?:section|block)|feature|testimonial|faq|card)\b/.test(withoutRoutes)
  // When a topic is specified AND multiple block types are enumerated
  // (e.g. "page about avocado recipes with a Hero, CardGrid, FAQ"),
  // defer to the LLM — the user wants AI-generated content, not empty scaffolds.
  const hasTopic = /\bpage\s+(?:about|on|for)\s+[a-z]/.test(lower)
  const blockTypeMatches = withoutRoutes.match(/\b(hero|cta|call to action|rich\s?text|text\s+(?:section|block)|feature|testimonial|faq|card)\b/g)
  if (hasTopic && blockTypeMatches && blockTypeMatches.length >= 2) return true
  return asksContent && !hasExplicitBlockTypes
}
