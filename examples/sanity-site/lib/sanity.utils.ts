import { getAllBlockMeta } from "@ai-site-editor/shared"

/** Convert PascalCase block type to Sanity camelCase: CTA → cta, FAQAccordion → faqAccordion */
export function toSanityName(pascalCase: string): string {
  if (pascalCase === pascalCase.toUpperCase()) return pascalCase.toLowerCase()
  const match = pascalCase.match(/^([A-Z]+)([A-Z][a-z].*)$/)
  if (match) return match[1].toLowerCase() + match[2]
  return pascalCase.charAt(0).toLowerCase() + pascalCase.slice(1)
}

/** Reverse lookup: sanity name → block type (cta → CTA, faqAccordion → FAQAccordion) */
const _sanityNameMap = new Map<string, string>()
for (const blockType of Object.keys(getAllBlockMeta())) {
  _sanityNameMap.set(toSanityName(blockType), blockType)
}

export function sanityNameToBlockType(sanityName: string): string {
  return _sanityNameMap.get(sanityName) ?? sanityName.charAt(0).toUpperCase() + sanityName.slice(1)
}

// Re-exported from @ai-site-editor/shared
export { getImageFields, getListImageFields } from "@ai-site-editor/shared"

/** List props stored as Sanity document references (vs inline array objects). */
export const REFERENCE_LISTS: Record<string, Set<string>> = {
  CardGrid: new Set(["cards"]),
}
