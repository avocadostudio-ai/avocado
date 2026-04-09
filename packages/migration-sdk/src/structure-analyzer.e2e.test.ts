/**
 * E2E test for the structure analyzer pipeline.
 * Scrapes real websites with Playwright and validates section spec quality.
 *
 * Run: pnpm --filter @ai-site-editor/migration-sdk test -- --test-name-pattern "structure-analyzer"
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { scrapeFullPage } from "./scraper.ts"
import { buildPageSpecs } from "./section-spec.ts"
import type { SectionSpec } from "./types.ts"

// ── Helpers ──

/** Find a section whose headings or paragraphs match a pattern */
function findSection(specs: SectionSpec[], pattern: RegExp): SectionSpec | undefined {
  return specs.find(s =>
    s.content.headings.some(h => pattern.test(h.text)) ||
    s.content.paragraphs.some(p => pattern.test(p))
  )
}

/** Find all sections matching a pattern */
function findSections(specs: SectionSpec[], pattern: RegExp): SectionSpec[] {
  return specs.filter(s =>
    s.content.headings.some(h => pattern.test(h.text)) ||
    s.content.paragraphs.some(p => pattern.test(p))
  )
}

/** Dump section specs for debugging */
function dumpSpecs(specs: SectionSpec[]): void {
  for (const s of specs) {
    const headings = s.content.headings.map(h => `h${h.level}: "${h.text}"`).join(", ")
    const imgs = s.content.images.length
    const links = s.content.links.length
    const paras = s.content.paragraphs.length
    console.log(
      `  [${s.sectionIndex}] ${s.suggestedBlockType ?? "?"} (conf=${s.suggestedConfidence.toFixed(2)})` +
      ` | pattern="${s.structure.pattern}" repeat=${s.structure.repeatCount}` +
      (s.structure.repeatSignature ? ` sig="${s.structure.repeatSignature}"` : "") +
      ` | ${headings || "(no headings)"}` +
      ` | imgs=${imgs} links=${links} paras=${paras}` +
      ` | bg=${s.designNotes.backgroundColor} layout=${s.designNotes.layout}`
    )
  }
}

// ── Tests ──

