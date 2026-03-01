import test from "node:test"
import assert from "node:assert/strict"
import { demoPublishedPages, editPlanSchema } from "@ai-site-editor/shared"
import { app, buildCreatePagePlan, compileDeterministicPlan, normalizePlanCandidate } from "./index.js"
import { isLikelyClarificationFollowUp, parseCreatePageRequest } from "./nlp/intent-helpers.js"

test("parseCreatePageRequest prompt matrix", () => {
  const cases: Array<{ prompt: string; expected: string | null }> = [
    { prompt: "create new page /test2", expected: "/test2" },
    { prompt: "generate a new page /about-us", expected: "/about-us" },
    { prompt: "add new page about cherries", expected: "/cherries" },
    { prompt: "create page for startup founders", expected: "/for-startup-founders" },
    { prompt: "add a CTA corresponding to intent of this page", expected: null },
    { prompt: "improve this page", expected: null },
    { prompt: "delete this page", expected: null },
    { prompt: "rename this page to /banana", expected: null }
  ]

  for (const entry of cases) {
    assert.equal(parseCreatePageRequest(entry.prompt), entry.expected, entry.prompt)
  }
})

test("isLikelyClarificationFollowUp prompt matrix", () => {
  const positives = ["the selected one", "same", "this one", "the first", "it"]
  const negatives = ["create new page /test2", "remove page /pricing", "add faq section", "change heading to hello world"]
  for (const prompt of positives) assert.equal(isLikelyClarificationFollowUp(prompt), true, prompt)
  for (const prompt of negatives) assert.equal(isLikelyClarificationFollowUp(prompt), false, prompt)
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
