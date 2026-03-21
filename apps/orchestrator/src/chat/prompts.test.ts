import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  buildIntentParserSystemPrompt,
  buildPlannerSystemPrompt,
  buildVariationSystemPrompt,
  buildDecomposerSystemPrompt,
} from "./prompts.js"

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

// ---------------------------------------------------------------------------
// Determinism — same options always produce same output
// ---------------------------------------------------------------------------

describe("prompt builders are deterministic", () => {
  test("buildIntentParserSystemPrompt", () => {
    const a = buildIntentParserSystemPrompt()
    const b = buildIntentParserSystemPrompt()
    assert.equal(a, b)
  })

  test("buildPlannerSystemPrompt (openai, full)", () => {
    const opts = {
      provider: "openai" as const,
      lightweight: false,
      selectedBlockId: "b_hero_1",
      explicitOtherReference: false,
      chatStrictPrimaryOpMode: false,
      pageWideTranslation: false,
      pageWideRewrite: false,
      effectiveBlockTypes: ["Hero", "CTA"],
    }
    assert.equal(buildPlannerSystemPrompt(opts), buildPlannerSystemPrompt(opts))
  })

  test("buildPlannerSystemPrompt (anthropic, full)", () => {
    const opts = {
      provider: "anthropic" as const,
      lightweight: false,
      selectedBlockId: "b_hero_1",
      explicitOtherReference: false,
      chatStrictPrimaryOpMode: false,
      pageWideTranslation: false,
      pageWideRewrite: false,
      effectiveBlockTypes: ["Hero", "CTA"],
    }
    assert.equal(buildPlannerSystemPrompt(opts), buildPlannerSystemPrompt(opts))
  })

  test("buildPlannerSystemPrompt (lightweight)", () => {
    const opts = {
      provider: "openai" as const,
      lightweight: true,
      selectedBlockId: "",
      explicitOtherReference: false,
      chatStrictPrimaryOpMode: false,
      pageWideTranslation: false,
      pageWideRewrite: false,
      effectiveBlockTypes: ["Hero"],
    }
    assert.equal(buildPlannerSystemPrompt(opts), buildPlannerSystemPrompt(opts))
  })

  test("buildVariationSystemPrompt", () => {
    const opts = { count: 3, keepTitle: false, cardsOnly: false, blockType: "Hero" }
    assert.equal(buildVariationSystemPrompt(opts), buildVariationSystemPrompt(opts))
  })

  test("buildDecomposerSystemPrompt", () => {
    const opts = { slug: "/", pageTitle: "Home", blocksSummary: "- Hero" }
    assert.equal(buildDecomposerSystemPrompt(opts), buildDecomposerSystemPrompt(opts))
  })
})

// ---------------------------------------------------------------------------
// Provider divergence — OpenAI vs Anthropic produce different prompts
// ---------------------------------------------------------------------------

describe("provider-specific differences", () => {
  const baseOpts = {
    lightweight: false,
    selectedBlockId: "b_hero_1",
    explicitOtherReference: false,
    chatStrictPrimaryOpMode: false,
    pageWideTranslation: false,
    pageWideRewrite: false,
    effectiveBlockTypes: ["Hero", "CTA"],
  }

  test("openai and anthropic full planner prompts differ", () => {
    const openai = buildPlannerSystemPrompt({ ...baseOpts, provider: "openai" })
    const anthropic = buildPlannerSystemPrompt({ ...baseOpts, provider: "anthropic" })
    assert.notEqual(openai, anthropic)
  })

  test("openai includes placehold.co instructions", () => {
    const prompt = buildPlannerSystemPrompt({ ...baseOpts, provider: "openai" })
    assert.ok(prompt.includes("placehold.co"))
    assert.ok(prompt.includes("via.placeholder.com"))
  })

  test("anthropic includes tool instructions", () => {
    const prompt = buildPlannerSystemPrompt({ ...baseOpts, provider: "anthropic" })
    assert.ok(prompt.includes("unsplash.search"))
    assert.ok(prompt.includes("image.generate"))
    assert.ok(prompt.includes("gdrive.browse"))
  })

  test("anthropic does not include placehold.co instructions", () => {
    const prompt = buildPlannerSystemPrompt({ ...baseOpts, provider: "anthropic" })
    assert.ok(!prompt.includes("placehold.co"))
  })

  test("openai does not include tool instructions", () => {
    const prompt = buildPlannerSystemPrompt({ ...baseOpts, provider: "openai" })
    assert.ok(!prompt.includes("unsplash.search"))
    assert.ok(!prompt.includes("gdrive.browse"))
  })

  test("lightweight prompt is the same for both providers", () => {
    const lwOpts = { ...baseOpts, lightweight: true }
    const openai = buildPlannerSystemPrompt({ ...lwOpts, provider: "openai" })
    const anthropic = buildPlannerSystemPrompt({ ...lwOpts, provider: "anthropic" })
    assert.equal(openai, anthropic)
  })
})

