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
  const hasReferenceCue =
    /\b(selected|this|that|it|them|those|these|one|ones|same)\b/.test(normalized) ||
    /\bfirst|second|third|last\b/.test(normalized)
  const hasActionVerb = /\b(add|update|change|edit|remove|delete|move|rename|create|duplicate|set|rewrite|replace)\b/.test(normalized)
  return (words.length <= 8 && hasReferenceCue) || (!hasActionVerb && words.length <= 5)
}

export function isStandalonePageOperation(message: string) {
  const normalized = message.toLowerCase().trim().replace(/\s+/g, " ")
  return /\b(create|generate|add|make|build|remove|delete|rename|move)\b.*\bpage\b/.test(normalized)
}

export function parseCreatePageRequest(message: string) {
  // Strip [site context]...[/site context] metadata to prevent false route matches
  const stripped = message.replace(/\n?\[site context\][\s\S]*?\[\/site context\]\s*$/i, "").trim()
  const lower = stripped.toLowerCase().replace(/\s+/g, " ").trim()
  const mentionsCurrentPage = /\b(this|current|selected)\s+page\b/.test(lower)
  const hasExplicitRoute = Boolean(firstRouteMention(stripped) ?? extractRouteMentions(stripped)[0])
  const asksNewPage = /\bnew\s+page\b/.test(lower)
  if (mentionsCurrentPage && !asksNewPage && !hasExplicitRoute) return null

  const hasPageWord = /\bpages?\b/.test(lower)
  if (!hasPageWord) return null
  const explicitCreatePhrase =
    /\b(create|generate|make|build|draft)\b[^.\n]{0,24}\b(new\s+)?pages?\b/.test(lower) ||
    /\badd\b[^.\n]{0,16}\bnew\s+pages?\b/.test(lower) ||
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

  const forAudience = lower.match(/\bpage\s+for\s+([a-z0-9 -]{2,60})$/)?.[1]
  if (forAudience) {
    const seed = toSeedSlug(forAudience)
    if (seed) return `/for-${seed}`
  }

  const aboutTopic = lower.match(/\b(?:new\s+)?page\s+(?:about|on|for)\s+([a-z0-9 -]{2,60})\b/)?.[1]
  if (aboutTopic) {
    const seed = toSeedSlug(aboutTopic)
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

  const usesCurrentPage = /\b(this|current|selected)\s+page\b/.test(lower)
  let sourceSlug = normalizeRouteCandidate(byCommandRoute ?? routeMentions[0] ?? null)
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
    /\b(write|describe|explain)\b.*\b(about|for|on)\b/.test(lower)
  // Strip route paths before checking for block types so /faq doesn't match "faq"
  const withoutRoutes = lower.replace(/\/[a-z0-9/_-]+/g, "")
  const hasExplicitBlockTypes =
    /\b(hero|cta|call to action|rich\s?text|text\s+(?:section|block)|feature|testimonial|faq|card)\b/.test(withoutRoutes)
  return asksContent && !hasExplicitBlockTypes
}
