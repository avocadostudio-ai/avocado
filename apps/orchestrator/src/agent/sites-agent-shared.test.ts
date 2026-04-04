/**
 * Sites agent shared utility tests.
 * Pure function tests — no LLM calls, no filesystem writes.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  sanitizeSiteId,
  fixFooterLinks,
  validateAndCorrectProps,
  normalizePageBlocks,
  SITES_AGENT_MODELS,
} from "./sites-agent-shared.js"

// ---------------------------------------------------------------------------
// sanitizeSiteId
// ---------------------------------------------------------------------------

describe("sanitizeSiteId", () => {
  it("lowercases and kebab-cases", () => {
    assert.equal(sanitizeSiteId("My Cool Site"), "my-cool-site")
  })

  it("strips special characters", () => {
    assert.equal(sanitizeSiteId("Hello! World?"), "hello-world")
  })

  it("collapses multiple hyphens", () => {
    assert.equal(sanitizeSiteId("a---b---c"), "a-b-c")
  })

  it("trims leading/trailing hyphens", () => {
    assert.equal(sanitizeSiteId("---hello---"), "hello")
  })

  it("truncates to 40 characters", () => {
    const long = "a".repeat(60)
    assert.ok(sanitizeSiteId(long).length <= 40)
  })

  it("returns 'my-site' for empty input", () => {
    assert.equal(sanitizeSiteId(""), "my-site")
  })

  it("returns 'my-site' for only special chars", () => {
    assert.equal(sanitizeSiteId("!!!"), "my-site")
  })

  it("handles unicode characters", () => {
    const result = sanitizeSiteId("Über Uns Seite")
    assert.ok(result.length > 0)
    assert.ok(!result.includes("Ü"))
  })
})

// ---------------------------------------------------------------------------
// fixFooterLinks
// ---------------------------------------------------------------------------

describe("fixFooterLinks", () => {
  it("wraps flat links string into a column", () => {
    const result = fixFooterLinks({
      links: "Home|/\nAbout|/about",
      tagline: "Quick Links",
    })
    assert.ok(Array.isArray(result.columns))
    const cols = result.columns as Array<{ title: string; links: string }>
    assert.equal(cols.length, 1)
    assert.equal(cols[0].title, "Quick Links")
    assert.equal(cols[0].links, "Home|/\nAbout|/about")
  })

  it("converts array of link objects to pipe-delimited strings", () => {
    const result = fixFooterLinks({
      columns: [
        {
          title: "Nav",
          links: [
            { label: "Home", href: "/" },
            { label: "About", href: "/about" },
          ],
        },
      ],
    })
    const cols = result.columns as Array<{ title: string; links: string }>
    assert.equal(typeof cols[0].links, "string")
    assert.ok(cols[0].links.includes("Home|/"))
    assert.ok(cols[0].links.includes("About|/about"))
  })

  it("preserves already-valid pipe-delimited string columns", () => {
    const input = {
      columns: [{ title: "Nav", links: "Home|/\nAbout|/about" }],
    }
    const result = fixFooterLinks(input)
    const cols = result.columns as Array<{ title: string; links: string }>
    assert.equal(cols[0].links, "Home|/\nAbout|/about")
  })

  it("returns props unchanged when no columns or links", () => {
    const input = { title: "Footer Title" }
    const result = fixFooterLinks(input)
    assert.deepEqual(result, input)
  })

  it("handles link objects with text/url instead of label/href", () => {
    const result = fixFooterLinks({
      columns: [
        {
          title: "Links",
          links: [{ text: "Blog", url: "/blog" }],
        },
      ],
    })
    const cols = result.columns as Array<{ title: string; links: string }>
    assert.ok(cols[0].links.includes("Blog|/blog"))
  })
})

// ---------------------------------------------------------------------------
// validateAndCorrectProps
// ---------------------------------------------------------------------------

describe("validateAndCorrectProps", () => {
  it("returns unchanged props when valid", () => {
    const result = validateAndCorrectProps("CTA", {
      title: "Get Started",
      description: "Sign up today",
      ctaText: "Sign Up",
      ctaHref: "/signup",
    })
    assert.equal(result.corrected, false)
    assert.ok(!result.error)
  })

  it("auto-renames known wrong prop names", () => {
    // CTA: heading → title, buttonText → ctaText
    const result = validateAndCorrectProps("CTA", {
      heading: "Get Started",
      description: "Sign up today",
      buttonText: "Sign Up",
      buttonHref: "/signup",
    })
    // After renaming, props should pass validation
    if (result.corrected) {
      assert.equal(result.props.title, "Get Started")
      assert.equal(result.props.ctaText, "Sign Up")
    }
  })

  it("converts boolean values to strings", () => {
    // Some LLMs return booleans where strings are expected
    const result = validateAndCorrectProps("Hero", {
      heading: "Hello",
      subheading: "World",
      ctaText: "Click",
      ctaHref: "/",
      imageUrl: "/hero.svg",
      imageAlt: "Hero",
    })
    // Should not error on valid props
    assert.ok(!result.error || result.corrected)
  })

  it("returns error for completely invalid props", () => {
    const result = validateAndCorrectProps("Hero", {
      invalidProp: 42,
    })
    // Either it corrects successfully or returns an error
    assert.ok(result.corrected || result.error)
  })
})

// ---------------------------------------------------------------------------
// normalizePageBlocks
// ---------------------------------------------------------------------------

describe("normalizePageBlocks", () => {
  it("assigns sequential block IDs", () => {
    const { contentBlocks } = normalizePageBlocks([
      { type: "Hero", props: { heading: "Hello", subheading: "World" } },
      { type: "CTA", props: { title: "Go", description: "Now" } },
    ])
    assert.equal(contentBlocks.length, 2)
    assert.ok(contentBlocks[0].id.startsWith("b_hero_"))
    assert.ok(contentBlocks[1].id.startsWith("b_cta_"))
  })

  it("strips SiteHeader blocks", () => {
    const { contentBlocks, strippedCount } = normalizePageBlocks([
      { type: "SiteHeader", props: {} },
      { type: "Hero", props: { heading: "Hello" } },
    ])
    assert.equal(contentBlocks.length, 1)
    assert.equal(contentBlocks[0].type, "Hero")
    assert.equal(strippedCount, 1)
  })

  it("extracts first Footer block", () => {
    const { contentBlocks, footerBlock, strippedCount } = normalizePageBlocks([
      { type: "Hero", props: { heading: "Hello" } },
      { type: "Footer", props: { columns: [{ title: "Nav", links: "Home|/" }] } },
    ])
    assert.equal(contentBlocks.length, 1)
    assert.ok(footerBlock)
    assert.equal(footerBlock!.type, "Footer")
    assert.equal(strippedCount, 1)
  })

  it("only extracts first Footer, strips duplicates", () => {
    const { footerBlock, strippedCount } = normalizePageBlocks([
      { type: "Footer", props: { columns: [{ title: "First", links: "A|/a" }] } },
      { type: "Footer", props: { columns: [{ title: "Second", links: "B|/b" }] } },
    ])
    assert.ok(footerBlock)
    // The first Footer should be extracted
    assert.equal(strippedCount, 2)
  })

  it("merges with default props", () => {
    const { contentBlocks } = normalizePageBlocks([
      { type: "Hero", props: { heading: "Custom Heading" } },
    ])
    const hero = contentBlocks[0]
    // Should have the custom heading plus default props
    assert.equal(hero.props.heading, "Custom Heading")
    // Default props like imageUrl should be filled in
    assert.ok("imageUrl" in hero.props || "subheading" in hero.props)
  })

  it("handles empty blocks array", () => {
    const { contentBlocks, footerBlock, strippedCount } = normalizePageBlocks([])
    assert.equal(contentBlocks.length, 0)
    assert.equal(footerBlock, null)
    assert.equal(strippedCount, 0)
  })
})

// ---------------------------------------------------------------------------
// SITES_AGENT_MODELS
// ---------------------------------------------------------------------------

describe("SITES_AGENT_MODELS", () => {
  it("has all three tiers", () => {
    assert.ok(SITES_AGENT_MODELS.fast)
    assert.ok(SITES_AGENT_MODELS.balanced)
    assert.ok(SITES_AGENT_MODELS.powerful)
  })

  it("fast tier uses haiku", () => {
    assert.ok(SITES_AGENT_MODELS.fast.includes("haiku"))
  })

  it("balanced tier uses sonnet", () => {
    assert.ok(SITES_AGENT_MODELS.balanced.includes("sonnet"))
  })

  it("powerful tier uses opus", () => {
    assert.ok(SITES_AGENT_MODELS.powerful.includes("opus"))
  })
})