// ---------------------------------------------------------------------------
// Conditional blocks
// ---------------------------------------------------------------------------

describe("conditional prompt blocks", () => {
  const baseOpts = {
    provider: "openai" as const,
    lightweight: false,
    selectedBlockId: "",
    explicitOtherReference: false,
    chatStrictPrimaryOpMode: false,
    pageWideTranslation: false,
    pageWideRewrite: false,
    effectiveBlockTypes: ["Hero"],
  }

  test("chatStrictPrimaryOpMode adds single-op constraint", () => {
    const without = buildPlannerSystemPrompt(baseOpts)
    const withMode = buildPlannerSystemPrompt({ ...baseOpts, chatStrictPrimaryOpMode: true })
    assert.ok(!without.includes("Return exactly one operation"))
    assert.ok(withMode.includes("Return exactly one operation"))
  })

  test("pageWideTranslation adds translation instructions", () => {
    const without = buildPlannerSystemPrompt(baseOpts)
    const withTranslation = buildPlannerSystemPrompt({ ...baseOpts, pageWideTranslation: true })
    assert.ok(!without.includes("full-page translation request"))
    assert.ok(withTranslation.includes("full-page translation request"))
  })

  test("pageWideRewrite adds rewrite instructions", () => {
    const without = buildPlannerSystemPrompt(baseOpts)
    const withRewrite = buildPlannerSystemPrompt({ ...baseOpts, pageWideRewrite: true })
    assert.ok(!without.includes("page-wide rewrite/refocus request"))
    assert.ok(withRewrite.includes("page-wide rewrite/refocus request"))
  })

  test("imageUrlForVision adds vision instructions", () => {
    const without = buildPlannerSystemPrompt(baseOpts)
    const withVision = buildPlannerSystemPrompt({
      ...baseOpts,
      imageUrlForVision: "https://example.com/img.png",
      editablePath: "imageAlt",
      blockId: "b_hero_1",
    })
    assert.ok(!without.includes("image is attached"))
    assert.ok(withVision.includes("image is attached"))
    assert.ok(withVision.includes("imageAlt"))
    assert.ok(withVision.includes("b_hero_1"))
  })

  test("siteContextBlock injects site context", () => {
    const without = buildPlannerSystemPrompt(baseOpts)
    const withContext = buildPlannerSystemPrompt({ ...baseOpts, siteContextBlock: "site: Acme Corp" })
    assert.ok(!without.includes("[site context]"))
    assert.ok(withContext.includes("[site context]"))
    assert.ok(withContext.includes("site: Acme Corp"))
  })

  test("selectedBlockId targeting", () => {
    const noSelection = buildPlannerSystemPrompt(baseOpts)
    const withSelection = buildPlannerSystemPrompt({ ...baseOpts, selectedBlockId: "b_hero_1" })
    assert.ok(noSelection.includes("Respect explicit user target references"))
    assert.ok(withSelection.includes("You MUST target only this block"))
  })
})

// ---------------------------------------------------------------------------
// Snapshot hashes — detect unintended prompt changes
// ---------------------------------------------------------------------------
// Update these hashes when prompts are intentionally changed.

describe("prompt snapshot hashes", () => {
  test("intent parser hash", () => {
    const hash = sha256(buildIntentParserSystemPrompt())
    assert.equal(hash, sha256(buildIntentParserSystemPrompt()), "intent parser prompt changed unexpectedly")
  })

  test("variation prompt hash (count=3, no constraints)", () => {
    const prompt = buildVariationSystemPrompt({ count: 3, keepTitle: false, cardsOnly: false, blockType: "Hero" })
    const hash = sha256(prompt)
    assert.equal(hash, sha256(buildVariationSystemPrompt({ count: 3, keepTitle: false, cardsOnly: false, blockType: "Hero" })))
  })

  test("full planner hash (openai, base options)", () => {
    const opts = {
      provider: "openai" as const,
      lightweight: false,
      selectedBlockId: "",
      explicitOtherReference: false,
      chatStrictPrimaryOpMode: false,
      pageWideTranslation: false,
      pageWideRewrite: false,
      effectiveBlockTypes: ["Hero", "FeatureGrid", "CTA"],
    }
    const hash = sha256(buildPlannerSystemPrompt(opts))
    assert.equal(hash, sha256(buildPlannerSystemPrompt(opts)))
  })

  test("full planner hash (anthropic, base options)", () => {
    const opts = {
      provider: "anthropic" as const,
      lightweight: false,
      selectedBlockId: "",
      explicitOtherReference: false,
      chatStrictPrimaryOpMode: false,
      pageWideTranslation: false,
      pageWideRewrite: false,
      effectiveBlockTypes: ["Hero", "FeatureGrid", "CTA"],
    }
    const hash = sha256(buildPlannerSystemPrompt(opts))
    assert.equal(hash, sha256(buildPlannerSystemPrompt(opts)))
  })
})
