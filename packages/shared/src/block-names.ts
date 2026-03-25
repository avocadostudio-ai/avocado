import { getAllBlockMeta } from "./blocks/_registry.ts"

/**
 * Block type name mapping utilities.
 *
 * The block registry uses PascalCase (e.g. "FAQAccordion", "CTA", "CardGrid").
 * Different CMSs use different conventions:
 *   - Sanity: camelCase ("faqAccordion", "cta", "cardGrid")
 *   - Strapi/Contentful: lowercase ("faqaccordion", "cta", "cardgrid")
 *
 * These helpers provide canonical lookups so each CMS integration
 * doesn't need to maintain its own reverse map.
 */

// ── PascalCase → camelCase (Sanity convention) ─────────────────────────

/** Convert PascalCase block type to camelCase: CTA → cta, FAQAccordion → faqAccordion */
export function blockTypeToCamel(pascalCase: string): string {
  // All-uppercase acronyms: CTA → cta
  if (pascalCase === pascalCase.toUpperCase()) return pascalCase.toLowerCase()
  // Leading acronym: FAQAccordion → faqAccordion
  const match = pascalCase.match(/^([A-Z]+)([A-Z][a-z].*)$/)
  if (match) return match[1].toLowerCase() + match[2]
  // Normal PascalCase: CardGrid → cardGrid
  return pascalCase.charAt(0).toLowerCase() + pascalCase.slice(1)
}

// ── Reverse lookup maps (built lazily from registry) ────────────────────

let _camelMap: Map<string, string> | null = null
let _lowerMap: Map<string, string> | null = null

function ensureMaps() {
  if (_camelMap) return
  _camelMap = new Map()
  _lowerMap = new Map()
  for (const blockType of Object.keys(getAllBlockMeta())) {
    _camelMap.set(blockTypeToCamel(blockType), blockType)
    _lowerMap.set(blockType.toLowerCase(), blockType)
  }
}

/** Reverse lookup: camelCase → PascalCase (faqAccordion → FAQAccordion). Sanity convention. */
export function camelToBlockType(camelName: string): string {
  ensureMaps()
  return _camelMap!.get(camelName) ?? camelName.charAt(0).toUpperCase() + camelName.slice(1)
}

/** Reverse lookup: lowercase → PascalCase (faqaccordion → FAQAccordion). Strapi/Contentful convention. */
export function lowerToBlockType(lowerName: string): string {
  ensureMaps()
  return _lowerMap!.get(lowerName) ?? lowerName.charAt(0).toUpperCase() + lowerName.slice(1)
}

/** Convert PascalCase to lowercase: FAQAccordion → faqaccordion */
export function blockTypeToLower(pascalCase: string): string {
  return pascalCase.toLowerCase()
}
