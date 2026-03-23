import test from "node:test"
import assert from "node:assert/strict"
import { allowedBlockTypes, defaultPropsForType, demoPublishedPages, editPlanSchema, validateBlockProps } from "@ai-site-editor/shared"
import { app, buildCreatePagePlan, compileDeterministicPlan, normalizePlanCandidate } from "./index.js"
import { isLikelyClarificationFollowUp, parseCreatePageRequest, parseDuplicatePageRequest, requestsContentGeneration } from "./nlp/intent-helpers.js"
import { isBatchAddRequest, isBatchRemoveRequest, isBatchReorderRequest, isPageWideRewriteRequest, extractMentionedBlockTypes, isAdviceQuery, isPageListQuery, isInfoQuery } from "./nlp/intent-detection.js"
import { extractAudienceTarget, extractAudienceTargets, inferAddedBlockTypeFromMessage, inferDeterministicIntent, isHighConfidenceDeterministicCase, childSuggestions, clarificationSuggestions, postEditSuggestions, humanizeArrayPath, tryCompoundDeterministicPlan } from "./nlp/deterministic-planner.js"
import { inferBlockTypeFromText, defaultPropsForType as plannerDefaultProps } from "./nlp/plan-normalizer.js"
import { blockSupportsImageAtPath, findFullPageTranslationCoverageGap, inferTranslationScopeFromMessage, sanitizeMessageForPlanning, shouldPreferFastModelForMessage, isRewriteLikeMessage } from "./chat/chat-pipeline.js"

function demoPageBySlug(slug: string) {
  const page = demoPublishedPages().find((item) => item.slug === slug)
  assert.ok(page, `demo page ${slug} should exist`)
  return page!
}

