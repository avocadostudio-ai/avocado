import type { BlockType, EditPlan, PageDoc } from "@ai-site-editor/shared"
import { getAllBlockMeta } from "@ai-site-editor/shared"

export type TranslationScope = "page" | "component" | "none"

export function sanitizeMessageForPlanning(message: string) {
  const normalized = normalizeVariationTypos(message.replace(/\r\n?/g, "\n")).trim()
  if (normalized.length === 0) return normalized

  const hasDebugEcho = /(^|\n)\s*debug\s*$|(^|\n)\s*(traceid|prompthash|outcome|intent|opcount|ops)\s*:/im.test(normalized)
  const canonicalized = normalized
    // Normalize common smart quote variants so downstream quoted-text parsing is stable.
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, "\"")
    // Light typo normalization for frequently used edit verbs/nouns.
    .replace(/\btestomonials\b/gi, "testimonials")
    .replace(/\bfetures\b/gi, "features")
    .replace(/\bheding\b/gi, "heading")
    .replace(/\bad a\b/gi, "add a")
    .replace(/\bupdte\b/gi, "update")
  if (!hasDebugEcho) return canonicalized

  const promptEcho = canonicalized.match(/(^|\n)\s*prompt\s*:\s*(.+)$/im)?.[2]?.trim()
  if (promptEcho && promptEcho.length > 0) return promptEcho

  const cleanedLines = canonicalized
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => {
      if (line.trim().length === 0) return true
      if (/^\s*debug\s*$/i.test(line)) return false
      if (/^\s*(traceid|prompthash|outcome|intent|opcount|optypes|ops|reason|reasoncategory)\s*:/i.test(line)) return false
      if (/^\s*renamed the hero secondary cta\.?\s*$/i.test(line)) return false
      if (/^\s*performance awareness\b/i.test(line)) return false
      if (/semantic relevance and supports seo,\s*accessibility,\s*and conversion checks\.?\s*$/i.test(line)) return false
      return true
    })
  return cleanedLines.join("\n").trim()
}

export function inferTranslationScopeFromMessage(message: string): TranslationScope {
  const lower = message.toLowerCase()
  const isTranslation =
    /\btranslate\b/.test(lower) ||
    /\btranslation\b/.test(lower) ||
    /\blocaliz/.test(lower) ||
    /\bgerman\b/.test(lower) ||
    /\bdeutsch\b/.test(lower)
  if (!isTranslation) return "none"

  const pageScope =
    /\b(this|the|entire|whole|full)\s+page\b/.test(lower) ||
    /\bwhole\s+site\b/.test(lower) ||
    /\ball\s+sections?\b/.test(lower) ||
    /\btranslate\s+page\b/.test(lower)
  if (pageScope) return "page"

  const componentScope =
    /\b(this|selected|current)\s+(block|section|component)\b/.test(lower) ||
    /\btranslate\s+(the\s+)?(block|section|component)\b/.test(lower) ||
    /\bselected\s+component\b/.test(lower)
  if (componentScope) return "component"

  // Default translation intent to page scope unless the user explicitly narrows it.
  return "page"
}

export function isNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
}

function normalizeUpdatePropsPatch(op: Extract<EditPlan["ops"][number], { op: "update_props" }>) {
  const rawPatch = op.patch as Record<string, unknown>
  if (
    rawPatch &&
    typeof rawPatch.props === "object" &&
    rawPatch.props !== null &&
    !Array.isArray(rawPatch.props)
  ) {
    return rawPatch.props as Record<string, unknown>
  }
  return rawPatch
}

function isExplicitMultiTargetCtaRequest(message: string) {
  const lower = message.toLowerCase()
  const mentionsCta = /\bcta\b/.test(lower)
  const mentionsHeroTarget = /\bhero\b/.test(lower)
  const mentionsFooterTarget = /\bfooter\b/.test(lower) || /\bcta section\b/.test(lower)
  const asksMultipleTargets = /\b(both|all|each)\b/.test(lower) || (mentionsHeroTarget && mentionsFooterTarget)
  return mentionsCta && asksMultipleTargets && mentionsHeroTarget && mentionsFooterTarget
}

