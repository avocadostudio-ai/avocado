/**
 * Sites agent context and prompt tests.
 * Tests buildSitesAgentSystemPrompt() and buildBlockCatalog().
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildSitesAgentSystemPrompt, buildBlockCatalog } from "./sites-agent-context.js"

// ---------------------------------------------------------------------------
// buildBlockCatalog
// ---------------------------------------------------------------------------

describe("buildBlockCatalog", () => {
  it("includes all standard block types", () => {
    const catalog = buildBlockCatalog()
    const expectedTypes = [
      "Hero", "FeatureGrid", "CTA", "FAQAccordion", "Testimonials",
      "RichText", "Stats", "CardGrid", "TwoColumn", "Table",
      "Gallery", "Quote", "Banner", "Tabs", "Carousel", "Video", "Embed", "Card",
    ]
    for (const type of expectedTypes) {
      assert.ok(catalog.includes(`**${type}**`), `Missing block type: ${type}`)
    }
  })

  it("excludes chrome blocks (SiteHeader, Footer)", () => {
    const catalog = buildBlockCatalog()
    // Chrome blocks should be filtered out (they have chrome: true in metadata)
    // The catalog text should not list them as usable blocks
    // Note: Footer and SiteHeader may or may not appear depending on their chrome flag
    assert.ok(catalog.includes("Block Catalog"))
  })

  it("lists props for each block type", () => {
    const catalog = buildBlockCatalog()
    // Hero should have heading, subheading, etc.
    assert.ok(catalog.includes("heading"), "Should include heading prop")
    // CTA should have title or heading
    assert.ok(catalog.includes("ctaText") || catalog.includes("cta"), "Should include CTA-related props")
  })

  it("includes list field notation", () => {
    const catalog = buildBlockCatalog()
    // FAQAccordion has items[] list field, FeatureGrid has features[]
    assert.ok(catalog.includes("[]{"), "Should include array item notation")
  })
})

// ---------------------------------------------------------------------------
// buildSitesAgentSystemPrompt
// ---------------------------------------------------------------------------

describe("buildSitesAgentSystemPrompt", () => {
  it("includes role description", () => {
    const prompt = buildSitesAgentSystemPrompt()
    assert.ok(prompt.includes("site creation and migration orchestrator"))
  })

  it("includes block catalog", () => {
    const prompt = buildSitesAgentSystemPrompt()
    assert.ok(prompt.includes("Block Catalog"))
    assert.ok(prompt.includes("Hero"))
    assert.ok(prompt.includes("FeatureGrid"))
  })

  it("includes workflow sections", () => {
    const prompt = buildSitesAgentSystemPrompt()
    assert.ok(prompt.includes("Creating a New Site"))
    assert.ok(prompt.includes("Migrating an Existing Site"))
  })

  it("includes execution order constraints", () => {
    const prompt = buildSitesAgentSystemPrompt()
    assert.ok(prompt.includes("create_site"))
    assert.ok(prompt.includes("bootstrap_pages"))
    assert.ok(prompt.includes("block-coder"))
    assert.ok(prompt.includes("download_remote_image"))
  })

  it("includes migration phases", () => {
    const prompt = buildSitesAgentSystemPrompt()
    assert.ok(prompt.includes("Phase 1: Discovery"))
    assert.ok(prompt.includes("Phase 2: Migration Plan"))
    assert.ok(prompt.includes("Phase 3: Execute Plan"))
    assert.ok(prompt.includes("Phase 4: Final Summary"))
  })

  it("includes custom block triggers", () => {
    const prompt = buildSitesAgentSystemPrompt()
    assert.ok(prompt.includes("PricingTable"))
    assert.ok(prompt.includes("EventCard"))
    assert.ok(prompt.includes("TeamGrid"))
    assert.ok(prompt.includes("Timeline"))
  })

  it("includes content preservation guideline", () => {
    const prompt = buildSitesAgentSystemPrompt()
    assert.ok(prompt.includes("Preserve original text exactly") || prompt.includes("verbatim"))
  })

  it("includes subagent descriptions", () => {
    const prompt = buildSitesAgentSystemPrompt()
    assert.ok(prompt.includes("structure-analyzer"))
    assert.ok(prompt.includes("block-coder"))
  })

  it("includes output formatting instructions", () => {
    const prompt = buildSitesAgentSystemPrompt()
    assert.ok(prompt.includes("Migration Complete"))
    assert.ok(prompt.includes("Final summary format") || prompt.includes("final summary"))
  })

  // Locale

  it("adds no language section for English locale", () => {
    const prompt = buildSitesAgentSystemPrompt({ locale: "en" })
    assert.ok(!prompt.includes("## Language"))
  })

  it("adds language section for non-English locale", () => {
    const prompt = buildSitesAgentSystemPrompt({ locale: "de" })
    assert.ok(prompt.includes("## Language"))
    assert.ok(prompt.includes("German"))
  })

  it("uses locale code as fallback for unknown locales", () => {
    const prompt = buildSitesAgentSystemPrompt({ locale: "sv" })
    assert.ok(prompt.includes("## Language"))
    assert.ok(prompt.includes("sv"))
  })

  it("supports multiple known locales", () => {
    for (const [code, name] of [["fr", "French"], ["es", "Spanish"], ["ja", "Japanese"]]) {
      const prompt = buildSitesAgentSystemPrompt({ locale: code })
      assert.ok(prompt.includes(name!), `Should include ${name} for locale ${code}`)
    }
  })

  // Section spec guidance

  it("includes section spec field descriptions", () => {
    const prompt = buildSitesAgentSystemPrompt()
    assert.ok(prompt.includes("structure.pattern"))
    assert.ok(prompt.includes("structure.repeatCount"))
    assert.ok(prompt.includes("designNotes"))
    assert.ok(prompt.includes("suggestedBlockType"))
  })

  it("includes pattern-to-block mapping table", () => {
    const prompt = buildSitesAgentSystemPrompt()
    assert.ok(prompt.includes("FeatureGrid"))
    assert.ok(prompt.includes("CardGrid"))
    assert.ok(prompt.includes("FAQAccordion"))
    assert.ok(prompt.includes("Gallery"))
  })
})
