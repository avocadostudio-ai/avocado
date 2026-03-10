import test from "node:test"
import assert from "node:assert/strict"
import { demoPublishedPages, editPlanSchema } from "@ai-site-editor/shared"
import { app, buildCreatePagePlan, compileDeterministicPlan, normalizePlanCandidate } from "./index.js"
import { isLikelyClarificationFollowUp, parseCreatePageRequest, parseDuplicatePageRequest, requestsContentGeneration } from "./nlp/intent-helpers.js"
import { isBatchAddRequest, isBatchRemoveRequest, extractMentionedBlockTypes, isAdviceQuery } from "./nlp/intent-detection.js"
import { extractAudienceTarget, extractAudienceTargets, inferAddedBlockTypeFromMessage, inferDeterministicIntent, isHighConfidenceDeterministicCase, childSuggestions, clarificationSuggestions, postEditSuggestions, humanizeArrayPath } from "./nlp/deterministic-planner.js"
import { inferBlockTypeFromText } from "./nlp/plan-normalizer.js"
import { findFullPageTranslationCoverageGap, inferTranslationScopeFromMessage, sanitizeMessageForPlanning } from "./chat/chat-pipeline.js"

test("parseCreatePageRequest prompt matrix", () => {
  const cases: Array<{ prompt: string; expected: string | null }> = [
    { prompt: "create new page /test2", expected: "/test2" },
    { prompt: "generate a new page /about-us", expected: "/about-us" },
    { prompt: "add new page about cherries", expected: "/cherries" },
    { prompt: "create page for startup founders", expected: "/for-startup-founders" },
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
  for (const prompt of positives) assert.equal(requestsContentGeneration(prompt), true, prompt)
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
  // Negative: single block update should not trigger
  assert.equal(isBatchAddRequest("update the hero heading"), false)
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
