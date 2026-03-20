import type { PageDoc } from "./site-contract"

export const DEFAULT_SITE_DESCRIPTION = "Welcome to our site."

const CANDIDATE_PROP_KEYS = ["description", "subheading", "subtitle", "summary", "excerpt", "body", "text", "heading"]

function stripMarkdown(input: string) {
  return input
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[[^\]]+]\([^)]*\)/g, "$1")
    .replace(/[`*_>#~\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function truncateForMeta(input: string, maxLength = 160) {
  if (input.length <= maxLength) return input
  const truncated = input.slice(0, maxLength + 1)
  const lastSpace = truncated.lastIndexOf(" ")
  const base = (lastSpace > 80 ? truncated.slice(0, lastSpace) : truncated.slice(0, maxLength)).trim()
  return `${base}.`
}

function pickBlockText(page: Pick<PageDoc, "blocks">) {
  for (const block of page.blocks) {
    for (const key of CANDIDATE_PROP_KEYS) {
      const value = block.props[key]
      if (typeof value !== "string") continue
      const normalized = stripMarkdown(value)
      if (normalized.length >= 40) return normalized
    }
  }
  return null
}

export function derivePageDescription(page: Pick<PageDoc, "title" | "meta" | "blocks">) {
  const explicit = page.meta?.description?.trim()
  if (explicit) return truncateForMeta(stripMarkdown(explicit))

  const blockText = pickBlockText(page)
  if (blockText) return truncateForMeta(blockText)

  return truncateForMeta(`${page.title}. ${DEFAULT_SITE_DESCRIPTION}`)
}