function buildPageWithTwoColumnImage() {
  const page = demoPublishedPages()[0]
  return {
    ...page,
    blocks: [
      ...page.blocks,
      {
        id: "b_two_col_test",
        type: "TwoColumn" as const,
        props: {
          variant: "default",
          left: [
            { type: "heading", text: "Trail" },
            { type: "paragraph", text: "Body" }
          ],
          right: [
            { type: "image", src: "/hero-generated.svg", alt: "A climber" }
          ]
        }
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Prompt intent understanding matrix (table-driven)
// ---------------------------------------------------------------------------

type IntentMatrixCase = {
  name: string
  message: string
  currentPage: ReturnType<typeof demoPublishedPages>[number]
  activeBlockId?: string
  activeEditablePath?: string
  expectedNull?: boolean
  expectedAction?: "add" | "move" | "update" | "remove" | "info" | "clarify"
  expectedTargetBlockRef?: string
  expectedTargetBlockType?: string
  expectedPatch?: Record<string, unknown>
}

test("inferDeterministicIntent understanding matrix", () => {
  const home = demoPageBySlug("/")
  const heroId = home.blocks.find((item) => item.type === "Hero")?.id
  assert.ok(heroId, "home should include hero block")
  const pageWithTwoColumn = buildPageWithTwoColumnImage()

  const cases: IntentMatrixCase[] = [
    {
      name: "selected remove maps to target block",
      message: "remove this section",
      currentPage: home,
      activeBlockId: heroId,
      expectedAction: "remove",
      expectedTargetBlockRef: heroId
    },
    {
      name: "quoted field rewrite maps to update patch",
      message: "change heading to \"Build your dream site\"",
      currentPage: home,
      activeBlockId: heroId,
      activeEditablePath: "heading",
      expectedAction: "update",
      expectedTargetBlockRef: heroId,
      expectedPatch: { heading: "Build your dream site" }
    },
    {
      name: "remove-all-except infers kept block type",
      message: "remove all blocks except hero",
      currentPage: home,
      expectedAction: "remove",
      expectedTargetBlockType: "Hero"
    },
    {
      name: "hero layout phrase maps to imagePosition patch",
      message: "set hero image on the left",
      currentPage: home,
      expectedAction: "update",
      expectedTargetBlockRef: heroId,
      expectedPatch: { imagePosition: "left" }
    },
    {
      name: "focused image command maps to update action",
      message: "add unsplash image matching image alt text",
      currentPage: pageWithTwoColumn,
      activeBlockId: "b_two_col_test",
      activeEditablePath: "imageUrl",
      expectedAction: "update",
      expectedTargetBlockRef: "b_two_col_test"
    },
    {
      name: "container-scoped remove-except is rejected deterministically",
      message: "remove CTAs from all slides except last one in Carousel",
      currentPage: home,
      activeBlockId: home.blocks[0]?.id,
      expectedNull: true
    }
  ]

  for (const entry of cases) {
    const parsed = inferDeterministicIntent({
      message: entry.message,
      currentPage: entry.currentPage,
      activeBlockId: entry.activeBlockId,
      activeEditablePath: entry.activeEditablePath
    })

    if (entry.expectedNull) {
      assert.equal(parsed, null, entry.name)
      continue
    }

    assert.ok(parsed, `${entry.name}: expected deterministic intent`)
    assert.equal(parsed?.action, entry.expectedAction, entry.name)
    if (entry.expectedTargetBlockRef !== undefined) {
      assert.equal(parsed?.target_block_ref, entry.expectedTargetBlockRef, entry.name)
    }
    if (entry.expectedTargetBlockType !== undefined) {
      assert.equal(parsed?.target_block_type, entry.expectedTargetBlockType, entry.name)
    }
    if (entry.expectedPatch !== undefined) {
      assert.deepEqual(parsed?.patch, entry.expectedPatch, entry.name)
    }
  }
})

type PromptIntentPlanMatrixCase = {
  name: string
  message: string
  slug: string
  currentPage: ReturnType<typeof demoPublishedPages>[number]
  activeBlockId?: string
  activeEditablePath?: string
  expectedAction: "add" | "move" | "update" | "remove" | "info" | "clarify"
  expectedPlanIntent: "edit_plan" | "needs_clarification"
  expectedFirstOp?: string
}

test("prompt intent understanding matrix (infer -> deterministic compile)", () => {
  const home = demoPageBySlug("/")
  const pricing = demoPageBySlug("/pricing")
  const heroId = home.blocks.find((item) => item.type === "Hero")?.id
  assert.ok(heroId, "home should include hero block")

  const cases: PromptIntentPlanMatrixCase[] = [
    {
      name: "create page prompt becomes create_page op",
      message: "create new page /intent-matrix",
      slug: "/",
      currentPage: home,
      expectedAction: "add",
      expectedPlanIntent: "edit_plan",
      expectedFirstOp: "create_page"
    },
    {
      name: "this-page add richtext stays block-level",
      message: "on this page add a richtext describing benefits of grapefruits",
      slug: "/",
      currentPage: home,
      expectedAction: "add",
      expectedPlanIntent: "edit_plan",
      expectedFirstOp: "add_block"
    },
    {
      name: "remove this page maps to remove_page",
      message: "remove this page",
      slug: "/pricing",
      currentPage: pricing,
      expectedAction: "remove",
      expectedPlanIntent: "edit_plan",
      expectedFirstOp: "remove_page"
    },
    {
      name: "rename page route maps to rename_page",
      message: "rename page /pricing to /plans",
      slug: "/pricing",
      currentPage: pricing,
      expectedAction: "update",
      expectedPlanIntent: "edit_plan",
      expectedFirstOp: "rename_page"
    },
    {
      name: "nav move phrase maps to move_page",
      message: "move this page before Home",
      slug: "/pricing",
      currentPage: pricing,
      expectedAction: "move",
      expectedPlanIntent: "edit_plan",
      expectedFirstOp: "move_page"
    },
    {
      name: "selected-field rewrite maps to update_props",
      message: "change heading to \"Build your dream site\"",
      slug: "/",
      currentPage: home,
      activeBlockId: heroId,
      activeEditablePath: "heading",
      expectedAction: "update",
      expectedPlanIntent: "edit_plan",
      expectedFirstOp: "update_props"
    },
    {
      name: "home-page delete is blocked with clarification",
      message: "delete page /",
      slug: "/",
      currentPage: home,
      expectedAction: "remove",
      expectedPlanIntent: "needs_clarification"
    }
  ]

  for (const [index, entry] of cases.entries()) {
    const parsed = inferDeterministicIntent({
      message: entry.message,
      currentPage: entry.currentPage,
      activeBlockId: entry.activeBlockId,
      activeEditablePath: entry.activeEditablePath
    })
    assert.ok(parsed, `${entry.name}: expected deterministic intent`)
    assert.equal(parsed?.action, entry.expectedAction, entry.name)

    const plan = compileDeterministicPlan({
      session: `intent-matrix-${index}`,
      intent: parsed!,
      message: entry.message,
      slug: entry.slug,
      currentPage: entry.currentPage,
      activeBlockId: entry.activeBlockId,
      activeEditablePath: entry.activeEditablePath
    })

    assert.ok(plan, `${entry.name}: expected deterministic plan`)
    assert.equal(plan?.intent, entry.expectedPlanIntent, entry.name)
    if (entry.expectedFirstOp !== undefined) {
      assert.equal(plan?.ops[0]?.op, entry.expectedFirstOp, entry.name)
    }
  }
})

test("blockSupportsImageAtPath checks schema support", () => {
  // Hero has top-level imageUrl
  assert.equal(blockSupportsImageAtPath("Hero", "imageUrl"), true)
  // FeatureGrid features do NOT have imageUrl
  assert.equal(blockSupportsImageAtPath("FeatureGrid", "features[0].imageUrl"), false)
  // CardGrid items DO have imageUrl
  assert.equal(blockSupportsImageAtPath("CardGrid", "cards[0].imageUrl"), true)
  // Unknown block → optimistic
  assert.equal(blockSupportsImageAtPath("UnknownBlock", "imageUrl"), true)
})

test("Hero schema supports imagePosition and defaults to right", () => {
  const heroDefaults = defaultPropsForType("Hero")
  assert.equal(heroDefaults.imagePosition, "right")

  const parsedWithoutPosition = validateBlockProps("Hero", {
    heading: "H",
    subheading: "S",
    ctaText: "Go",
    ctaHref: "/",
    imageUrl: "/hero-generated.svg",
    imageAlt: "Alt"
  })
  assert.equal(parsedWithoutPosition.success, true)
  if (parsedWithoutPosition.success) {
    assert.equal(parsedWithoutPosition.data.imagePosition, "right")
  }

  const parsedLeft = validateBlockProps("Hero", {
    heading: "H",
    subheading: "S",
    ctaText: "Go",
    ctaHref: "/",
    imageUrl: "/hero-generated.svg",
    imageAlt: "Alt",
    imagePosition: "left"
  })
  assert.equal(parsedLeft.success, true)
  if (parsedLeft.success) {
    assert.equal(parsedLeft.data.imagePosition, "left")
  }
})

test("parseCreatePageRequest prompt matrix", () => {
  const cases: Array<{ prompt: string; expected: string | null }> = [
    { prompt: "create new page /test2", expected: "/test2" },
    { prompt: "generate a new page /about-us", expected: "/about-us" },
    { prompt: "add new page about cherries", expected: "/cherries" },
    { prompt: "add a new landing page about winter jam competition", expected: "/winter-jam-competition" },
    { prompt: "create page for startup founders", expected: "/for-startup-founders" },
    { prompt: "add a page for pomegranates", expected: "/for-pomegranates" },
    { prompt: "Create a new page about avocado recipes with a Hero section, a feature highlights grid", expected: "/avocado-recipes" },
    { prompt: "create page about cooking tips including hero and FAQ", expected: "/cooking-tips" },
    { prompt: "Create a new About Us page", expected: "/about-us" },
    { prompt: "Add a Contact page", expected: "/contact" },
    { prompt: "create new About Us page", expected: "/about-us" },
    { prompt: "create a Services page", expected: "/services" },
    { prompt: "add page called Our Team", expected: "/our-team" },
    { prompt: "create page named Reviews", expected: "/reviews" },
    { prompt: 'create a new page "Test"', expected: "/test" },
    { prompt: "create a new page \"About Us\"", expected: "/about-us" },
    { prompt: "add page 'Our Services'", expected: "/our-services" },
    { prompt: "add a CTA corresponding to intent of this page", expected: null },
    { prompt: "improve this page", expected: null },
    { prompt: "delete this page", expected: null },
    { prompt: "rename this page to /banana", expected: null },
    {
      prompt:
        "generate some more content on this page\n\n[site context]\nHosting context: Vercel production site (single shared project)\n[/site context]",
      expected: null
    }
  ]

  for (const entry of cases) {
    assert.equal(parseCreatePageRequest(entry.prompt), entry.expected, entry.prompt)
  }
})

test("sanitizeMessageForPlanning extracts prompt from debug payload", () => {
  const message = [
    "translate this page to German",
    "Renamed the Hero secondary CTA.",
    "Performance awareness",
    "This wording improves semantic relevance and supports SEO, accessibility, and conversion checks.",
    "Debug",
    "traceId: abc",
    "promptHash: hash",
    "outcome: applied",
    "intent: edit_plan",
    "opCount: 1",
    "ops: update_props",
    "prompt: translate this page to German [site context] Site purpose: Adventure Arena"
  ].join("\n")

  assert.equal(
    sanitizeMessageForPlanning(message),
    "translate this page to German [site context] Site purpose: Adventure Arena"
  )
})

test("sanitizeMessageForPlanning normalizes smart quotes and common typos", () => {
  assert.equal(
    sanitizeMessageForPlanning("ad a fetures section and change hero heding to “Ship faster”"),
    "add a features section and change hero heading to \"Ship faster\""
  )
  assert.equal(
    sanitizeMessageForPlanning("remove the testomonials section"),
    "remove the testimonials section"
  )
})

test("inferTranslationScopeFromMessage distinguishes page and component scope", () => {
  assert.equal(inferTranslationScopeFromMessage("translate this page to german"), "page")
  assert.equal(inferTranslationScopeFromMessage("translate to german"), "page")
  assert.equal(inferTranslationScopeFromMessage("translate this selected component to german"), "component")
  assert.equal(inferTranslationScopeFromMessage("change hero heading"), "none")
})

test("findFullPageTranslationCoverageGap flags missing CardGrid child fields", () => {
  const page = {
    id: "p_test",
    slug: "/test",
    title: "Test",
    updatedAt: new Date().toISOString(),
    blocks: [
      {
        id: "b_cards",
        type: "CardGrid" as const,
        props: {
          title: "Cards",
          cards: [
            { title: "A", description: "Desc A", ctaText: "Learn", ctaHref: "/" },
            { title: "B", description: "Desc B", ctaText: "Learn", ctaHref: "/" }
          ]
        }
      }
    ]
  }
  const gap = findFullPageTranslationCoverageGap({
    plan: {
      intent: "edit_plan",
      summary_for_user: "Translate page",
      change_log: [],
      ops: [
        { op: "update_item", pageSlug: "/test", blockId: "b_cards", listKey: "cards", index: 0, patch: { title: "Titel A" } },
        { op: "update_item", pageSlug: "/test", blockId: "b_cards", listKey: "cards", index: 1, patch: { title: "Titel B" } }
      ]
    },
    message: "translate whole page to dutch",
    currentPage: page,
    slug: "/test"
  })
  assert.ok(gap)
  assert.match(String(gap), /cards\[0\]\.description/i)
  assert.match(String(gap), /cards\[0\]\.ctaText/i)
})

test("findFullPageTranslationCoverageGap flags missing child fields for non-CardGrid list blocks", () => {
  const page = {
    id: "p_test",
    slug: "/test",
    title: "Test",
    updatedAt: new Date().toISOString(),
    blocks: [
      {
        id: "b_features",
        type: "FeatureGrid" as const,
        props: {
          title: "Features",
          features: [
            { title: "Speed", description: "Fast setup" },
            { title: "Safety", description: "Secure changes" }
          ]
        }
      }
    ]
  }
  const gap = findFullPageTranslationCoverageGap({
    plan: {
      intent: "edit_plan",
      summary_for_user: "Translate page",
      change_log: [],
      ops: [{ op: "update_item", pageSlug: "/test", blockId: "b_features", listKey: "features", index: 0, patch: { title: "Snelheid" } }]
    },
    message: "translate whole page to dutch",
    currentPage: page,
    slug: "/test"
  })
  assert.ok(gap)
  assert.match(String(gap), /features\[0\]\.description/i)
})

test("findFullPageTranslationCoverageGap passes when list child text coverage is complete", () => {
  const page = {
    id: "p_test",
    slug: "/test",
    title: "Test",
    updatedAt: new Date().toISOString(),
    blocks: [
      {
        id: "b_features",
        type: "FeatureGrid" as const,
        props: {
          title: "Features",
          features: [
            { title: "Speed", description: "Fast setup" },
            { title: "Safety", description: "Secure changes" }
          ]
        }
      }
    ]
  }
  const gap = findFullPageTranslationCoverageGap({
    plan: {
      intent: "edit_plan",
      summary_for_user: "Translate page",
      change_log: [],
      ops: [
        { op: "update_item", pageSlug: "/test", blockId: "b_features", listKey: "features", index: 0, patch: { title: "Snelheid", description: "Snelle opzet" } },
        { op: "update_item", pageSlug: "/test", blockId: "b_features", listKey: "features", index: 1, patch: { title: "Veiligheid", description: "Veilige wijzigingen" } }
      ]
    },
    message: "translate whole page to dutch",
    currentPage: page,
    slug: "/test"
  })
  assert.equal(gap, null)
})

test("inferDeterministicIntent infers remove action against selected block", () => {
  const currentPage = demoPublishedPages()[0]
  const parsed = inferDeterministicIntent({
    message: "remove this section",
    currentPage,
    activeBlockId: "b_hero_home"
  })

  assert.ok(parsed)
  assert.equal(parsed?.action, "remove")
  assert.equal(parsed?.target_block_ref, "b_hero_home")
})

test("isHighConfidenceDeterministicCase returns true for 'create a new test page'", () => {
  const currentPage = demoPublishedPages()[0]
  assert.equal(
    isHighConfidenceDeterministicCase({ message: "create a new test page", currentPage }),
    true
  )
})

test("isHighConfidenceDeterministicCase returns true for 'create a new /about page'", () => {
  const currentPage = demoPublishedPages()[0]
  assert.equal(
    isHighConfidenceDeterministicCase({ message: "create a new /about page", currentPage }),
    true
  )
})

test("isHighConfidenceDeterministicCase returns true for 'remove all blocks except hero'", () => {
  const currentPage = demoPublishedPages()[0]
  assert.equal(
    isHighConfidenceDeterministicCase({ message: "remove all blocks except hero", currentPage }),
    true
  )
})

test("isHighConfidenceDeterministicCase returns true for 'delete everything but the CTA'", () => {
  const currentPage = demoPublishedPages()[0]
  assert.equal(
    isHighConfidenceDeterministicCase({ message: "delete everything but the CTA", currentPage }),
    true
  )
})

test("inferDeterministicIntent returns remove intent with kept type for 'remove all blocks except hero'", () => {
  const currentPage = demoPublishedPages()[0]
  const parsed = inferDeterministicIntent({
    message: "remove all blocks except hero",
    currentPage
  })
  assert.ok(parsed)
  assert.equal(parsed.action, "remove")
  assert.equal(parsed.target_block_type, "Hero")
})

test("inferDeterministicIntent returns null for container-scoped remove-except", () => {
  const currentPage = demoPublishedPages()[0]
  const result = inferDeterministicIntent({
    message: "remove CTAs from all slides except last one in Carousel",
    currentPage,
    activeBlockId: currentPage.blocks[0].id
  })
  assert.equal(result, null)
})

test("isHighConfidenceDeterministicCase returns false for container-scoped remove-except", () => {
  const currentPage = demoPublishedPages()[0]
  assert.equal(
    isHighConfidenceDeterministicCase({ message: "remove CTAs from all slides except last one in Carousel", currentPage }),
    false
  )
})

test("inferDeterministicIntent still handles page-level remove-all-except after container guard", () => {
  const currentPage = demoPublishedPages()[0]
  const parsed = inferDeterministicIntent({
    message: "delete everything except Hero",
    currentPage
  })
  assert.ok(parsed)
  assert.equal(parsed.action, "remove")
  assert.equal(parsed.target_block_type, "Hero")
})

test("inferDeterministicIntent infers quoted patch for selected editable field", () => {
  const currentPage = demoPublishedPages()[0]
  const parsed = inferDeterministicIntent({
    message: "change heading to \"Build your dream site\"",
    currentPage,
    activeBlockId: "b_hero_home",
    activeEditablePath: "heading"
  })

  assert.ok(parsed)
  assert.equal(parsed?.action, "update")
  assert.equal(parsed?.target_block_ref, "b_hero_home")
  assert.deepEqual(parsed?.patch, { heading: "Build your dream site" })
})

test("inferDeterministicIntent treats add-image command as update in focused image field", () => {
  const page = demoPublishedPages()[0]
  const currentPage = {
    ...page,
    blocks: [
      ...page.blocks,
      {
        id: "b_two_col_test",
        type: "TwoColumn",
        props: {
          variant: "default",
          left: [
            { type: "heading", text: "Trail" },
            { type: "paragraph", text: "Body" }
          ],
          right: [
            { type: "image", src: "/hero-generated.svg", alt: "A climber" }
          ]
        }
      }
    ]
  }
  const parsed = inferDeterministicIntent({
    message: "add unsplash image matching image alt text",
    currentPage,
    activeBlockId: "b_two_col_test",
    activeEditablePath: "imageUrl"
  })

  assert.ok(parsed)
  assert.equal(parsed?.action, "update")
  assert.equal(parsed?.target_block_ref, "b_two_col_test")
})

test("parseCreatePageRequest still returns slug for content-generation requests (AI planner handles the bypass)", () => {
  // The slug IS detected — the bypass happens in deterministicCreatePagePlan, not here
  assert.equal(
    parseCreatePageRequest("create a new page /about-us and add some nice content"),
    "/about-us"
  )
})

test("requestsContentGeneration detects content-generation requests", () => {
  const positives = [
    "create a new page /about-us and add some nice content",
    "create page /team and fill it with content",
    "make a page /services and write about our offerings",
    "generate page /faq with content",
    "build new page /about and describe our mission for visitors"
  ]
  const negatives = [
    "create new page /test2",
    "create a new page /intent with hero, text and cta",
    "create page /about with a hero and cta",
    "add new page about cherries",
    "create landing page for startup founders"
  ]
  // Topic + enumerated block types → content generation (defer to LLM)
  const topicWithBlocks = [
    "Create a new page about avocado recipes with a Hero section, a feature highlights grid, a card grid, an FAQ section, and a CTA",
    "create page about cooking tips with hero, card, faq and cta sections",
  ]
  for (const prompt of positives) assert.equal(requestsContentGeneration(prompt), true, prompt)
  for (const prompt of topicWithBlocks) assert.equal(requestsContentGeneration(prompt), true, prompt)
  for (const prompt of negatives) assert.equal(requestsContentGeneration(prompt), false, prompt)
})

test("isLikelyClarificationFollowUp prompt matrix", () => {
  const positives = [
    "the selected one", "same", "this one", "the first", "it",
    "I mean all pages in the site nav menu",
    "I meant the pricing page",
    "no, I want all of them",
    "sorry, the home page",
    "what I mean is the whole site",
    "not that, the other one",
    "I was talking about the footer",
    // Confirmation / go-ahead patterns
    "Show me all 3 so I can choose",
    "yes please",
    "yes, show me",
    "yeah do that",
    "sure",
    "go ahead",
    "do it",
    "let's see",
    "let's go",
    "show me",
    "sounds good",
    "ok",
    "okay let's do it"
  ]
  const negatives = ["create new page /test2", "remove page /pricing", "add faq section", "change heading to hello world"]
  for (const prompt of positives) assert.equal(isLikelyClarificationFollowUp(prompt), true, prompt)
  for (const prompt of negatives) assert.equal(isLikelyClarificationFollowUp(prompt), false, prompt)
})

test("isAdviceQuery excludes structural page reorder requests", () => {
  const positives = ["should we add FAQ?", "is this good?", "what do you think", "improvements"]
  const negatives = [
    "how should we reorder pages of this website in the top nav menu?",
    "should we reorganize the pages?",
    "should I rearrange pages for better discoverability?",
    "should we move pages around?"
  ]
  for (const prompt of positives) assert.equal(isAdviceQuery(prompt), true, prompt)
  for (const prompt of negatives) assert.equal(isAdviceQuery(prompt), false, prompt)
})


test("normalizePlanCandidate maps list op path to listKey and keeps pageSlug", () => {
  const parsed = normalizePlanCandidate(
    {
      intent: "edit_plan",
      summary_for_user: "Add one FAQ item.",
      change_log: [],
      ops: [
        {
          op: "add_item",
          path: "items",
          blockId: "b_faq_1",
          item: { q: "Q", a: "A" },
          pageSlug: "/items"
        }
      ]
    },
    {
      defaultSlug: "/",
      currentPage: demoPublishedPages()[0],
      userMessage: "add one more faq question"
    }
  ) as { ops: Array<Record<string, unknown>> }

  assert.equal(parsed.ops.length, 1)
  assert.equal(parsed.ops[0].op, "add_item")
  assert.equal(parsed.ops[0].listKey, "items")
  assert.equal(parsed.ops[0].pageSlug, "/")
})

test("normalizePlanCandidate maps list op aliases path->listKey for all list operations", () => {
  const parsed = normalizePlanCandidate(
    {
      intent: "edit_plan",
      summary_for_user: "List edits",
      change_log: [],
      ops: [
        { op: "add_item", path: "items", blockId: "b_faq_1", item: { q: "Q1", a: "A1" } },
        { op: "update_item", path: "items", blockId: "b_faq_1", index: 0, patch: { q: "Q2" } },
        { op: "remove_item", path: "items", blockId: "b_faq_1", index: 1 },
        { op: "move_item", path: "items", blockId: "b_faq_1", index: 2, afterIndex: 0 }
      ]
    },
    {
      defaultSlug: "/",
      currentPage: demoPublishedPages()[0],
      userMessage: "update faq items"
    }
  )

  const result = editPlanSchema.safeParse(parsed)
  assert.equal(result.success, true)
  if (!result.success) return
  for (const op of result.data.ops) {
    if ("listKey" in op) assert.equal(op.listKey, "items")
  }
})

test("normalizePlanCandidate parses itemPath for update_item listKey/index", () => {
  const parsed = normalizePlanCandidate(
    {
      intent: "edit_plan",
      summary_for_user: "Update FAQ item",
      change_log: [],
      ops: [
        {
          op: "update_item",
          blockId: "b_faq_1",
          itemPath: "items[2]",
          patch: { q: "How should I store lemons to keep them fresh?" }
        }
      ]
    },
    {
      defaultSlug: "/",
      currentPage: demoPublishedPages()[0],
      userMessage: "update third faq question"
    }
  )

  const result = editPlanSchema.safeParse(parsed)
  assert.equal(result.success, true)
  if (!result.success) return
  const op = result.data.ops[0]
  assert.equal(op.op, "update_item")
  if (op.op === "update_item") {
    assert.equal(op.listKey, "items")
    assert.equal(op.index, 2)
  }
})

test("normalizePlanCandidate maps arrayProp alias to listKey", () => {
  const parsed = normalizePlanCandidate(
    {
      intent: "edit_plan",
      summary_for_user: "Update FAQ item",
      change_log: [],
      ops: [
        {
          op: "update_item",
          blockId: "b_faq_1",
          arrayProp: "items",
          index: 2,
          patch: { a: "Store lemons in the fridge." }
        }
      ]
    },
    {
      defaultSlug: "/",
      currentPage: demoPublishedPages()[0],
      userMessage: "update third faq answer"
    }
  )

  const result = editPlanSchema.safeParse(parsed)
  assert.equal(result.success, true)
  if (!result.success) return
  const op = result.data.ops[0]
  assert.equal(op.op, "update_item")
  if (op.op === "update_item") {
    assert.equal(op.listKey, "items")
    assert.equal(op.index, 2)
  }
})

test("normalizePlanCandidate remaps question/answer to q/a in add_block FAQ items", () => {
  const parsed = normalizePlanCandidate(
    {
      intent: "edit_plan",
      summary_for_user: "Add FAQ",
      change_log: [],
      ops: [
        {
          op: "add_block",
          pageSlug: "/",
          block: {
            id: "b_faqaccordion_1",
            type: "FAQAccordion",
            props: {
              title: "Lemon Storage FAQ",
              items: [
                { question: "How to store lemons?", answer: "In the fridge." },
                { question: "How long do they last?", answer: "2-3 weeks refrigerated." }
              ]
            }
          }
        }
      ]
    },
    { defaultSlug: "/", currentPage: demoPublishedPages()[0], userMessage: "add faq" }
  )
  const result = editPlanSchema.safeParse(parsed)
  assert.equal(result.success, true, `schema validation failed: ${JSON.stringify(result.error?.issues)}`)
  if (!result.success) return
  const op = result.data.ops[0]
  assert.equal(op.op, "add_block")
  if (op.op === "add_block") {
    const items = (op.block.props as Record<string, unknown>).items as Array<Record<string, unknown>>
    assert.equal(items.length, 2)
    assert.equal(items[0].q, "How to store lemons?")
    assert.equal(items[0].a, "In the fridge.")
    assert.equal(items[0].question, undefined, "question key should be remapped to q")
  }
})

test("normalizePlanCandidate infers listKey from block props when LLM omits it", () => {
  const currentPage = demoPublishedPages()[0]
  const cardGrid = currentPage.blocks.find((b) => b.type === "CardGrid")!
  const parsed = normalizePlanCandidate(
    {
      intent: "edit_plan",
      summary_for_user: "Add images to each card",
      change_log: [],
      ops: [
        {
          op: "update_item",
          blockId: cardGrid.id,
          index: 0,
          patch: { imageUrl: "https://example.com/img.jpg", imageAlt: "avocado dish" }
        }
      ]
    },
    {
      defaultSlug: "/",
      currentPage,
      userMessage: "add images to each card"
    }
  )
  const result = editPlanSchema.safeParse(parsed)
  assert.equal(result.success, true, `schema validation failed: ${JSON.stringify(result.error?.issues)}`)
  if (!result.success) return
  const op = result.data.ops[0]
  assert.equal(op.op, "update_item")
  if (op.op === "update_item") {
    assert.equal(op.listKey, "cards")
    assert.equal(op.index, 0)
  }
})

test("normalizePlanCandidate remaps update_item label patch to card title", () => {
  const currentPage = {
    id: "p_test",
    slug: "/test",
    title: "Test",
    updatedAt: new Date().toISOString(),
    blocks: [
      {
        id: "b_cards_test",
        type: "CardGrid" as const,
        props: {
          title: "Cards",
          cards: [
            { title: "One", description: "Desc 1", ctaText: "Read", ctaHref: "/" },
            { title: "Two", description: "Desc 2", ctaText: "Read", ctaHref: "/" },
            { title: "Three", description: "Desc 3", ctaText: "Read", ctaHref: "/" }
          ]
        }
      }
    ]
  }

  const parsed = normalizePlanCandidate(
    {
      intent: "edit_plan",
      summary_for_user: "Translate card label",
      change_log: [],
      ops: [
        {
          op: "update_item",
          pageSlug: "/test",
          blockId: "b_cards_test",
          listKey: "cards",
          index: 2,
          patch: { label: "Beneficios para la salud de los limones" }
        }
      ]
    },
    {
      defaultSlug: "/test",
      currentPage,
      userMessage: "translate card 3 label to spanish"
    }
  )

  const result = editPlanSchema.safeParse(parsed)
  assert.equal(result.success, true)
  if (!result.success) return
  const op = result.data.ops[0]
  assert.equal(op.op, "update_item")
  if (op.op === "update_item") {
    assert.deepEqual(op.patch, { title: "Beneficios para la salud de los limones" })
  }
})

test("normalizePlanCandidate handles add_item with path '/items' and missing item payload", () => {
  const currentPage = demoPublishedPages().find((page) => page.slug === "/pricing")
  assert.ok(currentPage)
  const parsed = normalizePlanCandidate(
    {
      intent: "edit_plan",
      summary_for_user: "Add FAQ question",
      change_log: [],
      ops: [{ op: "add_item", path: "/items", blockId: "b_faq_pricing" }]
    },
    {
      defaultSlug: "/pricing",
      currentPage: currentPage!,
      userMessage: "add 1 more question"
    }
  )

  const result = editPlanSchema.safeParse(parsed)
  assert.equal(result.success, true)
  if (!result.success) return
  const op = result.data.ops[0]
  assert.equal(op.op, "add_item")
  if (op.op === "add_item") {
    assert.equal(op.listKey, "items")
    assert.equal(op.pageSlug, "/pricing")
    assert.equal(typeof op.item.q, "string")
    assert.equal(typeof op.item.a, "string")
  }
})

test("compileDeterministicPlan generates remove ops for all blocks except kept type", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = compileDeterministicPlan({
    session: "test-suite",
    intent: { action: "remove", target_block_type: "Hero", summary: "Removed all blocks except Hero." },
    message: "remove all components except hero",
    slug: "/",
    currentPage
  })
  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  const removeOps = plan!.ops.filter((op) => op.op === "remove_block")
  // Should remove every block that is NOT Hero
  const nonHeroBlocks = currentPage.blocks.filter((b) => b.type !== "Hero")
  assert.equal(removeOps.length, nonHeroBlocks.length)
  // Hero should NOT be in the removed set
  for (const op of removeOps) {
    if ("blockId" in op) {
      const block = currentPage.blocks.find((b) => b.id === op.blockId)
      assert.ok(block, `block ${op.blockId} should exist`)
      assert.notEqual(block!.type, "Hero", `should not remove Hero block`)
    }
  }
})

test("isHighConfidenceDeterministicCase handles 'remove all blocks except this one' with activeBlockId", () => {
  const currentPage = demoPublishedPages()[0]
  const heroBlock = currentPage.blocks.find((b) => b.type === "Hero")!
  assert.equal(
    isHighConfidenceDeterministicCase({ message: "remove all blocks except this one", currentPage, activeBlockId: heroBlock.id }),
    true
  )
})

test("isHighConfidenceDeterministicCase handles 'remove all but this' with activeBlockId", () => {
  const currentPage = demoPublishedPages()[0]
  const heroBlock = currentPage.blocks.find((b) => b.type === "Hero")!
  assert.equal(
    isHighConfidenceDeterministicCase({ message: "remove all but this", currentPage, activeBlockId: heroBlock.id }),
    true
  )
})

test("isHighConfidenceDeterministicCase handles 'remove this' with activeBlockId", () => {
  const currentPage = demoPublishedPages()[0]
  const heroBlock = currentPage.blocks.find((b) => b.type === "Hero")!
  assert.equal(
    isHighConfidenceDeterministicCase({ message: "remove this", currentPage, activeBlockId: heroBlock.id }),
    true
  )
  // Without activeBlockId, should return false
  assert.equal(
    isHighConfidenceDeterministicCase({ message: "remove this", currentPage }),
    false
  )
})

test("isHighConfidenceDeterministicCase returns true for page-level delete requests", () => {
  const currentPage = demoPublishedPages()[0]
  for (const msg of ["delete this page", "remove this page", "remove the current page", "delete the page"]) {
    assert.equal(
      isHighConfidenceDeterministicCase({ message: msg, currentPage }),
      true,
      `Expected true for "${msg}"`
    )
  }
})

test("isHighConfidenceDeterministicCase returns true for 'delete the hero from this page' (block-remove, not page-delete)", () => {
  const currentPage = demoPublishedPages()[0]
  assert.equal(
    isHighConfidenceDeterministicCase({ message: "delete the hero from this page", currentPage }),
    true,
    "Should match via block-remove path since 'hero' is a recognized block type"
  )
})

test("isHighConfidenceDeterministicCase returns false for 'add images to each card' (needs LLM)", () => {
  const currentPage = demoPublishedPages()[0]
  const cardGridBlock = currentPage.blocks.find((b) => b.type === "CardGrid")
  assert.equal(
    isHighConfidenceDeterministicCase({
      message: "add images to each card aligned with the text inside it",
      currentPage,
      activeBlockId: cardGridBlock?.id
    }),
    false
  )
})

test("isHighConfidenceDeterministicCase returns false for add with content directive (needs LLM)", () => {
  const currentPage = demoPublishedPages()[0]
  // "directing to recipes" is content direction — LLM should generate tailored props
  assert.equal(
    isHighConfidenceDeterministicCase({
      message: "Add a CTA block directing to recipes or wellness content",
      currentPage
    }),
    false
  )
  // "about our pricing" is content direction
  assert.equal(
    isHighConfidenceDeterministicCase({
      message: "add a FAQ section about our pricing",
      currentPage
    }),
    false
  )
  // "with 3 questions" specifies content items — needs LLM
  assert.equal(
    isHighConfidenceDeterministicCase({
      message: "add faq with 3 questions",
      currentPage
    }),
    false
  )
  // Plain "add a CTA" should still be deterministic
  assert.equal(
    isHighConfidenceDeterministicCase({
      message: "add a CTA",
      currentPage
    }),
    true
  )
  // "with rounded corners" is styling, not content — should stay deterministic
  assert.equal(
    isHighConfidenceDeterministicCase({
      message: "add a Hero with a blue background",
      currentPage
    }),
    true
  )
})

test("isHighConfidenceDeterministicCase returns false for rewrite constraints that quote banned words", () => {
  const currentPage = demoPublishedPages()[0]
  assert.equal(
    isHighConfidenceDeterministicCase({
      message: "Rewrite the hero so it sounds confident and modern. Keep heading under 8 words, avoid cliches like 'unlock' or 'journey', keep CTA intact.",
      currentPage
    }),
    false
  )
})

test("inferDeterministicIntent resolves 'remove all but this' to activeBlockId", () => {
  const currentPage = demoPublishedPages()[0]
  const heroBlock = currentPage.blocks.find((b) => b.type === "Hero")!
  const parsed = inferDeterministicIntent({
    message: "remove all but this",
    currentPage,
    activeBlockId: heroBlock.id
  })
  assert.ok(parsed)
  assert.equal(parsed?.action, "remove")
  assert.equal(parsed?.target_block_type, "Hero")
})

test("inferDeterministicIntent resolves 'this one' to activeBlockId for remove-all-except", () => {
  const currentPage = demoPublishedPages()[0]
  const heroBlock = currentPage.blocks.find((b) => b.type === "Hero")!
  const parsed = inferDeterministicIntent({
    message: "remove all blocks except this one",
    currentPage,
    activeBlockId: heroBlock.id
  })
  assert.ok(parsed)
  assert.equal(parsed?.action, "remove")
  assert.equal(parsed?.target_block_type, "Hero")
})

test("compileDeterministicPlan removes all except active block for 'this one' reference", () => {
  const currentPage = demoPublishedPages()[0]
  const heroBlock = currentPage.blocks.find((b) => b.type === "Hero")!
  const plan = compileDeterministicPlan({
    session: "test-suite",
    intent: { action: "remove", target_block_type: "Hero", summary: "Removed all blocks except Hero." },
    message: "remove all blocks except this one",
    slug: "/",
    currentPage
  })
  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  const removeOps = plan!.ops.filter((op) => op.op === "remove_block")
  const nonHeroBlocks = currentPage.blocks.filter((b) => b.type !== "Hero")
  assert.equal(removeOps.length, nonHeroBlocks.length)
})

test("compileDeterministicPlan creates page on create-page prompts", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = compileDeterministicPlan({
    session: "test-suite",
    intent: { action: "add" },
    message: "create new page /test-suite-page",
    slug: "/",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops[0]?.op, "create_page")
  if (plan?.ops[0] && "page" in plan.ops[0]) {
    const op = plan.ops[0] as { page: { slug: string } }
    assert.equal(op.page.slug, "/test-suite-page")
  }
})

// ---------------------------------------------------------------------------
// Prompt-to-page integration: verifies the full chain from natural-language
// prompt → parseCreatePageRequest → compileDeterministicPlan → page slug + title.
// These catch regressions where slug extraction fails and the user sees
// "/new-page" or "New Page" instead of the intended page name.
// ---------------------------------------------------------------------------
test("compileDeterministicPlan: create page with quoted name produces correct slug and title", () => {
  const currentPage = demoPublishedPages()[0]
  const cases = [
    { message: 'create a new page "Test"', expectedSlug: "/test", expectedTitle: "Test" },
    { message: 'create a new page "About Us"', expectedSlug: "/about-us", expectedTitle: "About Us" },
    { message: "add page 'Our Services'", expectedSlug: "/our-services", expectedTitle: "Our Services" },
  ]
  for (const { message, expectedSlug, expectedTitle } of cases) {
    const plan = compileDeterministicPlan({
      session: "test-suite",
      intent: { action: "add" },
      message,
      slug: "/",
      currentPage
    })
    assert.ok(plan, `no plan for: ${message}`)
    assert.equal(plan?.intent, "edit_plan", message)
    assert.equal(plan?.ops[0]?.op, "create_page", message)
    if (plan?.ops[0]?.op === "create_page") {
      assert.equal(plan.ops[0].page.slug, expectedSlug, `slug mismatch for: ${message}`)
      assert.equal(plan.ops[0].page.title, expectedTitle, `title mismatch for: ${message}`)
    }
  }
})

test("compileDeterministicPlan: create page with natural-language name (no route, no quotes)", () => {
  const currentPage = demoPublishedPages()[0]
  const cases = [
    { message: "Create a new About Us page", expectedSlug: "/about-us", expectedTitle: "About Us" },
    { message: "Add a Contact page", expectedSlug: "/contact", expectedTitle: "Contact" },
    { message: "create a Services page", expectedSlug: "/services", expectedTitle: "Services" },
    { message: "add page called Our Team", expectedSlug: "/our-team", expectedTitle: "Our Team" },
    { message: "create page named Reviews", expectedSlug: "/reviews", expectedTitle: "Reviews" },
  ]
  for (const { message, expectedSlug, expectedTitle } of cases) {
    const plan = compileDeterministicPlan({
      session: "test-suite",
      intent: { action: "add" },
      message,
      slug: "/",
      currentPage
    })
    assert.ok(plan, `no plan for: ${message}`)
    assert.equal(plan?.intent, "edit_plan", message)
    assert.equal(plan?.ops[0]?.op, "create_page", message)
    if (plan?.ops[0]?.op === "create_page") {
      assert.equal(plan.ops[0].page.slug, expectedSlug, `slug mismatch for: ${message}`)
      assert.equal(plan.ops[0].page.title, expectedTitle, `title mismatch for: ${message}`)
    }
  }
})

test("compileDeterministicPlan: create page never produces /new-page for named pages", () => {
  const currentPage = demoPublishedPages()[0]
  // All of these have a clear page name — none should fall back to /new-page
  const prompts = [
    'create a new page "FAQ"',
    "Create a new About Us page",
    "add page called Pricing",
    "create a Blog page",
    "add page 'Team'",
  ]
  for (const message of prompts) {
    const slug = parseCreatePageRequest(message)
    assert.ok(slug, `no slug for: ${message}`)
    assert.notEqual(slug, "/new-page", `fell back to /new-page for: ${message}`)
  }
})

test("compileDeterministicPlan scaffolds requested hero, text, and cta when creating intent page", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = compileDeterministicPlan({
    session: "test-suite",
    intent: { action: "add" },
    message:
      "create a new page /intent describing the intent of this site, it should have hero, text and cta\n\n[site context]\nHosting context: Vercel production site (single shared project)\n[/site context]",
    slug: "/",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops[0]?.op, "create_page")
  if (plan?.ops[0]?.op === "create_page") {
    const blockTypes = plan.ops[0].page.blocks.map((block) => block.type)
    assert.deepEqual(blockTypes, ["Hero", "RichText", "CTA"])

    const richText = plan.ops[0].page.blocks.find((block) => block.type === "RichText")
    assert.ok(richText)
    if (richText?.type === "RichText") {
      assert.match(String(richText.props.body), /intent/i)
    }
  }
})

test("compileDeterministicPlan keeps CTA add intent as block edit, not page create", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = compileDeterministicPlan({
    session: "test-suite",
    intent: { action: "add" },
    message: "add a CTA corresponding to intent of this page",
    slug: "/",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops[0]?.op, "add_block")
  if (plan?.ops[0] && "block" in plan.ops[0]) {
    const op = plan.ops[0] as { block: { type: string } }
    assert.equal(op.block.type, "CTA")
  }
})

test("compileDeterministicPlan keeps richtext add intent on this page as block edit", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = compileDeterministicPlan({
    session: "test-suite",
    intent: { action: "add" },
    message: "on this page add a richtext describing benefits of grapefruits",
    slug: "/",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops[0]?.op, "add_block")
  if (plan?.ops[0] && "block" in plan.ops[0]) {
    const op = plan.ops[0] as { block: { type: string } }
    assert.equal(op.block.type, "RichText")
  }
})

test("compileDeterministicPlan removes current page when site context includes unrelated route mentions", () => {
  const currentPage = demoPublishedPages().find((page) => page.slug === "/pricing")
  assert.ok(currentPage)
  const plan = compileDeterministicPlan({
    session: "test-suite",
    intent: { action: "remove" },
    message:
      "remove this page\n\n[site context]\nKnown routes: /site, /pricing, /\n[/site context]",
    slug: "/pricing",
    currentPage: currentPage!
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops[0]?.op, "remove_page")
  if (plan?.ops[0]?.op === "remove_page") {
    assert.equal(plan.ops[0].pageSlug, "/pricing")
  }
})

test("buildCreatePagePlan returns clarification when slug already exists", () => {
  const existing = buildCreatePagePlan({
    session: "test-suite",
    requestedSlug: "/pricing"
  })
  assert.ok(existing)
  assert.equal(existing?.intent, "needs_clarification")
})

test("normalizePlanCandidate hydrates create_page page.id and title when missing", () => {
  const parsed = normalizePlanCandidate(
    {
      intent: "edit_plan",
      summary_for_user: "Create about page.",
      change_log: [],
      ops: [{ op: "create_page", page: { slug: "/about-us", blocks: [] } }]
    },
    {
      defaultSlug: "/",
      currentPage: demoPublishedPages()[0],
      userMessage: "create new page /about-us"
    }
  )
  const result = editPlanSchema.safeParse(parsed)
  assert.equal(result.success, true)
  if (!result.success) return
  const op = result.data.ops[0]
  assert.equal(op.op, "create_page")
  if (op.op === "create_page") {
    assert.ok(op.page.id)
    assert.ok(op.page.title)
  }
})

test("normalizePlanCandidate converts create_page on current slug into add_block for this-page edit request", () => {
  const parsed = normalizePlanCandidate(
    {
      intent: "edit_plan",
      summary_for_user: "Created page /site.",
      change_log: [],
      ops: [
        {
          op: "create_page",
          page: {
            slug: "/site",
            blocks: [{ id: "b_richtext_site", type: "RichText", props: { title: "", body: "Grapefruit benefits" } }]
          }
        }
      ]
    },
    {
      defaultSlug: "/site",
      currentPage: {
        id: "p_site",
        slug: "/site",
        title: "Site",
        updatedAt: new Date().toISOString(),
        blocks: [{ id: "b_hero_site", type: "Hero", props: { heading: "H", subheading: "S", ctaText: "Go", ctaHref: "/" } }]
      },
      userMessage: "on this page add a richtext describing benefits of grapefruits"
    }
  )

  const result = editPlanSchema.safeParse(parsed)
  assert.equal(result.success, true)
  if (!result.success) return
  assert.equal(result.data.ops[0]?.op, "add_block")
  if (result.data.ops[0]?.op === "add_block") {
    assert.equal(result.data.ops[0].pageSlug, "/site")
    assert.equal(result.data.ops[0].block.type, "RichText")
  }
})

test("normalizePlanCandidate converts create_page on current slug into add_block for 'the page' phrasing", () => {
  const parsed = normalizePlanCandidate(
    {
      intent: "edit_plan",
      summary_for_user: "Created page /site.",
      change_log: [],
      ops: [
        {
          op: "create_page",
          page: {
            slug: "/site",
            blocks: [
              {
                id: "b_cta_site",
                type: "CTA",
                props: {
                  title: "Start now",
                  description: "Book a demo today.",
                  ctaText: "Book demo",
                  ctaHref: "/contact"
                }
              }
            ]
          }
        }
      ]
    },
    {
      defaultSlug: "/site",
      currentPage: {
        id: "p_site",
        slug: "/site",
        title: "Site",
        updatedAt: new Date().toISOString(),
        blocks: [{ id: "b_hero_site", type: "Hero", props: { heading: "H", subheading: "S", ctaText: "Go", ctaHref: "/" } }]
      },
      userMessage: "generate and add a CTA at the end of the page"
    }
  )

  const result = editPlanSchema.safeParse(parsed)
  assert.equal(result.success, true)
  if (!result.success) return
  assert.equal(result.data.ops[0]?.op, "add_block")
  if (result.data.ops[0]?.op === "add_block") {
    assert.equal(result.data.ops[0].pageSlug, "/site")
    assert.equal(result.data.ops[0].block.type, "CTA")
  }
})

test("compileDeterministicPlan can remove an explicit block (block op)", () => {
  const currentPage = demoPublishedPages()[0]
  const targetId = currentPage.blocks.find((b) => b.type === "CTA")?.id
  assert.ok(targetId)
  const plan = compileDeterministicPlan({
    session: "test-suite",
    intent: { action: "remove", target_block_ref: targetId },
    message: "remove cta",
    slug: "/",
    currentPage
  })
  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops[0]?.op, "remove_block")
})

test("compileDeterministicPlan can update selected block heading (block op)", () => {
  const currentPage = demoPublishedPages()[0]
  const hero = currentPage.blocks.find((b) => b.type === "Hero")
  assert.ok(hero)
  const plan = compileDeterministicPlan({
    session: "test-suite",
    intent: { action: "update", patch: { heading: "New heading" } },
    message: "change heading",
    slug: "/",
    currentPage,
    activeBlockId: hero?.id
  })
  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops[0]?.op, "update_props")
  if (plan?.ops[0] && "patch" in plan.ops[0]) {
    const op = plan.ops[0] as { patch: Record<string, unknown> }
    assert.equal(op.patch.heading, "New heading")
  }
})

test("compileDeterministicPlan asks for clarification on conditional section reorder without explicit target", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = compileDeterministicPlan({
    session: "test-suite",
    intent: { action: "move", target_block_ref: "b_hero_home", position: "top" },
    message: "reorder page sections to improve its readability - if required",
    slug: "/",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "needs_clarification")
  assert.equal(plan?.ops.length, 0)
})

test("normalizePlanCandidate maps duplicate_block aliases including fromBlockId and toPageSlug", () => {
  const parsed = normalizePlanCandidate(
    {
      intent: "edit_plan",
      summary_for_user: "Dup block",
      change_log: [],
      ops: [
        {
          op: "duplicate_block",
          fromBlockId: "b_hero_home",
          pageSlug: "/",
          toPageSlug: "/pricing"
        }
      ]
    },
    {
      defaultSlug: "/",
      currentPage: demoPublishedPages()[0],
      userMessage: "duplicate hero block to /pricing"
    }
  )

  const result = editPlanSchema.safeParse(parsed)
  assert.equal(result.success, true)
  if (!result.success) return
  const op = result.data.ops[0]
  assert.equal(op.op, "duplicate_block")
  if (op.op === "duplicate_block") {
    assert.equal(op.blockId, "b_hero_home")
    assert.equal(op.toPageSlug, "/pricing")
  }
})

test("normalizePlanCandidate keeps list operations valid (add_item)", () => {
  const parsed = normalizePlanCandidate(
    {
      intent: "edit_plan",
      summary_for_user: "Add faq item",
      change_log: [],
      ops: [
        {
          op: "add_item",
          path: "items",
          blockId: "b_faq_1",
          item: { q: "Q", a: "A" },
          pageSlug: "/items"
        }
      ]
    },
    {
      defaultSlug: "/",
      currentPage: demoPublishedPages()[0],
      userMessage: "add faq question"
    }
  )
  const result = editPlanSchema.safeParse(parsed)
  assert.equal(result.success, true)
  if (!result.success) return
  const op = result.data.ops[0]
  assert.equal(op.op, "add_item")
  if (op.op === "add_item") {
    assert.equal(op.listKey, "items")
    assert.equal(op.pageSlug, "/")
  }
})

test("normalizePlanCandidate converts page-delete style malformed remove_block into remove_page", () => {
  const parsed = normalizePlanCandidate(
    {
      intent: "edit_plan",
      summary_for_user: "Delete page",
      change_log: [],
      ops: [{ op: "remove_block", path: "/pricing" }]
    },
    {
      defaultSlug: "/",
      currentPage: demoPublishedPages()[0],
      userMessage: "delete page /pricing"
    }
  )
  const result = editPlanSchema.safeParse(parsed)
  assert.equal(result.success, true)
  if (!result.success) return
  const op = result.data.ops[0]
  assert.equal(op.op, "remove_page")
  if (op.op === "remove_page") assert.equal(op.pageSlug, "/pricing")
})

test("chat apply_pending_plan without pending plan falls back to auto when message is present", async () => {
  const session = `test-pending-fallback-${Date.now()}`
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    payload: {
      session,
      slug: "/",
      message: "create new page /intent-fallback",
      executionMode: "apply_pending_plan"
    }
  })

  assert.equal(response.statusCode, 200)
  const payload = response.json() as { status?: string; summary?: string }
  assert.equal(payload.status, "applied")
  assert.match(String(payload.summary), /Created page \/intent-fallback\./)
})