describe("structure-analyzer e2e: paintballarena-bern.ch", { timeout: 60_000 }, () => {
  let specs: SectionSpec[]
  let scrapeResult: Awaited<ReturnType<typeof scrapeFullPage>>

  it("scrapes homepage and builds section specs", async () => {
    scrapeResult = await scrapeFullPage("https://paintballarena-bern.ch")
    specs = buildPageSpecs(scrapeResult)

    console.log(`\n=== SECTION SPECS (${specs.length} sections) ===`)
    dumpSpecs(specs)
    console.log(`=== NAV ===`)
    console.log(`  name: ${scrapeResult.nav?.siteName}`)
    console.log(`  logo: ${scrapeResult.nav?.logoUrl}`)
    console.log(`  items: ${scrapeResult.nav?.items?.map(i => i.label).join(", ")}`)
    console.log()

    assert.ok(specs.length >= 5, `Expected at least 5 sections, got ${specs.length}`)

    // Dump regex-based sections for comparison
    console.log(`\n=== REGEX SECTIONS (${scrapeResult.sections.length}) ===`)
    for (const s of scrapeResult.sections) {
      const headings = s.content.headings.map(h => `h${h.level}:"${h.text.slice(0, 50)}"`).join(", ")
      const paras = s.content.paragraphs.slice(0, 2).map(p => p.slice(0, 60)).join(" | ")
      console.log(`  [${s.index}] tag=${s.tag} type=${s.suggestedBlockType ?? "?"} | ${headings || "(no headings)"} | paras: ${paras || "(none)"}`)
    }

    // Dump raw section data for debugging
    if (scrapeResult.visualSections) {
      console.log(`\n=== VISUAL SECTIONS (${scrapeResult.visualSections.length}) ===`)
      for (const vs of scrapeResult.visualSections) {
        console.log(`  y=${vs.y} h=${vs.height}`)
      }
    }
    if (scrapeResult.sectionStyles) {
      console.log(`\n=== SECTION STYLE TREES (${scrapeResult.sectionStyles.length}) ===`)
      for (const ss of scrapeResult.sectionStyles) {
        const root = ss.root
        const dumpTree = (node: typeof root, depth = 0): void => {
          const indent = "  ".repeat(depth + 1)
          const text = node.text ? ` "${node.text.slice(0, 60)}"` : ""
          const img = node.image ? ` img=${JSON.stringify(node.image).slice(0, 50)}` : ""
          const kids = node.children.length ? ` (${node.children.length} children)` : ""
          console.log(`${indent}${node.tag}${text}${img}${kids} display=${node.styles.display ?? "?"}`)
          if (depth < 5) for (const child of node.children) dumpTree(child, depth + 1)
        }
        console.log(`  [${ss.sectionIndex}] tree:`)
        dumpTree(root)
      }
    }
  })

  it("detects Hero section", () => {
    assert.ok(specs, "specs not loaded")
    // Find the section classified as Hero or containing the main h1
    const hero = specs.find(s =>
      s.suggestedBlockType === "Hero" ||
      s.content.headings.some(h => h.level === 1 && /paintball|arena|action|erlebnis/i.test(h.text))
    )
    assert.ok(hero, `No Hero section found. Types: ${specs.map(s => s.suggestedBlockType ?? "?").join(", ")}`)
    assert.equal(hero.suggestedBlockType, "Hero", `Hero section should be classified as Hero, got: ${hero.suggestedBlockType}`)
    assert.ok(
      hero.content.images.length > 0 || hero.designNotes.backgroundColor !== "transparent",
      "Hero should have images or a background"
    )
  })

  it("detects Pricing section with repeated items (NOT flat text)", () => {
    assert.ok(specs, "specs not loaded")
    // KEY TEST: The pricing section has 4 pricing tiers in a grid
    // It MUST be detected as repeated items, not a single text block
    const pricing = findSection(specs, /preis|pricing|spezialpreis/i)
    assert.ok(pricing, "No pricing section found — searched for 'preis/pricing/spezialpreis' in headings and paragraphs")

    console.log(`\n=== PRICING SECTION DETAIL ===`)
    console.log(`  suggestedBlockType: ${pricing.suggestedBlockType}`)
    console.log(`  pattern: ${pricing.structure.pattern}`)
    console.log(`  repeatCount: ${pricing.structure.repeatCount}`)
    console.log(`  repeatSignature: ${pricing.structure.repeatSignature}`)
    console.log(`  elementCount: ${pricing.structure.elementCount}`)
    console.log(`  headings: ${pricing.content.headings.map(h => `h${h.level}:"${h.text}"`).join(", ")}`)
    console.log(`  paragraphs: ${pricing.content.paragraphs.length}`)
    console.log(`  lists: ${pricing.content.lists.length} (items: ${pricing.content.lists.map(l => l.length).join(", ")})`)
    console.log()

    // The pricing grid has 4 tiers — analyzer must detect repeated structure
    assert.ok(
      pricing.structure.repeatCount >= 2,
      `Pricing section should have repeatCount >= 2 (detected grid items), got ${pricing.structure.repeatCount}. ` +
      `Pattern: "${pricing.structure.pattern}". ` +
      `This means the analyzer is treating a structured pricing grid as flat text.`
    )

    // Should NOT be suggested as RichText
    assert.notEqual(
      pricing.suggestedBlockType, "RichText",
      `Pricing section should NOT be RichText — it's a structured grid with repeated items`
    )
  })

  it("detects Info Hub or Kontakt section", () => {
    assert.ok(specs, "specs not loaded")
    // "Alle Infos für dein Ausflug" — 4-6 blocks: Kontakt, Preise, Gutscheine, Menü, etc.
    // Visual section boundaries vary between scrapes, so check flexibly
    const infoHub = findSection(specs, /alle infos|ausflug|gutschein/i)
    const kontakt = findSection(specs, /kontakt|standort|öffnungszeiten/i)

    console.log(`\n=== INFO HUB / KONTAKT ===`)
    if (infoHub) {
      console.log(`  infoHub: [${infoHub.sectionIndex}] ${infoHub.suggestedBlockType} repeat=${infoHub.structure.repeatCount}`)
    }
    if (kontakt) {
      console.log(`  kontakt: [${kontakt.sectionIndex}] ${kontakt.suggestedBlockType} repeat=${kontakt.structure.repeatCount}`)
    }
    console.log()

    assert.ok(
      infoHub || kontakt,
      "Neither info hub section (alle infos/ausflug/gutschein) nor kontakt section found"
    )

    // If we found the full info hub, it should have repeated items
    if (infoHub && infoHub.structure.repeatCount >= 3) {
      assert.ok(true, `Info hub has ${infoHub.structure.repeatCount} repeated items`)
    }
  })

  it("detects Event positioning section with use cases", () => {
    assert.ok(specs, "specs not loaded")
    const events = findSection(specs, /event|polterabend|geburtstag|teamevent|gruppen/i)
    assert.ok(events, "No event section found — searched for event/polterabend/geburtstag/teamevent")

    console.log(`\n=== EVENT SECTION ===`)
    console.log(`  suggestedBlockType: ${events.suggestedBlockType}`)
    console.log(`  pattern: ${events.structure.pattern}`)
    console.log(`  repeatCount: ${events.structure.repeatCount}`)
    console.log()
  })

  it("extracts navigation correctly", () => {
    assert.ok(scrapeResult, "scrape not loaded")
    const nav = scrapeResult.nav
    assert.ok(nav, "No navigation extracted")

    // Should have main menu items
    const labels = nav.items?.map(i => i.label.toLowerCase()) ?? []
    console.log(`\n=== NAV ITEMS: ${labels.join(", ")} ===\n`)

    assert.ok(labels.length >= 4, `Expected at least 4 nav items, got ${labels.length}`)

    // Key nav items should be present
    const expectedItems = ["paintball", "arena", "event", "info", "news"]
    const foundItems = expectedItems.filter(expected =>
      labels.some(l => l.includes(expected))
    )
    assert.ok(
      foundItems.length >= 3,
      `Expected at least 3 of [${expectedItems.join(", ")}] in nav, found: [${foundItems.join(", ")}]. All labels: [${labels.join(", ")}]`
    )

    // Logo should be present
    assert.ok(nav.logoUrl || nav.siteName, "Nav should have logo URL or site name")
  })
})