function shouldKeepLinksUnchanged(message: string) {
  const lower = message.toLowerCase()
  return (
    /\bkeep\b[^.\n]{0,80}\b(?:links?|hrefs?|urls?)\b[^.\n]{0,80}\bunchanged\b/.test(lower) ||
    /\b(?:without|don't|do not)\b[^.\n]{0,80}\bchange\b[^.\n]{0,80}\b(?:links?|hrefs?|urls?)\b/.test(lower)
  )
}

export function findExplicitCtaTargetCoverageGap(args: {
  plan: EditPlan
  message: string
  currentPage: PageDoc
  slug: string
}) {
  if (!isExplicitMultiTargetCtaRequest(args.message)) return null
  if (args.plan.intent !== "edit_plan") return null

  const hero = args.currentPage.blocks.find((block) => block.type === "Hero")
  const footerCta = args.currentPage.blocks.find((block) => block.type === "CTA")
  if (!hero || !footerCta) return null

  const heroOps = args.plan.ops.filter(
    (op): op is Extract<EditPlan["ops"][number], { op: "update_props" }> =>
      op.op === "update_props" && op.pageSlug === args.slug && op.blockId === hero.id
  )
  const footerOps = args.plan.ops.filter(
    (op): op is Extract<EditPlan["ops"][number], { op: "update_props" }> =>
      op.op === "update_props" && op.pageSlug === args.slug && op.blockId === footerCta.id
  )

  const heroCurrentCta = String((hero.props as Record<string, unknown>).ctaText ?? "")
  const footerCurrentCta = String((footerCta.props as Record<string, unknown>).ctaText ?? "")
  const heroCovered = heroOps.some((op) => {
    const patch = normalizeUpdatePropsPatch(op)
    const next = patch.ctaText
    return typeof next === "string" && next.trim().length > 0 && next.trim() !== heroCurrentCta.trim()
  })
  const footerCovered = footerOps.some((op) => {
    const patch = normalizeUpdatePropsPatch(op)
    const next = patch.ctaText
    return typeof next === "string" && next.trim().length > 0 && next.trim() !== footerCurrentCta.trim()
  })

  const missingTargets: string[] = []
  if (!heroCovered) missingTargets.push("hero CTA text")
  if (!footerCovered) missingTargets.push("footer CTA text")
  if (missingTargets.length > 0) {
    return `Invalid explicit CTA target coverage. Missing updates for: ${missingTargets.join(", ")}.`
  }

  if (!shouldKeepLinksUnchanged(args.message)) return null
  const linkChanged = [...heroOps, ...footerOps].some((op) => {
    const patch = normalizeUpdatePropsPatch(op)
    return Object.prototype.hasOwnProperty.call(patch, "ctaHref")
  })
  if (linkChanged) {
    return "Invalid explicit CTA target coverage. Request says to keep links unchanged, but plan modifies CTA links."
  }

  return null
}

export function findFullPageTranslationCoverageGap(args: {
  plan: EditPlan
  message: string
  currentPage: PageDoc
  slug: string
}) {
  if (inferTranslationScopeFromMessage(args.message) !== "page") return null
  if (args.plan.intent !== "edit_plan") return null

  const blockMeta = getAllBlockMeta()
  const touchedBlockIds = new Set(
    args.plan.ops
      .filter((op) => {
        if (!(op.op === "update_props" || op.op === "update_item" || op.op === "add_item" || op.op === "remove_item" || op.op === "move_item")) return false
        return "pageSlug" in op && op.pageSlug === args.slug
      })
      .map((op) => ("blockId" in op ? op.blockId : ""))
      .filter((id) => typeof id === "string" && id.length > 0)
  )
  if (touchedBlockIds.size === 0) return null

  const missingPaths: string[] = []
  for (const block of args.currentPage.blocks) {
    if (!touchedBlockIds.has(block.id)) continue
    const meta = blockMeta[block.type as BlockType]

    // --- Top-level scalar prop coverage ---
    if (meta?.fields) {
      const translatableTopLevel = Object.entries(meta.fields)
        .filter(([, fm]) => fm.kind === "text" || fm.kind === "richtext" || fm.kind === "imageAlt")
        .map(([key]) => key)

      if (translatableTopLevel.length > 0) {
        const coveredTopLevel = new Set<string>()
        for (const op of args.plan.ops) {
          if (!("pageSlug" in op) || op.pageSlug !== args.slug) continue
          if (op.op === "update_props" && op.blockId === block.id) {
            const patch = normalizeUpdatePropsPatch(op as Extract<EditPlan["ops"][number], { op: "update_props" }>)
            for (const key of translatableTopLevel) {
              if (isNonEmptyString(patch[key])) coveredTopLevel.add(key)
            }
          }
        }

        const blockProps = block.props as Record<string, unknown>
        for (const key of translatableTopLevel) {
          if (!isNonEmptyString(blockProps[key])) continue
          if (!coveredTopLevel.has(key)) missingPaths.push(`${block.id}.${key}`)
        }
      }
    }

    // --- List field child coverage ---
    const listFields = meta?.listFields ?? {}
    const listEntries = Object.entries(listFields)

    for (const [listKey, listMeta] of listEntries) {
      const translatableItemFields = Object.entries(listMeta.itemFields ?? {})
        .filter(([, fieldMeta]) => fieldMeta.kind === "text" || fieldMeta.kind === "richtext" || fieldMeta.kind === "imageAlt")
        .map(([key]) => key)
      if (translatableItemFields.length === 0) continue

      const listValue = (block.props as Record<string, unknown>)[listKey]
      if (!Array.isArray(listValue) || listValue.length === 0) continue
      const perItemCoverage = new Map<number, Set<string>>()
      const ensureCoverage = (index: number) => {
        const existing = perItemCoverage.get(index)
        if (existing) return existing
        const next = new Set<string>()
        perItemCoverage.set(index, next)
        return next
      }

      for (const op of args.plan.ops) {
        if (!("pageSlug" in op) || op.pageSlug !== args.slug) continue
        if (op.op === "update_item" && op.blockId === block.id && op.listKey === listKey) {
          const patch = op.patch as Record<string, unknown>
          const cov = ensureCoverage(op.index)
          for (const key of translatableItemFields) {
            if (isNonEmptyString(patch[key])) cov.add(key)
          }
          continue
        }
        if (op.op === "update_props" && op.blockId === block.id) {
          const patch = op.patch as Record<string, unknown>
          if (!Array.isArray(patch[listKey])) continue
          const rows = patch[listKey] as unknown[]
          for (let idx = 0; idx < rows.length; idx += 1) {
            const rowPatch = rows[idx]
            if (!rowPatch || typeof rowPatch !== "object" || Array.isArray(rowPatch)) continue
            const row = rowPatch as Record<string, unknown>
            const cov = ensureCoverage(idx)
            for (const key of translatableItemFields) {
              if (isNonEmptyString(row[key])) cov.add(key)
            }
          }
        }
      }

      for (let idx = 0; idx < listValue.length; idx += 1) {
        const item = listValue[idx]
        if (!item || typeof item !== "object" || Array.isArray(item)) continue
        const row = item as Record<string, unknown>
        const required = translatableItemFields.filter((key) => isNonEmptyString(row[key]))
        if (required.length === 0) continue
        const covered = perItemCoverage.get(idx) ?? new Set<string>()
        const missing = required.filter((key) => !covered.has(key))
        for (const field of missing) missingPaths.push(`${block.id}.${listKey}[${idx}].${field}`)
      }
    }
  }

  if (missingPaths.length === 0) return null
  return `Invalid full-page translation coverage. Missing translated fields: ${missingPaths.join(", ")}`
}

export function normalizeVariationTypos(text: string) {
  return text
    .replace(/\bvariaqtions?\b/gi, "variations")
    .replace(/\bvariatons?\b/gi, "variations")
    .replace(/\bvaritions?\b/gi, "variations")
    .replace(/\bvariants?\b/gi, (m) => m.endsWith("s") ? "variations" : "variation")
}