test("compileDeterministicPlan renames page route when source and target paths are provided", () => {
  const currentPage = demoPublishedPages().find((page) => page.slug === "/pricing")
  assert.ok(currentPage)
  const plan = compileDeterministicPlan({
    session: "test-rename-page",
    intent: { action: "update" },
    message: "rename page /pricing to /plans",
    slug: "/pricing",
    currentPage: currentPage!
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops[0]?.op, "rename_page")
  if (plan?.ops[0]?.op === "rename_page") {
    assert.equal(plan.ops[0].pageSlug, "/pricing")
    assert.equal(plan.ops[0].newPageSlug, "/plans")
  }
})

test("compileDeterministicPlan renames page from natural language name", () => {
  const currentPage = demoPublishedPages().find((page) => page.slug === "/pricing")
  assert.ok(currentPage)
  const plan = compileDeterministicPlan({
    session: "test-rename-natural",
    intent: { action: "update" },
    message: "rename page to Our community",
    slug: "/pricing",
    currentPage: currentPage!
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops[0]?.op, "rename_page")
  if (plan?.ops[0]?.op === "rename_page") {
    assert.equal(plan.ops[0].pageSlug, "/pricing")
    assert.equal(plan.ops[0].newPageSlug, "/our-community")
    assert.equal(plan.ops[0].newTitle, "Our Community")
  }
})

test("isHighConfidenceDeterministicCase matches rename page with natural language name", () => {
  const currentPage = demoPublishedPages()[0]
  const result = isHighConfidenceDeterministicCase({
    message: "rename page to Our community",
    currentPage
  })
  assert.equal(result, true)
})

test("isHighConfidenceDeterministicCase matches bare 'rename to X' without 'page' keyword", () => {
  const currentPage = demoPublishedPages()[0]
  const result = isHighConfidenceDeterministicCase({
    message: "rename to Olive oil",
    currentPage
  })
  assert.equal(result, true)
})

test("compileDeterministicPlan renames current page from bare 'rename to X'", () => {
  const currentPage = demoPublishedPages().find((page) => page.slug === "/pricing")
  assert.ok(currentPage)
  const plan = compileDeterministicPlan({
    session: "test-rename-bare",
    intent: { action: "update" },
    message: "rename to Olive oil",
    slug: "/pricing",
    currentPage: currentPage!
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops[0]?.op, "rename_page")
  if (plan?.ops[0]?.op === "rename_page") {
    assert.equal(plan.ops[0].pageSlug, "/pricing")
    assert.equal(plan.ops[0].newPageSlug, "/olive-oil")
    assert.equal(plan.ops[0].newTitle, "Olive Oil")
  }
})

test("compileDeterministicPlan asks clarification when page rename target path is missing", () => {
  const currentPage = demoPublishedPages().find((page) => page.slug === "/pricing")
  assert.ok(currentPage)
  const plan = compileDeterministicPlan({
    session: "test-rename-missing-target",
    intent: { action: "update" },
    message: "rename this page path",
    slug: "/pricing",
    currentPage: currentPage!
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "needs_clarification")
  assert.equal(plan?.ops.length, 0)
})

test("compileDeterministicPlan blocks deleting home page", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = compileDeterministicPlan({
    session: "test-delete-home",
    intent: { action: "remove" },
    message: "delete page /",
    slug: "/",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "needs_clarification")
  assert.equal(plan?.ops.length, 0)
})

test("compileDeterministicPlan moves page before natural language anchor name", () => {
  const currentPage = demoPublishedPages().find((page) => page.slug === "/pricing")
  assert.ok(currentPage)
  const plan = compileDeterministicPlan({
    session: "test-nav-move-natural",
    intent: { action: "move" },
    message: "move this page before Home",
    slug: "/pricing",
    currentPage: currentPage!
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops[0]?.op, "move_page")
  if (plan?.ops[0]?.op === "move_page") {
    assert.equal(plan.ops[0].pageSlug, "/pricing")
    // Before Home (/) means afterPageSlug is undefined (top position)
    assert.equal(plan.ops[0].afterPageSlug, undefined)
  }
})

test("isHighConfidenceDeterministicCase matches 'move this page before Pricing'", () => {
  const currentPage = demoPublishedPages()[0]
  assert.equal(
    isHighConfidenceDeterministicCase({ message: "move this page before Pricing", currentPage }),
    true
  )
})

test("compileDeterministicPlan moves page to last position via natural language", () => {
  const currentPage = demoPublishedPages().find((page) => page.slug === "/pricing")
  assert.ok(currentPage)
  const plan = compileDeterministicPlan({
    session: "test-nav-move-last",
    intent: { action: "move" },
    message: "move this page to last position",
    slug: "/pricing",
    currentPage: currentPage!
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops[0]?.op, "move_page")
})

test("compileDeterministicPlan returns nav move clarification when anchor page is missing", () => {
  const currentPage = demoPublishedPages().find((page) => page.slug === "/pricing")
  assert.ok(currentPage)
  const plan = compileDeterministicPlan({
    session: "test-nav-missing-anchor",
    intent: { action: "move" },
    message: "move /pricing before /missing in nav",
    slug: "/pricing",
    currentPage: currentPage!
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "needs_clarification")
  assert.equal(plan?.ops.length, 0)
})

test("compileDeterministicPlan creates nav move op to first position", () => {
  const currentPage = demoPublishedPages().find((page) => page.slug === "/pricing")
  assert.ok(currentPage)
  const plan = compileDeterministicPlan({
    session: "test-nav-first",
    intent: { action: "move" },
    message: "move /pricing to first in nav",
    slug: "/pricing",
    currentPage: currentPage!
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops[0]?.op, "move_page")
  if (plan?.ops[0]?.op === "move_page") {
    assert.equal(plan.ops[0].pageSlug, "/pricing")
    assert.equal(plan.ops[0].afterPageSlug, undefined)
  }
})

test("compileDeterministicPlan creates audience landing page with default audience route", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = compileDeterministicPlan({
    session: "test-audience-create",
    intent: { action: "add" },
    message: "create landing page for startup founders audience",
    slug: "/",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops[0]?.op, "create_page")
  if (plan?.ops[0]?.op === "create_page") {
    assert.equal(plan.ops[0].page.slug, "/for-startup-founders-audience")
    assert.ok(plan.ops[0].page.blocks.length >= 1)
  }
})

test("compileDeterministicPlan retargets selected hero block for audience", () => {
  const currentPage = demoPublishedPages()[0]
  const hero = currentPage.blocks.find((block) => block.type === "Hero")
  assert.ok(hero)
  const plan = compileDeterministicPlan({
    session: "test-audience-retarget",
    intent: { action: "update" },
    message: "retarget this for developer teams audience",
    slug: "/",
    currentPage,
    activeBlockId: hero?.id
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops[0]?.op, "update_props")
  if (plan?.ops[0]?.op === "update_props") {
    const patch = plan.ops[0].patch as Record<string, unknown>
    assert.equal(typeof patch.heading, "string")
    assert.match(String(patch.heading), /developer/i)
  }
})

test("compileDeterministicPlan keeps RichText title patch when translating selected body", () => {
  const currentPage = {
    id: "p_custom",
    slug: "/custom",
    title: "Custom",
    updatedAt: new Date().toISOString(),
    blocks: [
      {
        id: "b_richtext_custom",
        type: "RichText" as const,
        props: {
          title: "Overview",
          body: "Welcome to the site."
        }
      }
    ]
  }

  const plan = compileDeterministicPlan({
    session: "test-richtext-translate",
    intent: {
      action: "update",
      target_block_ref: "b_richtext_custom",
      patch: { title: "Resumen", body: "Bienvenido al sitio." }
    },
    message: "translate this body in spanish",
    slug: "/custom",
    currentPage,
    activeBlockId: "b_richtext_custom",
    activeEditablePath: "body"
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops[0]?.op, "update_props")
  if (plan?.ops[0]?.op === "update_props") {
    assert.equal(plan.ops[0].patch.title, "Resumen")
    assert.equal(plan.ops[0].patch.body, "Bienvenido al sitio.")
  }
})

test("compileDeterministicPlan add-before first block emits add then move-to-top ops", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = compileDeterministicPlan({
    session: "test-add-before-top",
    intent: {
      action: "add",
      new_block_type: "CTA",
      position: "before",
      anchor_block_ref: "b_hero_home"
    },
    message: "add cta before hero",
    slug: "/",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops.length, 2)
  assert.equal(plan?.ops[0]?.op, "add_block")
  assert.equal(plan?.ops[1]?.op, "move_block")
  if (plan?.ops[1]?.op === "move_block") {
    assert.equal(plan.ops[1].afterBlockId, undefined)
  }
})

test("compileDeterministicPlan add-after fails with unknown anchor block", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = compileDeterministicPlan({
    session: "test-add-after-missing-anchor",
    intent: {
      action: "add",
      new_block_type: "FAQAccordion",
      position: "after",
      anchor_block_ref: "b_missing"
    },
    message: "add faq after missing block",
    slug: "/",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "needs_clarification")
  assert.equal(plan?.ops.length, 0)
})

test("compileDeterministicPlan asks for block type when add intent is ambiguous", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = compileDeterministicPlan({
    session: "test-add-missing-type",
    intent: { action: "add" },
    message: "add something here",
    slug: "/",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "needs_clarification")
  assert.equal(plan?.ops.length, 0)
})

test("compileDeterministicPlan treats 'add unsplash image' as Hero image update", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = compileDeterministicPlan({
    session: "test-add-unsplash-image",
    intent: { action: "add" },
    message: "add unsplash image",
    slug: "/",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops.length, 1)
  const op = plan?.ops[0]
  assert.equal(op?.op, "update_props")
  assert.equal(op?.op === "update_props" && op.blockId, currentPage.blocks.find((b) => b.type === "Hero")?.id)
  const patch = (op as { patch?: Record<string, unknown> })?.patch
  assert.equal(patch?.imageUrl, "pending")
})

test("compileDeterministicPlan treats 'add a new photo' as Hero image update", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = compileDeterministicPlan({
    session: "test-add-new-photo",
    intent: { action: "add" },
    message: "add a new photo",
    slug: "/",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops.length, 1)
  assert.equal(plan?.ops[0]?.op, "update_props")
})

test("inferDeterministicIntent maps hero image-left phrasing to imagePosition", () => {
  const currentPage = demoPublishedPages()[0]
  const hero = currentPage.blocks.find((b) => b.type === "Hero")
  assert.ok(hero)

  const parsed = inferDeterministicIntent({
    message: "set hero image on the left",
    currentPage
  })

  assert.equal(parsed?.action, "update")
  assert.equal(parsed?.target_block_ref, hero?.id)
  assert.deepEqual(parsed?.patch, { imagePosition: "left" })
})

test("inferDeterministicIntent maps hero text-right phrasing to imagePosition", () => {
  const currentPage = demoPublishedPages()[0]
  const hero = currentPage.blocks.find((b) => b.type === "Hero")
  assert.ok(hero)

  const parsed = inferDeterministicIntent({
    message: "move hero text to the right",
    currentPage
  })

  assert.equal(parsed?.action, "update")
  assert.equal(parsed?.target_block_ref, hero?.id)
  assert.deepEqual(parsed?.patch, { imagePosition: "left" })
})

test("inferDeterministicIntent maps swap image/text to toggled imagePosition", () => {
  const currentPage = demoPublishedPages()[0]
  const hero = currentPage.blocks.find((b) => b.type === "Hero")
  assert.ok(hero)

  const parsed = inferDeterministicIntent({
    message: "swap hero image and text",
    currentPage
  })

  assert.equal(parsed?.action, "update")
  assert.equal(parsed?.target_block_ref, hero?.id)
  assert.deepEqual(parsed?.patch, { imagePosition: "left" })
})

test("compileDeterministicPlan add-before fails with unknown anchor block", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = compileDeterministicPlan({
    session: "test-add-before-missing-anchor",
    intent: {
      action: "add",
      new_block_type: "CTA",
      position: "before",
      anchor_block_ref: "b_not_found"
    },
    message: "add cta before missing block",
    slug: "/",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "needs_clarification")
  assert.equal(plan?.ops.length, 0)
})

test("compileDeterministicPlan add-top emits add then move-to-top operations", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = compileDeterministicPlan({
    session: "test-add-top",
    intent: {
      action: "add",
      new_block_type: "FAQAccordion",
      position: "top"
    },
    message: "add faq at top",
    slug: "/",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops.length, 2)
  assert.equal(plan?.ops[0]?.op, "add_block")
  assert.equal(plan?.ops[1]?.op, "move_block")
  if (plan?.ops[1]?.op === "move_block") {
    assert.equal(plan.ops[1].afterBlockId, undefined)
  }
})

test("compileDeterministicPlan move uses message bottom/end fallback when position is omitted", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = compileDeterministicPlan({
    session: "test-move-end-fallback",
    intent: {
      action: "move",
      target_block_ref: "b_hero_home"
    },
    message: "move hero to end",
    slug: "/",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops[0]?.op, "move_block")
  if (plan?.ops[0]?.op === "move_block") {
    assert.equal(plan.ops[0].blockId, "b_hero_home")
    assert.equal(typeof plan.ops[0].afterBlockId, "string")
  }
})

test("compileDeterministicPlan move-before asks clarification when anchor block is missing", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = compileDeterministicPlan({
    session: "test-move-before-missing-anchor",
    intent: {
      action: "move",
      target_block_ref: "b_hero_home",
      position: "before",
      anchor_block_ref: "b_missing"
    },
    message: "move hero before missing",
    slug: "/",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "needs_clarification")
  assert.equal(plan?.ops.length, 0)
})

test("compileDeterministicPlan move-after uses resolved anchor block id", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = compileDeterministicPlan({
    session: "test-move-after-anchor",
    intent: {
      action: "move",
      target_block_ref: "b_cta_home",
      position: "after",
      anchor_block_ref: "b_hero_home"
    },
    message: "move cta after hero",
    slug: "/",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops[0]?.op, "move_block")
  if (plan?.ops[0]?.op === "move_block") {
    assert.equal(plan.ops[0].blockId, "b_cta_home")
    assert.equal(plan.ops[0].afterBlockId, "b_hero_home")
  }
})

test("compileDeterministicPlan move-before resolves predecessor anchor when anchor is not first", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = compileDeterministicPlan({
    session: "test-move-before-nonfirst-anchor",
    intent: {
      action: "move",
      target_block_ref: "b_cta_home",
      position: "before",
      anchor_block_ref: "b_cta_home"
    },
    message: "move cta before cta",
    slug: "/",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops[0]?.op, "move_block")
  if (plan?.ops[0]?.op === "move_block") {
    // b_cta_home index is > 0; planner chooses predecessor id.
    assert.equal(plan.ops[0].afterBlockId, "b_features_home")
  }
})

test("compileDeterministicPlan move-before to first anchor resolves top placement", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = compileDeterministicPlan({
    session: "test-move-before-first-anchor",
    intent: {
      action: "move",
      target_block_ref: "b_features_home",
      position: "before",
      anchor_block_ref: "b_hero_home"
    },
    message: "move features before hero",
    slug: "/",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops[0]?.op, "move_block")
  if (plan?.ops[0]?.op === "move_block") {
    assert.equal(plan.ops[0].afterBlockId, undefined)
  }
})

test("compileDeterministicPlan move asks clarification when no placement is provided", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = compileDeterministicPlan({
    session: "test-move-missing-placement",
    intent: {
      action: "move",
      target_block_ref: "b_cta_home"
    },
    message: "move cta",
    slug: "/",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "needs_clarification")
  assert.equal(plan?.ops.length, 0)
})

// ---------------------------------------------------------------------------
// Step 1: createPageBlocks scaffolds more block types
// ---------------------------------------------------------------------------

test("compileDeterministicPlan scaffolds hero and features when creating page with features keyword", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = compileDeterministicPlan({
    session: "test-create-features",
    intent: { action: "add" },
    message: "create a new page /about with hero and features",
    slug: "/",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops[0]?.op, "create_page")
  if (plan?.ops[0]?.op === "create_page") {
    const types = plan.ops[0].page.blocks.map((b) => b.type)
    assert.ok(types.includes("Hero"), "should include Hero")
    assert.ok(types.includes("FeatureGrid"), "should include FeatureGrid")
  }
})

test("compileDeterministicPlan scaffolds faq and testimonials blocks on create page", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = compileDeterministicPlan({
    session: "test-create-faq-test",
    intent: { action: "add" },
    message: "create page /services with hero, faq and testimonials",
    slug: "/",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan?.ops[0]?.op, "create_page")
  if (plan?.ops[0]?.op === "create_page") {
    const types = plan.ops[0].page.blocks.map((b) => b.type)
    assert.ok(types.includes("Hero"), "should include Hero")
    assert.ok(types.includes("FAQAccordion"), "should include FAQAccordion")
    assert.ok(types.includes("Testimonials"), "should include Testimonials")
  }
})

// ---------------------------------------------------------------------------
// Step 2: new keyword mappings
// ---------------------------------------------------------------------------

test("inferAddedBlockTypeFromMessage maps social proof to Testimonials", () => {
  assert.equal(inferAddedBlockTypeFromMessage("add social proof section"), "Testimonials")
  assert.equal(inferAddedBlockTypeFromMessage("add reviews"), "Testimonials")
  assert.equal(inferAddedBlockTypeFromMessage("add quotes"), "Testimonials")
})

test("inferAddedBlockTypeFromMessage maps benefits/advantages to FeatureGrid", () => {
  assert.equal(inferAddedBlockTypeFromMessage("add benefits section"), "FeatureGrid")
  assert.equal(inferAddedBlockTypeFromMessage("add advantages"), "FeatureGrid")
})

test("inferAddedBlockTypeFromMessage maps section/paragraph/copy to RichText", () => {
  assert.equal(inferAddedBlockTypeFromMessage("add a section"), "RichText")
  assert.equal(inferAddedBlockTypeFromMessage("add paragraph"), "RichText")
  assert.equal(inferAddedBlockTypeFromMessage("add copy"), "RichText")
})

test("inferAddedBlockTypeFromMessage maps pricing to CardGrid", () => {
  assert.equal(inferAddedBlockTypeFromMessage("add pricing"), "CardGrid")
})

test("inferAddedBlockTypeFromMessage maps TwoColumn and Stats explicitly", () => {
  assert.equal(inferAddedBlockTypeFromMessage("add TwoColumn block"), "TwoColumn")
  assert.equal(inferAddedBlockTypeFromMessage("add two column section"), "TwoColumn")
  assert.equal(inferAddedBlockTypeFromMessage("add stats section"), "Stats")
})

test("inferAddedBlockTypeFromMessage prioritizes explicit TwoColumn over trailing CTA words", () => {
  assert.equal(
    inferAddedBlockTypeFromMessage("add TwoColumn block [site context] ... add cta instead"),
    "TwoColumn"
  )
})

test("inferBlockTypeFromText maps new keywords", () => {
  assert.equal(inferBlockTypeFromText("social proof"), "Testimonials")
  assert.equal(inferBlockTypeFromText("reviews"), "Testimonials")
  assert.equal(inferBlockTypeFromText("benefits"), "FeatureGrid")
  assert.equal(inferBlockTypeFromText("pricing"), "CardGrid")
  assert.equal(inferBlockTypeFromText("paragraph"), "RichText")
  assert.equal(inferBlockTypeFromText("TwoColumn"), "TwoColumn")
  assert.equal(inferBlockTypeFromText("stats"), "Stats")
})

// ---------------------------------------------------------------------------
// Step 3: extractAudienceTarget rejects non-audience phrases
// ---------------------------------------------------------------------------

test("extractAudienceTarget rejects stopword-only and non-audience phrases", () => {
  assert.equal(extractAudienceTarget("change heading for testing"), undefined)
  assert.equal(extractAudienceTarget("do this for me"), undefined)
  assert.equal(extractAudienceTarget("try for free"), undefined)
  assert.equal(extractAudienceTarget("wait for a while"), undefined)
  assert.equal(extractAudienceTarget("change for now"), undefined)
  assert.equal(extractAudienceTarget("improve for demo"), undefined)
})

test("extractAudienceTarget still extracts real audiences", () => {
  assert.equal(extractAudienceTarget("create page for startup founders"), "startup")
  assert.equal(extractAudienceTarget("targeting developer teams"), "developer teams")
})

test("extractAudienceTargets parses a list of audiences for multi-page creation", () => {
  assert.deepEqual(
    extractAudienceTargets("Create only Water Explorers and Wilderness Survivalists pages"),
    ["water explorers", "wilderness survivalists"]
  )
})

test("isBatchAddRequest treats multi-page create prompts as batch overrides", () => {
  assert.equal(isBatchAddRequest("Create only Water Explorers and Wilderness Survivalists pages"), true)
})

test("isBatchAddRequest treats explicit multi-block add prompts as batch overrides", () => {
  assert.equal(isBatchAddRequest("add 3 blocks: hero, cardgrid and CTA"), true)
  assert.equal(
    isBatchAddRequest(
      "add 3 blocks: hero, cardgrid and CTA [site context] Site purpose: Discover the Magic of Avocados. Site name: Avocado Magic [/site context]"
    ),
    true
  )
})

test("isBatchAddRequest treats populate/update-all as batch overrides", () => {
  assert.equal(isBatchAddRequest("populate all components with sample content"), true)
  assert.equal(
    isBatchAddRequest(
      "populate all components with sample content [site context] Site purpose: Discover the Magic of Avocados. Site name: Avocado Magic [/site context]"
    ),
    true
  )
  assert.equal(isBatchAddRequest("update all blocks with real content"), true)
  assert.equal(isBatchAddRequest("rewrite every section"), true)
  assert.equal(isBatchAddRequest("populate the whole page"), true)
  assert.equal(isBatchAddRequest("populate this page with sample content"), true)
  assert.equal(isBatchAddRequest("populate thsis page withall availablebocks and sample content"), true)
  assert.equal(isBatchAddRequest("populate thsis page withall availablebocks and sample content. DO NOT gen AI images,, used Unspalsh only"), true)
  // Negative: single block update should not trigger
  assert.equal(isBatchAddRequest("update the hero heading"), false)
})

test("isBatchAddRequest detects 'add more content to this page' as batch override", () => {
  assert.equal(isBatchAddRequest("add more content to this page"), true)
  assert.equal(isBatchAddRequest("add content to the page"), true)
  assert.equal(isBatchAddRequest("add more sections to this page"), true)
  assert.equal(isBatchAddRequest("expand this page"), true)
  assert.equal(isBatchAddRequest("flesh out this page"), true)
  assert.equal(isBatchAddRequest("enrich the page"), true)
})

test("isBatchAddRequest matches counted add with adjectives between number and noun", () => {
  assert.equal(isBatchAddRequest("Add 3 audience-targeted sections for beginner home cooks, nutrition-focused families, and premium food enthusiasts"), true)
  assert.equal(isBatchAddRequest("add 3 new sections"), true, "regression: 'new' still works as adjective")
  assert.equal(isBatchAddRequest("create 4 custom-styled blocks for different audiences"), true)
})

test("isBatchAddRequest detects 'each/every' + block type as batch override", () => {
  assert.equal(isBatchAddRequest("insert unsplash images to each card - they should not repeat"), true)
  assert.equal(isBatchAddRequest("add images to every card"), true)
  assert.equal(isBatchAddRequest("update each feature with an icon"), true)
  assert.equal(isBatchAddRequest("change every testimonial's quote"), true)
  // Negative: single target should not trigger
  assert.equal(isBatchAddRequest("update the card title"), false)
})

test("isBatchAddRequest detects showcase/demo all components patterns", () => {
  assert.equal(isBatchAddRequest("generate a new page called test show casing all available componenzs with sample content. make it about potatoes"), true)
  assert.equal(isBatchAddRequest("create a page showcasing all components"), true)
  assert.equal(isBatchAddRequest("build a page demonstrating all available blocks"), true)
  assert.equal(isBatchAddRequest("page featuring all sections"), true)
  assert.equal(isBatchAddRequest("all available components with sample content"), true)
  // Negative: single component mention should not trigger
  assert.equal(isBatchAddRequest("add a hero section"), false)
})

test("isBatchAddRequest matches 'add all Available components' (not intercepted as info query)", () => {
  assert.equal(isBatchAddRequest("add all Available components to this page. For any components with images, use Unsplash to add relevant images. Do not generate with AI."), true)
})

test("isBatchRemoveRequest detects batch remove patterns", () => {
  assert.equal(isBatchRemoveRequest("remove all blocks except this one"), true)
  assert.equal(isBatchRemoveRequest("delete everything but the hero"), true)
  assert.equal(isBatchRemoveRequest("remove all blocks"), true)
  assert.equal(isBatchRemoveRequest("delete every section"), true)
  assert.equal(isBatchRemoveRequest("clear all blocks except CTA"), true)
  assert.equal(isBatchRemoveRequest("remove all but this"), true)
  assert.equal(isBatchRemoveRequest("remove all but hero"), true)
  // Typos in "except" still trigger because "all" + remove is enough
  assert.equal(isBatchRemoveRequest("remove all blocks exceopt this one"), true)
  // Negative: single block remove
  assert.equal(isBatchRemoveRequest("remove the hero"), false)
  assert.equal(isBatchRemoveRequest("delete this block"), false)
})

test("isBatchReorderRequest detects batch reorder/rearrange patterns", () => {
  assert.equal(isBatchReorderRequest("reorder blocks in a suggested order"), true)
  assert.equal(isBatchReorderRequest("rearrange the sections"), true)
  assert.equal(isBatchReorderRequest("reorganize all blocks"), true)
  assert.equal(isBatchReorderRequest("sort the blocks into a logical order"), true)
  assert.equal(isBatchReorderRequest("reorder blocks"), true)
  assert.equal(isBatchReorderRequest("re-order the sections"), true)
  assert.equal(isBatchReorderRequest("shuffle blocks"), true)
  // Common typo
  assert.equal(isBatchReorderRequest("reoder blocks in a suggested order"), true)
  // Negative: single block move
  assert.equal(isBatchReorderRequest("move the hero to the top"), false)
  assert.equal(isBatchReorderRequest("move this block down"), false)
})

test("isPageWideRewriteRequest detects page-wide rewrite patterns", () => {
  // Positive cases
  assert.equal(isPageWideRewriteRequest("Refocus this page on premium avocado oils"), true)
  assert.equal(isPageWideRewriteRequest("rebrand the page for a luxury audience"), true)
  assert.equal(isPageWideRewriteRequest("rewrite all content for developers"), true)
  assert.equal(isPageWideRewriteRequest("overhaul this page"), true)
  assert.equal(isPageWideRewriteRequest("redo the whole page"), true)
  assert.equal(isPageWideRewriteRequest("redo this page in Spanish"), true)
  assert.equal(isPageWideRewriteRequest("redesign the page"), true)
  assert.equal(isPageWideRewriteRequest("transform this page into a landing page"), true)
  assert.equal(isPageWideRewriteRequest("retheme the page"), true)
  assert.equal(isPageWideRewriteRequest("update the whole page for B2B"), true)
  assert.equal(isPageWideRewriteRequest("change the entire page to focus on SaaS"), true)

  // Structural audit / review patterns
  assert.equal(isPageWideRewriteRequest("review heading hierarchy again"), true)
  assert.equal(isPageWideRewriteRequest("review the heading hierarchy"), true)
  assert.equal(isPageWideRewriteRequest("fix heading structure"), true)
  assert.equal(isPageWideRewriteRequest("audit heading levels"), true)
  assert.equal(isPageWideRewriteRequest("check heading order"), true)
  assert.equal(isPageWideRewriteRequest("Review Grapefruits page heading tag hierarchy"), true)
  assert.equal(isPageWideRewriteRequest("review about page heading hierarchy"), true)

  // Negative cases — single-block or non-page-wide
  assert.equal(isPageWideRewriteRequest("update the hero heading"), false)
  assert.equal(isPageWideRewriteRequest("rewrite the CTA text"), false)
  assert.equal(isPageWideRewriteRequest("change the heading to something better"), false)
  assert.equal(isPageWideRewriteRequest("redesign my logo"), false)
})

test("extractMentionedBlockTypes returns all block types in order", () => {
  assert.deepEqual(
    extractMentionedBlockTypes("add 3 blocks: hero, cardgrid and CTA"),
    ["Hero", "CardGrid", "CTA"]
  )
  assert.deepEqual(
    extractMentionedBlockTypes("add hero, testimonials and FAQ"),
    ["Hero", "Testimonials", "FAQAccordion"]
  )
})

test("compileDeterministicPlan generates 3 add_block ops for batch add", () => {
  const currentPage = demoPublishedPages()[0]
  const intent = inferDeterministicIntent({
    message: "add 3 blocks: hero, cardgrid and CTA",
    currentPage,
    activeBlockId: undefined,
    activeEditablePath: undefined
  })
  assert.ok(intent)
  assert.equal(intent!.action, "add")

  const plan = compileDeterministicPlan({
    session: "test-batch-add",
    intent: intent!,
    message: "add 3 blocks: hero, cardgrid and CTA",
    slug: "/",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan!.intent, "edit_plan")
  assert.equal(plan!.ops.length, 3)
  assert.equal(plan!.ops[0]!.op, "add_block")
  assert.equal(plan!.ops[1]!.op, "add_block")
  assert.equal(plan!.ops[2]!.op, "add_block")
  // Verify distinct block types
  const types = plan!.ops.map((op) => "block" in op ? (op as any).block.type : null)
  assert.deepEqual(types, ["Hero", "CardGrid", "CTA"])
  // Verify unique block IDs
  const ids = plan!.ops.map((op) => "block" in op ? (op as any).block.id : null)
  assert.equal(new Set(ids).size, 3)
})

test("compileDeterministicPlan batch add with site context envelope", () => {
  const currentPage = demoPublishedPages()[0]
  const message = "add 3 blocks: hero, cardgrid and CTA [site context] Site purpose: Discover the Magic of Avocados. Site name: Avocado Magic [/site context]"
  const intent = inferDeterministicIntent({
    message,
    currentPage,
    activeBlockId: undefined,
    activeEditablePath: undefined
  })
  assert.ok(intent)

  const plan = compileDeterministicPlan({
    session: "test-batch-add-ctx",
    intent: intent!,
    message,
    slug: "/",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan!.ops.length, 3)
})

// ---------------------------------------------------------------------------
// Step 4: tighter asksNavMove regex
// ---------------------------------------------------------------------------

test("compileDeterministicPlan does not interpret 'move page block' as nav move", () => {
  const currentPage = demoPublishedPages()[0]
  const hero = currentPage.blocks.find((b) => b.type === "Hero")
  assert.ok(hero)
  const plan = compileDeterministicPlan({
    session: "test-move-block-not-nav",
    intent: { action: "move", target_block_ref: hero!.id, position: "bottom" },
    message: "move page hero to bottom",
    slug: "/",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops[0]?.op, "move_block")
})

// ---------------------------------------------------------------------------
// Step 5: page rename with single route and 'this page'
// ---------------------------------------------------------------------------

test("compileDeterministicPlan renames current page when single route and 'this page' mentioned", () => {
  const currentPage = demoPublishedPages().find((p) => p.slug === "/pricing")
  assert.ok(currentPage)
  const plan = compileDeterministicPlan({
    session: "test-rename-this-page",
    intent: { action: "update" },
    message: "rename this page to /plans",
    slug: "/pricing",
    currentPage: currentPage!
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops[0]?.op, "rename_page")
  if (plan?.ops[0]?.op === "rename_page") {
    assert.equal(plan.ops[0].pageSlug, "/pricing")
    assert.equal(plan.ops[0].newPageSlug, "/plans")
  }
})

// ---------------------------------------------------------------------------
// Step 6: block removal without active selection
// ---------------------------------------------------------------------------

test("compileDeterministicPlan removes block by type when no selection and unique match", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = compileDeterministicPlan({
    session: "test-remove-no-selection",
    intent: { action: "remove" },
    message: "remove the cta",
    slug: "/",
    currentPage
    // no activeBlockId
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops[0]?.op, "remove_block")
  if (plan?.ops[0]?.op === "remove_block") {
    const ctaBlock = currentPage.blocks.find((b) => b.type === "CTA")
    assert.ok(ctaBlock)
    assert.equal(plan.ops[0].blockId, ctaBlock!.id)
  }
})

test("compileDeterministicPlan asks clarification when removing ambiguous block without selection", () => {
  // A page with two CTA blocks — should not guess
  const currentPage = {
    id: "p_test",
    slug: "/test",
    title: "Test",
    updatedAt: new Date().toISOString(),
    blocks: [
      { id: "b_cta_1", type: "CTA" as const, props: { title: "A", description: "A", ctaText: "Go", ctaHref: "/" } },
      { id: "b_cta_2", type: "CTA" as const, props: { title: "B", description: "B", ctaText: "Go", ctaHref: "/" } }
    ]
  }
  const plan = compileDeterministicPlan({
    session: "test-remove-ambiguous",
    intent: { action: "remove" },
    message: "remove the cta",
    slug: "/test",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "needs_clarification")
})

// ---------------------------------------------------------------------------
// Step 7: list item append without selection
// ---------------------------------------------------------------------------

test("compileDeterministicPlan appends FAQ item without block selection when unique FAQ exists", () => {
  const currentPage = demoPublishedPages().find((p) => p.slug === "/pricing")
  assert.ok(currentPage)
  const faqBlock = currentPage!.blocks.find((b) => b.type === "FAQAccordion")
  assert.ok(faqBlock)
  const plan = compileDeterministicPlan({
    session: "test-add-faq-no-selection",
    intent: { action: "add" },
    message: "add another question",
    slug: "/pricing",
    currentPage: currentPage!
    // no activeBlockId
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops[0]?.op, "update_props")
  if (plan?.ops[0]?.op === "update_props") {
    assert.equal(plan.ops[0].blockId, faqBlock!.id)
  }
})

test("compileDeterministicPlan appends testimonial without selection using 'another' keyword", () => {
  const currentPage = {
    id: "p_test_testimonials",
    slug: "/test-testimonials",
    title: "Test Testimonials",
    updatedAt: new Date().toISOString(),
    blocks: [
      { id: "b_hero_t", type: "Hero" as const, props: { heading: "H", subheading: "S", ctaText: "Go", ctaHref: "/" } },
      {
        id: "b_testimonials_t",
        type: "Testimonials" as const,
        props: { title: "Reviews", items: [{ quote: "Great", author: "Bob" }] }
      }
    ]
  }
  const plan = compileDeterministicPlan({
    session: "test-add-testimonial-no-sel",
    intent: { action: "add" },
    message: "add another testimonial",
    slug: "/test-testimonials",
    currentPage
  })

  assert.ok(plan)
  assert.equal(plan?.intent, "edit_plan")
  assert.equal(plan?.ops[0]?.op, "update_props")
  if (plan?.ops[0]?.op === "update_props") {
    assert.equal(plan.ops[0].blockId, "b_testimonials_t")
  }
})

// ---------------------------------------------------------------------------
// Step 8: audience page creation defers to AI when OPENAI_API_KEY is set
// ---------------------------------------------------------------------------

test("compileDeterministicPlan defers audience page creation to AI when OPENAI_API_KEY is set", () => {
  const currentPage = demoPublishedPages()[0]
  const original = process.env.OPENAI_API_KEY
  try {
    process.env.OPENAI_API_KEY = "sk-test-fake"
    // Use intent "info" to bypass the earlier parseCreatePageRequest path
    // and directly test the audience page creation code path.
    const plan = compileDeterministicPlan({
      session: "test-audience-defer-ai",
      intent: { action: "info" },
      message: "create landing page for startup founders audience",
      slug: "/",
      currentPage
    })
    assert.equal(plan, null, "should return null to defer to AI planner")
  } finally {
    if (original === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = original
  }
})

test("compileDeterministicPlan handles audience page in demo mode (no OPENAI_API_KEY)", () => {
  const currentPage = demoPublishedPages()[0]
  const original = process.env.OPENAI_API_KEY
  try {
    delete process.env.OPENAI_API_KEY
    // Use intent "info" to bypass the earlier parseCreatePageRequest path
    const plan = compileDeterministicPlan({
      session: "test-audience-demo-mode",
      intent: { action: "info" },
      message: "create landing page for startup founders audience",
      slug: "/",
      currentPage
    })
    assert.ok(plan)
    assert.equal(plan?.intent, "edit_plan")
    assert.equal(plan?.ops[0]?.op, "create_page")
  } finally {
    if (original === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = original
  }
})

test("compileDeterministicPlan creates one page per audience in multi-page prompt (demo mode)", () => {
  const currentPage = demoPublishedPages()[0]
  const original = process.env.OPENAI_API_KEY
  try {
    delete process.env.OPENAI_API_KEY
    const plan = compileDeterministicPlan({
      session: "test-audience-multi-demo-mode",
      intent: { action: "info" },
      message: "Create only Water Explorers and Wilderness Survivalists pages",
      slug: "/",
      currentPage
    })
    assert.ok(plan)
    assert.equal(plan?.intent, "edit_plan")
    assert.equal(plan?.ops.length, 2)
    assert.deepEqual(
      plan?.ops.map((op) => (op.op === "create_page" ? op.page.slug : "")),
      ["/for-water-explorers", "/for-wilderness-survivalists"]
    )
  } finally {
    if (original === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = original
  }
})

// ---------------------------------------------------------------------------
// Step 9: audience retarget defers to AI when OPENAI_API_KEY is set
// ---------------------------------------------------------------------------

test("compileDeterministicPlan defers audience retarget to AI when OPENAI_API_KEY is set", () => {
  const currentPage = demoPublishedPages()[0]
  const hero = currentPage.blocks.find((b) => b.type === "Hero")
  assert.ok(hero)
  const original = process.env.OPENAI_API_KEY
  try {
    process.env.OPENAI_API_KEY = "sk-test-fake"
    const plan = compileDeterministicPlan({
      session: "test-retarget-defer-ai",
      intent: { action: "update" },
      message: "retarget this for developer teams audience",
      slug: "/",
      currentPage,
      activeBlockId: hero!.id
    })
    assert.equal(plan, null, "should return null to defer to AI planner")
  } finally {
    if (original === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = original
  }
})

test("compileDeterministicPlan handles audience retarget in demo mode (no OPENAI_API_KEY)", () => {
  const currentPage = demoPublishedPages()[0]
  const hero = currentPage.blocks.find((b) => b.type === "Hero")
  assert.ok(hero)
  const original = process.env.OPENAI_API_KEY
  try {
    delete process.env.OPENAI_API_KEY
    const plan = compileDeterministicPlan({
      session: "test-retarget-demo-mode",
      intent: { action: "update" },
      message: "retarget this for developer teams audience",
      slug: "/",
      currentPage,
      activeBlockId: hero!.id
    })
    assert.ok(plan)
    assert.equal(plan?.intent, "edit_plan")
    assert.equal(plan?.ops[0]?.op, "update_props")
  } finally {
    if (original === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = original
  }
})

// ---------------------------------------------------------------------------
// Step 10: rewrite defers to AI when OPENAI_API_KEY is set (no quoted text)
// ---------------------------------------------------------------------------

test("compileDeterministicPlan defers rewrite to AI when OPENAI_API_KEY is set and no quoted text", () => {
  const currentPage = demoPublishedPages()[0]
  const hero = currentPage.blocks.find((b) => b.type === "Hero")
  assert.ok(hero)
  const original = process.env.OPENAI_API_KEY
  try {
    process.env.OPENAI_API_KEY = "sk-test-fake"
    const plan = compileDeterministicPlan({
      session: "test-rewrite-defer-ai",
      intent: { action: "update", target_block_ref: hero!.id },
      message: "rewrite this heading",
      slug: "/",
      currentPage,
      activeBlockId: hero!.id
    })
    assert.equal(plan, null, "should return null to defer to AI planner")
  } finally {
    if (original === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = original
  }
})

test("compileDeterministicPlan keeps deterministic handling when quoted text is provided even with OPENAI_API_KEY", () => {
  const currentPage = demoPublishedPages()[0]
  const hero = currentPage.blocks.find((b) => b.type === "Hero")
  assert.ok(hero)
  const original = process.env.OPENAI_API_KEY
  try {
    process.env.OPENAI_API_KEY = "sk-test-fake"
    const plan = compileDeterministicPlan({
      session: "test-rewrite-quoted",
      intent: { action: "update", target_block_ref: hero!.id, patch: { heading: "Hello World" } },
      message: 'change heading to "Hello World"',
      slug: "/",
      currentPage,
      activeBlockId: hero!.id
    })
    assert.ok(plan, "should NOT defer to AI when quoted text is present")
    assert.equal(plan?.intent, "edit_plan")
    assert.equal(plan?.ops[0]?.op, "update_props")
  } finally {
    if (original === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = original
  }
})

test("compileDeterministicPlan defers rewrite to AI when quoted text is only a banned-word constraint", () => {
  const currentPage = demoPublishedPages()[0]
  const hero = currentPage.blocks.find((b) => b.type === "Hero")
  assert.ok(hero)
  const original = process.env.OPENAI_API_KEY
  try {
    process.env.OPENAI_API_KEY = "sk-test-fake"
    const plan = compileDeterministicPlan({
      session: "test-rewrite-constraint-quoted",
      intent: { action: "update", target_block_ref: hero!.id },
      message: "Rewrite the hero so it sounds confident and modern. Keep heading under 8 words, avoid cliches like 'unlock' or 'journey', keep CTA intact.",
      slug: "/",
      currentPage
    })
    assert.equal(plan, null, "should return null to defer to AI planner for constraint-heavy rewrite")
  } finally {
    if (original === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = original
  }
})

// ---------------------------------------------------------------------------
// suggested_next_actions schema tests
// ---------------------------------------------------------------------------

test("editPlanSchema accepts plans with suggested_next_actions", () => {
  const plan = {
    intent: "edit_plan",
    summary_for_user: "Updated heading.",
    change_log: ["Changed heading."],
    ops: [],
    suggested_next_actions: ["Update the subheading", "Add a CTA section"]
  }
  const result = editPlanSchema.safeParse(plan)
  assert.ok(result.success, "should accept plan with suggested_next_actions")
  assert.deepEqual(result.data.suggested_next_actions, ["Update the subheading", "Add a CTA section"])
})

test("editPlanSchema accepts plans without suggested_next_actions (backward compat)", () => {
  const plan = {
    intent: "edit_plan",
    summary_for_user: "Updated heading.",
    change_log: ["Changed heading."],
    ops: []
  }
  const result = editPlanSchema.safeParse(plan)
  assert.ok(result.success, "should accept plan without suggested_next_actions")
  assert.equal(result.data.suggested_next_actions, undefined)
})

test("normalizePlanCandidate coerces suggested_next_actions string to array", () => {
  const raw = {
    intent: "content_answer",
    summary_for_user: "Here are the CTA buttons.",
    change_log: [],
    ops: [],
    suggested_next_actions: "Create the missing pages\nUpdate CTA destinations"
  }
  const result = normalizePlanCandidate(raw as any, { defaultSlug: "/" }) as Record<string, unknown>
  assert.ok(Array.isArray(result.suggested_next_actions), "should be array after normalization")
  assert.deepEqual(result.suggested_next_actions, ["Create the missing pages", "Update CTA destinations"])
})

test("normalizePlanCandidate coerces comma-separated suggested_next_actions string", () => {
  const raw = {
    intent: "content_answer",
    summary_for_user: "Found content.",
    change_log: [],
    ops: [],
    suggested_next_actions: "Add a hero block, Update the heading, Remove the CTA"
  }
  const result = normalizePlanCandidate(raw as any, { defaultSlug: "/" }) as Record<string, unknown>
  assert.ok(Array.isArray(result.suggested_next_actions))
  assert.equal((result.suggested_next_actions as string[]).length, 3)
})

// ---------------------------------------------------------------------------
// humanizeArrayPath tests
// ---------------------------------------------------------------------------

test("humanizeArrayPath converts bracket notation to ordinal text", () => {
  assert.equal(humanizeArrayPath("cards[0]"), "the first card")
  assert.equal(humanizeArrayPath("cards[1]"), "the second card")
  assert.equal(humanizeArrayPath("features[2]"), "the third feature")
  assert.equal(humanizeArrayPath("items[0]"), "the first item")
  assert.equal(humanizeArrayPath("stats[3]"), "the fourth stat")
  assert.equal(humanizeArrayPath("columns[0]"), "the first column")
})

test("humanizeArrayPath returns input unchanged for non-array paths", () => {
  assert.equal(humanizeArrayPath("heading"), "heading")
  assert.equal(humanizeArrayPath("title"), "title")
})

// ---------------------------------------------------------------------------
// childSuggestions humanized output tests
// ---------------------------------------------------------------------------

test("childSuggestions returns humanized paths, no bracket notation", () => {
  const block = { id: "b1", type: "CardGrid", props: { title: "Cards", cards: [{ title: "A", description: "B", ctaText: "C", ctaHref: "/" }] } }
  const suggestions = childSuggestions({ selected: block, editablePath: "cards[0].title" })
  assert.ok(suggestions.length > 0, "should return suggestions")
  for (const s of suggestions) {
    assert.ok(!s.includes("["), `suggestion should not contain brackets: ${s}`)
    assert.ok(s.includes("the first card"), `suggestion should contain humanized path: ${s}`)
  }
})

test("childSuggestions humanizes FAQAccordion items", () => {
  const block = { id: "b2", type: "FAQAccordion", props: { title: "FAQ", items: [{ q: "Q1", a: "A1" }] } }
  const suggestions = childSuggestions({ selected: block, editablePath: "items[0].q" })
  assert.ok(suggestions.some((s) => s.includes("question")), "should use 'question' instead of 'q'")
  assert.ok(suggestions.some((s) => s.includes("answer")), "should use 'answer' instead of 'a'")
})

// ---------------------------------------------------------------------------
// clarificationSuggestions tests
// ---------------------------------------------------------------------------

test("clarificationSuggestions without selection doesn't include 'Remove selected block'", () => {
  const pages = demoPublishedPages()
  const home = pages[0]
  const suggestions = clarificationSuggestions({ body: { message: "something" }, current: home, selected: null })
  for (const s of suggestions) {
    assert.ok(!s.toLowerCase().includes("remove selected block"), `should not suggest removing selected block: ${s}`)
  }
})

test("clarificationSuggestions with selection doesn't include 'Remove selected block'", () => {
  const pages = demoPublishedPages()
  const home = pages[0]
  const hero = home.blocks.find((b) => b.type === "Hero")!
  const suggestions = clarificationSuggestions({ body: { message: "something" }, current: home, selected: hero })
  for (const s of suggestions) {
    assert.ok(!s.toLowerCase().includes("remove selected block"), `should not suggest removing selected block: ${s}`)
  }
})

// ---------------------------------------------------------------------------
// postEditSuggestions tests
// ---------------------------------------------------------------------------

test("postEditSuggestions generates suggestions for update_props", () => {
  const pages = demoPublishedPages()
  const home = pages[0]
  const hero = home.blocks.find((b) => b.type === "Hero")!
  const plan = {
    intent: "edit_plan" as const,
    summary_for_user: "Updated heading.",
    change_log: ["Changed heading."],
    ops: [{ op: "update_props" as const, pageSlug: "/", blockId: hero.id, patch: { heading: "New" } }]
  }
  const suggestions = postEditSuggestions({ plan, current: home, body: { message: "change heading" } })
  assert.ok(suggestions.length > 0, "should return at least one suggestion")
  assert.ok(suggestions.length <= 4, "should return at most 4 suggestions")
})

test("postEditSuggestions suggests missing block types", () => {
  const pages = demoPublishedPages()
  const home = pages[0]
  const plan = {
    intent: "edit_plan" as const,
    summary_for_user: "Updated heading.",
    change_log: ["Changed heading."],
    ops: [{ op: "update_props" as const, pageSlug: "/", blockId: home.blocks[0].id, patch: { heading: "New" } }]
  }
  const suggestions = postEditSuggestions({ plan, current: home, body: { message: "change heading" } })
  const hasTestimonials = suggestions.some((s) => s.toLowerCase().includes("testimonials"))
  const hasFaq = suggestions.some((s) => s.toLowerCase().includes("faq"))
  assert.ok(hasTestimonials || hasFaq, "should suggest adding missing block types")
})

test("postEditSuggestions does not return block suggestions after remove_page", () => {
  const pages = demoPublishedPages()
  const home = pages[0]
  const plan = {
    intent: "edit_plan" as const,
    summary_for_user: "Deleted page /test.",
    change_log: ["Removed page /test."],
    ops: [{ op: "remove_page" as const, pageSlug: "/test" }]
  }
  const suggestions = postEditSuggestions({ plan, current: home, body: { message: "remove this page" } })
  assert.deepEqual(suggestions, [])
})

// ---------------------------------------------------------------------------
// parseDuplicatePageRequest
// ---------------------------------------------------------------------------

test("parseDuplicatePageRequest: 'copy this to /test page' uses currentSlug as source", () => {
  const result = parseDuplicatePageRequest("copy this to /test page", { currentSlug: "/" })
  assert.ok(result, "should parse as a duplicate request")
  assert.equal(result.sourceSlug, "/")
  assert.equal(result.targetSlug, "/test")
})

test("parseDuplicatePageRequest: 'copy this to /test page' with currentSlug /about", () => {
  const result = parseDuplicatePageRequest("copy this to /test page", { currentSlug: "/about" })
  assert.ok(result, "should parse as a duplicate request")
  assert.equal(result.sourceSlug, "/about")
  assert.equal(result.targetSlug, "/test")
})

test("parseDuplicatePageRequest: 'duplicate /about to /backup'", () => {
  const result = parseDuplicatePageRequest("duplicate /about to /backup", { currentSlug: "/" })
  assert.ok(result, "should parse as a duplicate request")
  assert.equal(result.sourceSlug, "/about")
  assert.equal(result.targetSlug, "/backup")
})

test("parseDuplicatePageRequest: 'clone this page into a new one called Testers with url /testers'", () => {
  const result = parseDuplicatePageRequest("clone this page into a new one called Testers with url /testers", { currentSlug: "/" })
  assert.ok(result, "should parse as a duplicate request")
  assert.equal(result.sourceSlug, "/", "source should be current page, not /testers")
  assert.equal(result.targetSlug, "/testers")
})

test("parseDuplicatePageRequest: 'clone this page with url /about-us'", () => {
  const result = parseDuplicatePageRequest("clone this page with url /about-us", { currentSlug: "/services" })
  assert.ok(result, "should parse as a duplicate request")
  assert.equal(result.sourceSlug, "/services")
  assert.equal(result.targetSlug, "/about-us")
})

test("normalizePlanCandidate converts update_props with appended array items to add_item ops", () => {
  const currentPage = demoPublishedPages()[0]
  const faqBlock = currentPage.blocks.find((b) => b.type === "FAQAccordion")
  assert.ok(faqBlock, "demo page should have FAQAccordion")
  const existingItems = (faqBlock.props as Record<string, unknown>).items as unknown[]
  assert.ok(Array.isArray(existingItems) && existingItems.length > 0, "FAQAccordion should have existing items")

  const newItems = [
    { q: "How should I store avocados?", a: "Keep unripe avocados at room temperature." },
    { q: "Can I freeze avocados?", a: "Yes, peel and pit them first." },
    { q: "How long do avocados last in the fridge?", a: "About 3-5 days when ripe." }
  ]

  const plan = normalizePlanCandidate(
    {
      intent: "edit_plan",
      summary_for_user: "Added 3 FAQ questions about storage.",
      change_log: ["Added 3 questions about storage"],
      ops: [
        {
          op: "update_props",
          pageSlug: "/",
          blockId: faqBlock.id,
          patch: { items: [...existingItems, ...newItems] }
        }
      ]
    },
    { defaultSlug: "/", currentPage, userMessage: "add 3 questions about storage" }
  ) as { ops: Array<Record<string, unknown>> }

  // Should be converted to 3 add_item ops (not 1 update_props)
  assert.equal(plan.ops.length, 3, `expected 3 add_item ops, got ${plan.ops.length}: ${JSON.stringify(plan.ops.map((o: any) => o.op))}`)
  for (const op of plan.ops) {
    assert.equal(op.op, "add_item")
    assert.equal(op.blockId, faqBlock.id)
    assert.equal(op.listKey, "items")
    assert.ok(op.item && typeof op.item === "object", "each add_item should have an item")
  }
})

test("normalizePlanCandidate assigns unique IDs to multiple same-type add_block ops", () => {
  const page = demoPublishedPages()[0]
  const plan = normalizePlanCandidate(
    {
      intent: "edit_plan",
      ops: [
        { op: "add_block", blockType: "RichText", pageSlug: "/", props: { content: "Section 1" } },
        { op: "add_block", blockType: "RichText", pageSlug: "/", props: { content: "Section 2" } },
        { op: "add_block", blockType: "RichText", pageSlug: "/", props: { content: "Section 3" } },
      ],
      summary_for_user: "Added 3 sections",
      change_log: ["add 3 sections"],
    },
    { currentPage: page, defaultSlug: "/", userMessage: "Add 3 sections" }
  ) as { ops: Array<Record<string, unknown>> }
  const ids = plan.ops.map((op: any) => op.block?.id).filter(Boolean)
  assert.equal(ids.length, 3, "should have 3 ops with block IDs")
  assert.equal(new Set(ids).size, 3, "all 3 block IDs must be unique")
})

test("isHighConfidenceDeterministicCase returns false for 'add a proper CTA' (needs LLM for content)", () => {
  const currentPage = demoPublishedPages()[0]
  assert.equal(
    isHighConfidenceDeterministicCase({ message: "add a proper CTA", currentPage }),
    false,
    "quality-signaling words like 'proper' should defer to LLM for content generation"
  )
})

test("isHighConfidenceDeterministicCase still returns true for plain 'add a CTA'", () => {
  const currentPage = demoPublishedPages()[0]
  assert.equal(
    isHighConfidenceDeterministicCase({ message: "add a CTA", currentPage }),
    true,
    "plain add block requests should use the deterministic path"
  )
})

test("isHighConfidenceDeterministicCase returns false for counted batch add with only 1 named type", () => {
  const currentPage = demoPublishedPages()[0]
  assert.equal(
    isHighConfidenceDeterministicCase({
      message: "Add 3 audience-targeted sections for beginner home cooks, nutrition-focused families, and premium food enthusiasts. Each section should include one practical takeaway and an educational CTA",
      currentPage
    }),
    false,
    "batch add with adjectives and only 1 named block type (CTA in description) should defer to LLM"
  )
})

test("isHighConfidenceDeterministicCase returns false for page-wide rewrite (needs LLM)", () => {
  const currentPage = demoPublishedPages()[0]
  assert.equal(
    isHighConfidenceDeterministicCase({
      message: "Refocus this page on premium avocado oils and usage education. Keep it refined and practical.",
      currentPage
    }),
    false,
    "page-wide rewrite/refocus requests should defer to LLM for content generation"
  )
})

test("plannerDefaultProps for TwoColumn produces valid block props", () => {
  const props = plannerDefaultProps("TwoColumn")
  const result = validateBlockProps("TwoColumn", props)
  assert.equal(result.success, true, "TwoColumn default props from plan-normalizer must pass Zod validation")
  assert.ok(Array.isArray(props.left), "TwoColumn defaults must include left array")
  assert.ok(Array.isArray(props.right), "TwoColumn defaults must include right array")
})

test("plannerDefaultProps for every allowedBlockType passes Zod validation", () => {
  for (const type of allowedBlockTypes) {
    const props = plannerDefaultProps(type)
    const result = validateBlockProps(type, props)
    assert.equal(result.success, true, `Default props for ${type} must pass Zod validation`)
  }
})

test("isPageListQuery detects page-listing requests", () => {
  const positives = [
    "list all pages on this site",
    "show me the pages",
    "what pages are on this site",
    "what pages do I have",
    "which pages are available",
    "how many pages",
    "show all pages",
    "list pages"
  ]
  const negatives = [
    "add a new page",
    "delete the about page",
    "rename page to /new-slug",
    "move pages around",
    "add hero block"
  ]
  for (const prompt of positives) assert.equal(isPageListQuery(prompt), true, prompt)
  for (const prompt of negatives) assert.equal(isPageListQuery(prompt), false, prompt)
})

test("isBatchAddRequest matches 'add N pages for each card' (add verb in BATCH_PAGE_CREATE_PATTERNS)", () => {
  assert.equal(isBatchAddRequest("add 3 new pages for each card item and link CTAs to them"), true)
  assert.equal(isBatchAddRequest("add pages for developers and marketers"), true)
})

test("isPageListQuery does not match page-creation requests that mention 'the pages'", () => {
  assert.equal(isPageListQuery("add 3 pages and link each card to them. the content of the pages should match the cards"), false)
  assert.equal(isPageListQuery("create new pages and update the pages to match"), false)
  assert.equal(isPageListQuery("add pages for each card item"), false)
})

test("isLikelyClarificationFollowUp returns false for 'translate this page to german'", () => {
  assert.equal(isLikelyClarificationFollowUp("translate this page to german"), false)
  assert.equal(isLikelyClarificationFollowUp("redesign this page"), false)
  assert.equal(isLikelyClarificationFollowUp("refocus this page on SaaS"), false)
  assert.equal(isLikelyClarificationFollowUp("rebuild this page"), false)
})

test("isInfoQuery detects 'what tabs do we have' as info query", () => {
  assert.equal(isInfoQuery("what tabs do we have"), true)
  assert.equal(isInfoQuery("what items do we have"), true)
  assert.equal(isInfoQuery("what cards do we have"), true)
  assert.equal(isInfoQuery("which pages do we have"), true)
  assert.equal(isInfoQuery("what features does this have"), true)
  assert.equal(isInfoQuery("what images do we have"), true)
  // Edit requests should NOT match
  assert.equal(isInfoQuery("add a new tab"), false)
  assert.equal(isInfoQuery("rewrite the hero heading"), false)
})

test("shouldPreferFastModelForMessage prefers fast for simple prop edits", () => {
  // Simple targeted removals → fast model
  assert.equal(shouldPreferFastModelForMessage("remove emojis from tab labels"), true)
  assert.equal(shouldPreferFastModelForMessage("strip icons from the labels"), true)
  assert.equal(shouldPreferFastModelForMessage("delete the emoji from link text"), true)
  assert.equal(shouldPreferFastModelForMessage("clear all icons from labels"), true)
  // Simple targeted additions → fast model
  assert.equal(shouldPreferFastModelForMessage("add emojis to tab names"), true)
  assert.equal(shouldPreferFastModelForMessage("put icons before the labels"), true)
  assert.equal(shouldPreferFastModelForMessage("change the heading text"), true)
  assert.equal(shouldPreferFastModelForMessage("update the link labels"), true)
  // Rewrites → fast model (existing behavior)
  assert.equal(shouldPreferFastModelForMessage("rewrite the heading"), true)
  // Complex requests → NOT fast
  assert.equal(shouldPreferFastModelForMessage("translate this page to german"), false)
  assert.equal(shouldPreferFastModelForMessage("create a new about page"), false)
})

test("editPlanJsonSchema ops items declares all operation fields for strict mode compatibility", async () => {
  const { editPlanJsonSchema } = await import("./chat/plan-json-schema.js")
  const opsItems = editPlanJsonSchema.properties.ops.items as Record<string, unknown>
  const props = (opsItems as { properties?: Record<string, unknown> }).properties ?? {}
  // All common op fields must be declared so they survive additionalProperties:false
  for (const field of ["op", "pageSlug", "blockId", "patch", "block", "page", "listKey", "index", "item"]) {
    assert.ok(props[field], `ops items schema must declare '${field}' for OpenAI strict mode`)
  }
})

test("isRewriteLikeMessage matches 'review copy for readability'", () => {
  assert.equal(isRewriteLikeMessage("review copy for readability"), true)
  assert.equal(isRewriteLikeMessage("review text for clarity"), true)
  assert.equal(isRewriteLikeMessage("review content for tone"), true)
  // plain "review" without copy/text target should not match
  assert.equal(isRewriteLikeMessage("review this page"), false)
})

test("isRewriteLikeMessage matches optimize variants", () => {
  assert.equal(isRewriteLikeMessage("optimize this"), true)
  assert.equal(isRewriteLikeMessage("optimize the copy"), true)
  assert.equal(isRewriteLikeMessage("how would you optimize this?"), true)
  assert.equal(isRewriteLikeMessage("optimizing the hero section"), true)
})

test("inferBlockTypeFromText detects carousel/gallery/tabs block types", () => {
  assert.equal(inferBlockTypeFromText("carousel"), "Carousel")
  assert.equal(inferBlockTypeFromText("slideshow"), "Carousel")
  assert.equal(inferBlockTypeFromText("slider"), "Carousel")
  assert.equal(inferBlockTypeFromText("gallery"), "Gallery")
  assert.equal(inferBlockTypeFromText("tabs"), "Tabs")
  assert.equal(inferBlockTypeFromText("table"), "Table")
  assert.equal(inferBlockTypeFromText("blockquote"), "Quote")
  assert.equal(inferBlockTypeFromText("video"), "Video")
  assert.equal(inferBlockTypeFromText("embed"), "Embed")
  assert.equal(inferBlockTypeFromText("banner"), "Banner")
})

test("normalizePlanCandidate coerces Carousel autoplay boolean to string", () => {
  const plan = normalizePlanCandidate({
    ops: [
      {
        op: "add_block",
        block: {
          type: "Carousel",
          id: "b_carousel_test",
          props: {
            autoplay: true,
            slides: [{ imageUrl: "/img.jpg", alt: "Slide" }]
          }
        }
      }
    ]
  }) as any
  assert.equal(plan.ops[0].block.props.autoplay, "true")

  const planFalse = normalizePlanCandidate({
    ops: [
      {
        op: "add_block",
        block: {
          type: "Carousel",
          id: "b_carousel_test2",
          props: {
            autoplay: false,
            slides: [{ imageUrl: "/img.jpg", alt: "Slide" }]
          }
        }
      }
    ]
  }) as any
  assert.equal(planFalse.ops[0].block.props.autoplay, "false")
})

test("normalizePlanCandidate seeds default props when add_block has no props", () => {
  const plan = normalizePlanCandidate({
    ops: [
      {
        op: "add_block",
        block: {
          type: "Hero",
          id: "b_hero_test"
        }
      }
    ]
  }) as any
  const props = plan.ops[0].block.props
  assert.ok(props, "props should not be undefined")
  assert.equal(typeof props, "object")
  // Should have default Hero props
  assert.ok("heading" in props || "title" in props, "should have heading or title from defaults")
})

test("normalizePlanCandidate: bulk add_block for all block types passes editPlanSchema", () => {
  // Simulates what Haiku generates for "add all available components":
  // - Some blocks have props under block.props
  // - Some blocks have NO props at all (LLM omits them)
  // - Carousel has boolean autoplay instead of string enum
  // - LLM may use "slides" instead of "items" for Carousel
  // - Some blocks have props scattered at block level (no .props wrapper)
  const rawLlmOutput = {
    intent: "edit_plan",
    summary_for_user: "Adding all available component types.",
    change_log: [
      "Add Hero section",
      "Add FeatureGrid",
      "Add Testimonials",
      "Add FAQAccordion",
      "Add CTA",
      "Add Card",
      "Add CardGrid",
      "Add RichText",
      "Add Stats",
      "Add TwoColumn",
      "Add Carousel",
      "Add Gallery",
      "Add Tabs",
      "Add Table",
      "Add Quote",
      "Add Video",
      "Add Embed",
      "Add Banner"
    ],
    ops: [
      // Normal: block with props
      { op: "add_block", block: { type: "Hero", id: "b_hero_1", props: { heading: "Welcome", subheading: "Hello", ctaText: "Go", ctaHref: "/", imageUrl: "/hero-generated.svg", imageAlt: "Hero" } } },
      // Normal with props
      { op: "add_block", block: { type: "FeatureGrid", id: "b_fg_1", props: { title: "Features", features: [{ icon: "star", title: "Fast", description: "Quick" }] } } },
      // Missing props entirely — should get defaults
      { op: "add_block", block: { type: "Testimonials", id: "b_testimonials_1" } },
      { op: "add_block", block: { type: "FAQAccordion", id: "b_faq_1" } },
      { op: "add_block", block: { type: "CTA", id: "b_cta_1" } },
      { op: "add_block", block: { type: "Card", id: "b_card_1" } },
      { op: "add_block", block: { type: "CardGrid", id: "b_cardgrid_1" } },
      { op: "add_block", block: { type: "RichText", id: "b_richtext_1" } },
      { op: "add_block", block: { type: "Stats", id: "b_stats_1" } },
      { op: "add_block", block: { type: "TwoColumn", id: "b_twocolumn_1" } },
      // Carousel with boolean autoplay and "slides" instead of "items" (common LLM mistake)
      { op: "add_block", block: { type: "Carousel", id: "b_carousel_1", props: { autoplay: true, slides: [{ imageUrl: "/img.jpg", imageAlt: "Slide 1" }] } } },
      // Gallery with "photos" instead of "images" and numeric columns (should be string enum)
      { op: "add_block", block: { type: "Gallery", id: "b_gallery_1", props: { columns: 3, photos: [{ imageUrl: "/img.jpg", alt: "Photo 1" }] } } },
      // Tabs with props
      { op: "add_block", block: { type: "Tabs", id: "b_tabs_1", props: { tabs: [{ label: "Tab 1", content: "Content" }] } } },
      // Table with "columns" and "data" instead of "headers" and "rows", boolean striped
      { op: "add_block", block: { type: "Table", id: "b_table_1", props: { columns: ["Name", "Value"], data: [["A", "1"]], striped: true } } },
      // Blocks with no props at all (should get defaults)
      { op: "add_block", block: { type: "Quote", id: "b_quote_1" } },
      // Video with boolean autoplay/loop
      { op: "add_block", block: { type: "Video", id: "b_video_1", props: { src: "https://youtube.com/watch?v=test", autoplay: true, loop: false } } },
      { op: "add_block", block: { type: "Embed", id: "b_embed_1" } },
      { op: "add_block", block: { type: "Banner", id: "b_banner_1" } }
    ]
  }

  const normalized = normalizePlanCandidate(rawLlmOutput, { defaultSlug: "/" }) as any

  // Every op should have block.props as a non-null object
  for (let i = 0; i < normalized.ops.length; i++) {
    const op = normalized.ops[i]
    assert.ok(op.block, `ops[${i}] should have block`)
    assert.ok(op.block.props && typeof op.block.props === "object", `ops[${i}] (${op.block.type}) block.props should be a record, got ${typeof op.block.props}`)
  }

  // Carousel: autoplay coerced, slides→items
  const carouselOp = normalized.ops.find((o: any) => o.block?.type === "Carousel")
  assert.equal(carouselOp.block.props.autoplay, "true")
  assert.ok(Array.isArray(carouselOp.block.props.items), "slides should be remapped to items")
  assert.equal(carouselOp.block.props.slides, undefined, "slides key should be removed")

  // Gallery: photos→images, numeric columns→string
  const galleryOp = normalized.ops.find((o: any) => o.block?.type === "Gallery")
  assert.ok(Array.isArray(galleryOp.block.props.images), "photos should be remapped to images")
  assert.equal(galleryOp.block.props.photos, undefined)
  assert.equal(galleryOp.block.props.columns, "3", "numeric columns should be coerced to string")

  // Table: columns→headers, data→rows, boolean striped→string
  const tableOp = normalized.ops.find((o: any) => o.block?.type === "Table")
  assert.ok(Array.isArray(tableOp.block.props.headers), "columns should be remapped to headers")
  assert.ok(Array.isArray(tableOp.block.props.rows), "data should be remapped to rows")
  assert.equal(tableOp.block.props.columns, undefined)
  assert.equal(tableOp.block.props.data, undefined)
  assert.equal(tableOp.block.props.striped, "true", "boolean striped should be coerced to string")

  // Video: boolean autoplay/loop coerced to strings
  const videoOp = normalized.ops.find((o: any) => o.block?.type === "Video")
  assert.equal(videoOp.block.props.autoplay, "true")
  assert.equal(videoOp.block.props.loop, "false")

  // The full normalized plan should pass editPlanSchema
  const result = editPlanSchema.safeParse(normalized)
  if (!result.success) {
    const issue = result.error.issues[0]
    assert.fail(`editPlanSchema validation failed: ${issue?.message} at ${issue?.path?.join(".")}`)
  }

  // Each block's props should also pass its own block-level Zod schema
  for (const op of normalized.ops) {
    const blockType = op.block?.type
    if (!blockType) continue
    const propResult = validateBlockProps(blockType, op.block.props)
    assert.ok(propResult.success, `validateBlockProps failed for ${blockType}: ${propResult.success ? "" : JSON.stringify(propResult.error?.issues?.[0])}`)
  }
})

test("normalizePlanCandidate: add_block with props at block top level (no .props wrapper)", () => {
  // Some LLMs put props directly on block instead of under block.props
  const raw = {
    intent: "edit_plan",
    summary_for_user: "Adding a carousel.",
    change_log: ["Add Carousel"],
    ops: [
      {
        op: "add_block",
        props: { autoplay: true, items: [{ imageUrl: "/img.jpg", imageAlt: "Slide" }] },
        blockType: "Carousel"
      }
    ]
  }

  const normalized = normalizePlanCandidate(raw, { defaultSlug: "/" }) as any
  const op = normalized.ops[0]
  assert.ok(op.block, "should have block")
  assert.ok(op.block.props && typeof op.block.props === "object", "block.props should be a record")
  assert.equal(op.block.props.autoplay, "true", "autoplay should be coerced to string")

  const result = editPlanSchema.safeParse(normalized)
  if (!result.success) {
    const issue = result.error.issues[0]
    assert.fail(`editPlanSchema validation failed: ${issue?.message} at ${issue?.path?.join(".")}`)
  }
})

// ---------------------------------------------------------------------------
// tryCompoundDeterministicPlan
// ---------------------------------------------------------------------------

test("tryCompoundDeterministicPlan handles 'remove the hero and add a CTA'", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = tryCompoundDeterministicPlan({
    session: "test-suite",
    message: "remove the hero and add a CTA",
    slug: "/",
    currentPage
  })
  assert.ok(plan, "should produce a plan")
  assert.equal(plan!.intent, "edit_plan")
  assert.ok(plan!.ops.length >= 2, "should have at least 2 ops")
  // Removes should come before adds
  const removeIndex = plan!.ops.findIndex(op => op.op === "remove_block")
  const addIndex = plan!.ops.findIndex(op => op.op === "add_block")
  assert.ok(removeIndex >= 0, "should have a remove op")
  assert.ok(addIndex >= 0, "should have an add op")
  assert.ok(removeIndex < addIndex, "remove ops should come before add ops")
})

test("tryCompoundDeterministicPlan handles 'add a FAQ and remove the CTA'", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = tryCompoundDeterministicPlan({
    session: "test-suite",
    message: "add a FAQ and remove the CTA",
    slug: "/",
    currentPage
  })
  assert.ok(plan, "should produce a plan")
  assert.equal(plan!.intent, "edit_plan")
  const removeOps = plan!.ops.filter(op => op.op === "remove_block")
  const addOps = plan!.ops.filter(op => op.op === "add_block")
  assert.ok(removeOps.length > 0, "should have remove ops")
  assert.ok(addOps.length > 0, "should have add ops")
})

test("tryCompoundDeterministicPlan returns null for non-compound messages", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = tryCompoundDeterministicPlan({
    session: "test-suite",
    message: "add a CTA",
    slug: "/",
    currentPage
  })
  assert.equal(plan, null)
})

test("tryCompoundDeterministicPlan returns null for 'add a FAQ section and make it about pricing' (not decomposable)", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = tryCompoundDeterministicPlan({
    session: "test-suite",
    message: "add a FAQ section and make it about pricing",
    slug: "/",
    currentPage
  })
  // "make it about pricing" is a content directive that isn't a different action verb,
  // so splitCompoundMessage should not split this
  assert.equal(plan, null)
})

test("tryCompoundDeterministicPlan merges summaries from both sub-plans", () => {
  const currentPage = demoPublishedPages()[0]
  const plan = tryCompoundDeterministicPlan({
    session: "test-suite",
    message: "delete the hero and add a FAQ",
    slug: "/",
    currentPage
  })
  assert.ok(plan, "should produce a plan")
  assert.ok(plan!.summary_for_user.length > 10, "summary should combine both sub-plan summaries")
})

// ---------------------------------------------------------------------------
// Block type case normalization
// ---------------------------------------------------------------------------

test("normalizePlanCandidate fixes lowercase 'hero' → 'Hero' in add_block block.type", () => {
  const plan = normalizePlanCandidate(
    {
      op: "add_block",
      block: { id: "b_hero_1", type: "hero", props: { heading: "Hello" } },
      pageSlug: "/",
      summary_for_user: "Added hero"
    },
    { defaultSlug: "/" }
  ) as any
  assert.strictEqual(plan.block.type, "Hero")
})

test("normalizePlanCandidate fixes 'google_map' → 'Embed' via inferBlockTypeFromText fallback", () => {
  const plan = normalizePlanCandidate(
    {
      op: "add_block",
      block: { id: "b_map_1", type: "google_map", props: {} },
      pageSlug: "/",
      summary_for_user: "Added map"
    },
    { defaultSlug: "/" }
  ) as any
  assert.strictEqual(plan.block.type, "Embed")
})

test("inferBlockTypeFromText maps 'map' and 'google_map' to Embed", () => {
  assert.strictEqual(inferBlockTypeFromText("map"), "Embed")
  assert.strictEqual(inferBlockTypeFromText("google_map"), "Embed")
  assert.strictEqual(inferBlockTypeFromText("GoogleMap"), "Embed")
})
