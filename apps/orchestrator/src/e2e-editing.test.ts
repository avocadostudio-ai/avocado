import test, { describe } from "node:test"
import assert from "node:assert/strict"
import { app } from "./index.js"
import type { PageDoc, BlockInstance } from "@ai-site-editor/shared"
import { setPage, scopedSessionKey } from "./state/session-state.js"
import { RICH_PAGES } from "./eval/eval-fixture.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SITE_ID = "e2e-test"
const E2E_PROVIDER = (() => {
  const raw = (process.env.E2E_CHAT_PROVIDER ?? "openai").trim().toLowerCase()
  if (raw === "anthropic") return "anthropic" as const
  if (raw === "gemini") return "gemini" as const
  return "openai" as const
})()
const E2E_MODEL_KEY = (process.env.E2E_CHAT_MODEL_KEY ?? "balanced").trim()
const E2E_PROVIDER_AVAILABLE =
  E2E_PROVIDER === "anthropic" ? Boolean(process.env.ANTHROPIC_API_KEY?.trim())
  : E2E_PROVIDER === "gemini" ? Boolean(process.env.GOOGLE_GENAI_API_KEY?.trim())
  : Boolean(process.env.OPENAI_API_KEY?.trim())
const E2E_DESCRIBE_OPTIONS = { timeout: 120_000, skip: !E2E_PROVIDER_AVAILABLE }
let sessionCounter = 0
const bootstrappedSessions = new Set<string>()

function newSession() {
  return `e2e-${++sessionCounter}`
}

type ChatOpts = {
  executionMode?: "auto" | "plan_only" | "apply_pending_plan"
  pendingPlanId?: string
}

async function ensureSessionBootstrapped(session: string) {
  if (bootstrappedSessions.has(session)) return
  const res = await app.inject({
    method: "POST",
    url: "/draft/bootstrap",
    payload: {
      session,
      siteId: SITE_ID,
      pages: RICH_PAGES,
    },
  })
  assert.equal(res.statusCode, 200, `bootstrap failed: ${res.statusCode}`)
  const body = res.json() as { status?: string; slugs?: string[] }
  assert.ok(body.status === "bootstrapped" || body.status === "skipped", `bootstrap status=${body.status}`)
  const slugs = body.slugs ?? []
  assert.ok(slugs.length >= 8, `expected >=8 bootstrapped pages, got ${slugs.length}`)
  bootstrappedSessions.add(session)
}

async function chat(session: string, slug: string, message: string, opts: ChatOpts = {}) {
  await ensureSessionBootstrapped(session)
  const res = await app.inject({
    method: "POST",
    url: "/chat",
    payload: {
      session,
      siteId: SITE_ID,
      slug,
      message,
      provider: E2E_PROVIDER,
      modelKey: E2E_MODEL_KEY,
      executionMode: opts.executionMode ?? "auto",
      ...(opts.pendingPlanId ? { pendingPlanId: opts.pendingPlanId } : {}),
    },
  })
  return { status: res.statusCode, body: res.json() }
}

async function getDraft(session: string, slug: string): Promise<PageDoc> {
  await ensureSessionBootstrapped(session)
  const res = await app.inject({
    method: "GET",
    url: `/draft/pages?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(SITE_ID)}&slug=${encodeURIComponent(slug)}`,
  })
  assert.equal(res.statusCode, 200, `getDraft(${slug}) returned ${res.statusCode}`)
  return res.json() as PageDoc
}

async function getDraftSlugs(session: string): Promise<string[]> {
  await ensureSessionBootstrapped(session)
  const res = await app.inject({
    method: "GET",
    url: `/draft/slugs?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(SITE_ID)}`,
  })
  assert.equal(res.statusCode, 200)
  return (res.json() as { slugs: string[] }).slugs
}

async function getResultPlannerTiers(session: string): Promise<string[]> {
  const scoped = scopedSessionKey(session, SITE_ID)
  const res = await app.inject({
    method: "GET",
    url: `/telemetry/chat?session=${encodeURIComponent(scoped)}&phase=result&limit=200`,
  })
  assert.equal(res.statusCode, 200)
  const payload = res.json() as { rows?: Array<{ plannerTier?: string }> }
  return (payload.rows ?? []).map((row) => row.plannerTier ?? "").filter(Boolean)
}

async function assertUsedLlmPlannerTier(session: string) {
  const tiers = await getResultPlannerTiers(session)
  assert.ok(
    tiers.some((tier) => tier === "full_llm" || tier === "llm_intent_router"),
    `expected LM planner tier, got: ${JSON.stringify(tiers)}`,
  )
}

function findBlock(page: PageDoc, predicate: (b: BlockInstance) => boolean) {
  return page.blocks.find(predicate)
}

function blockProps(block: BlockInstance | undefined) {
  return (block?.props ?? {}) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// E2E Tests — real provider API calls, no mocks
// ---------------------------------------------------------------------------

describe(`e2e-editing (${E2E_PROVIDER}/${E2E_MODEL_KEY})`, E2E_DESCRIBE_OPTIONS, () => {

  // 1. Simple text edit
  test("1. Simple text edit — change hero heading", async () => {
    const session = newSession()
    const targetHeading = "Fresh Avocado Stories Every Day"
    const { body } = await chat(session, "/", `Change the hero heading to '${targetHeading}'`)
    assert.equal(body.status, "applied", `expected applied, got ${body.status}: ${body.summary}`)

    const page = await getDraft(session, "/")
    const hero = findBlock(page, (b) => b.type === "Hero")
    assert.ok(hero, "hero block not found")
    assert.equal(blockProps(hero).heading, targetHeading)
  })

  // 2. Multi-field update
  test("2. Multi-field update — hero subheading + CTA text", async () => {
    const session = newSession()
    const { body } = await chat(
      session,
      "/",
      "Update the hero: set the subheading to 'Discover recipes, tips, and tales' and change the CTA button text to 'Start Reading'",
    )
    assert.equal(body.status, "applied", `expected applied, got ${body.status}: ${body.summary}`)

    const page = await getDraft(session, "/")
    const hero = findBlock(page, (b) => b.type === "Hero")
    assert.ok(hero, "hero block not found")
    const props = blockProps(hero)
    assert.equal(props.subheading, "Discover recipes, tips, and tales")
    assert.equal(props.ctaText, "Start Reading")
  })

  // 3. Add a new block
  test("3. Add a new block — testimonials section", async () => {
    const session = newSession()
    // Snapshot original block count
    const before = await getDraft(session, "/")
    const originalCount = before.blocks.length

    const { body } = await chat(
      session,
      "/",
      "Add a testimonials section after the features grid with the title 'What Our Readers Say'",
    )
    assert.equal(body.status, "applied", `expected applied, got ${body.status}: ${body.summary}`)

    const page = await getDraft(session, "/")
    assert.ok(page.blocks.length > originalCount, `expected more blocks, got ${page.blocks.length} (was ${originalCount})`)
    const testimonials = findBlock(page, (b) => b.type === "Testimonials")
    assert.ok(testimonials, "Testimonials block not found")
    const title = String(blockProps(testimonials).title)
    assert.ok(/reader|customer|testimonial|say/i.test(title), `Testimonials title should be relevant, got: ${title}`)
  })

  // 4. Add list item
  test("4. Add list item — new FAQ question", async () => {
    const session = newSession()
    const before = await getDraft(session, "/about-us")
    const faqBefore = findBlock(before, (b) => b.type === "FAQAccordion")
    assert.ok(faqBefore, "FAQAccordion block not found before edit")
    const itemsBefore = (blockProps(faqBefore).items as unknown[]) ?? []

    const { body } = await chat(
      session,
      "/about-us",
      "Add a new FAQ question: 'Do you offer a free trial?' with the answer 'Yes, all plans include a 14-day free trial'",
    )
    assert.equal(body.status, "applied", `expected applied, got ${body.status}: ${body.summary}`)

    const page = await getDraft(session, "/about-us")
    const faq = findBlock(page, (b) => b.type === "FAQAccordion")
    assert.ok(faq, "FAQAccordion block not found after edit")
    const items = blockProps(faq).items as Array<{ q: string; a: string }>
    assert.ok(items.length > itemsBefore.length, `expected more items, got ${items.length} (was ${itemsBefore.length})`)
    const added = items.find((item) => /free trial/i.test(item.q))
    assert.ok(added, "new FAQ item not found")
    assert.ok(/14-day/i.test(added.a), `answer should mention 14-day, got: ${added.a}`)
  })

  // 5. Remove a block
  test("5. Remove a block — CTA section", async () => {
    const session = newSession()
    const before = await getDraft(session, "/")
    assert.ok(
      findBlock(before, (b) => b.id === "b_cta_home"),
      "CTA block should exist before removal",
    )

    const { body } = await chat(session, "/", "Remove the call-to-action section from this page")
    assert.equal(body.status, "applied", `expected applied, got ${body.status}: ${body.summary}`)

    const page = await getDraft(session, "/")
    assert.ok(
      !findBlock(page, (b) => b.id === "b_cta_home"),
      "CTA block should be gone after removal",
    )
    assert.ok(page.blocks.length < before.blocks.length, "block count should have decreased")
  })

  // 6. Create a new page
  test("6. Create a new page — /about", async () => {
    const session = newSession()
    const { body } = await chat(
      session,
      "/",
      "Create a new About page at /about with a hero titled 'About Us' and a RichText block explaining our mission",
    )
    assert.equal(body.status, "applied", `expected applied, got ${body.status}: ${body.summary}`)

    const slugs = await getDraftSlugs(session)
    assert.ok(slugs.includes("/about"), `/about should be in slugs: ${JSON.stringify(slugs)}`)

    const page = await getDraft(session, "/about")
    const hero = findBlock(page, (b) => b.type === "Hero")
    assert.ok(hero, "Hero block expected on /about")
    assert.ok(/about us/i.test(String(blockProps(hero).heading)), `hero heading should say About Us, got: ${blockProps(hero).heading}`)
    const richText = findBlock(page, (b) => b.type === "RichText")
    assert.ok(richText, "RichText block expected on /about")
  })

  // 7. Rename a page
  test("7. Rename a page — /about-lemons to /lemons", async () => {
    const session = newSession()
    const { body } = await chat(
      session,
      "/about-lemons",
      "Rename this page to /lemons and update its title to 'All About Lemons'",
    )
    assert.equal(body.status, "applied", `expected applied, got ${body.status}: ${body.summary}`)

    const slugs = await getDraftSlugs(session)
    assert.ok(!slugs.includes("/about-lemons"), `/about-lemons should be gone: ${JSON.stringify(slugs)}`)
    assert.ok(slugs.includes("/lemons"), `/lemons should be present: ${JSON.stringify(slugs)}`)

    const page = await getDraft(session, "/lemons")
    assert.ok(/lemons/i.test(page.title), `page title should contain 'Lemons', got: ${page.title}`)
  })

  // 8. Duplicate a block
  test("8. Duplicate a block — features grid", async () => {
    const session = newSession()
    const before = await getDraft(session, "/")
    const fgBefore = before.blocks.filter((b) => b.type === "FeatureGrid")
    assert.equal(fgBefore.length, 1, "should start with 1 FeatureGrid")

    const { body } = await chat(session, "/", "Duplicate the features grid on this page")
    assert.equal(body.status, "applied", `expected applied, got ${body.status}: ${body.summary}`)

    const page = await getDraft(session, "/")
    const fgAfter = page.blocks.filter((b) => b.type === "FeatureGrid")
    assert.equal(fgAfter.length, 2, `expected 2 FeatureGrid blocks, got ${fgAfter.length}`)
    assert.notEqual(fgAfter[0].id, fgAfter[1].id, "duplicated blocks should have different IDs")
  })

  // 9. Undo after edit
  test("9. Undo after edit — reverts hero heading", async () => {
    const session = newSession()
    // Read original heading
    const original = await getDraft(session, "/")
    const originalHeading = blockProps(findBlock(original, (b) => b.type === "Hero")!).heading

    // Make an edit
    const { body } = await chat(session, "/", "Change the hero heading to 'Temporary Heading'")
    assert.equal(body.status, "applied", `expected applied, got ${body.status}: ${body.summary}`)

    // Verify the edit stuck
    const edited = await getDraft(session, "/")
    assert.equal(blockProps(findBlock(edited, (b) => b.type === "Hero")!).heading, "Temporary Heading")

    // Undo
    const undoRes = await app.inject({
      method: "POST",
      url: "/history/undo",
      payload: { session, siteId: SITE_ID, slug: "/" },
    })
    assert.equal(undoRes.statusCode, 200)
    assert.equal((undoRes.json() as { status: string }).status, "applied")

    // Verify heading reverted
    const reverted = await getDraft(session, "/")
    const revertedHeading = blockProps(findBlock(reverted, (b) => b.type === "Hero")!).heading
    assert.equal(revertedHeading, originalHeading, `heading should revert to "${originalHeading}", got "${revertedHeading}"`)
  })

  // 10. Plan-only then apply
  test("10. Plan-only then apply — add Stats section", async () => {
    const session = newSession()

    // Step 1: plan_only
    const planRes = await chat(
      session,
      "/",
      "Add a Stats section to the home page with three stats: '500+ Recipes', '50k Readers', '4.9 Rating'",
      { executionMode: "plan_only" },
    )
    assert.equal(planRes.body.status, "plan_ready", `expected plan_ready, got ${planRes.body.status}: ${planRes.body.summary}`)
    assert.ok(planRes.body.pendingPlanId, "pendingPlanId should be present")

    // Step 2: apply_pending_plan
    const applyRes = await chat(session, "/", "", {
      executionMode: "apply_pending_plan",
      pendingPlanId: planRes.body.pendingPlanId,
    })
    assert.equal(applyRes.body.status, "applied", `expected applied, got ${applyRes.body.status}: ${applyRes.body.summary}`)

    // Verify Stats block in draft
    const page = await getDraft(session, "/")
    const statsBlock = findBlock(page, (b) => b.type === "Stats")
    assert.ok(statsBlock, "Stats block should exist in draft")
    const statsItems = (blockProps(statsBlock).stats ?? blockProps(statsBlock).items) as Array<{ value: string }>
    assert.ok(Array.isArray(statsItems), "Stats items should be an array")
    assert.ok(statsItems.length >= 3, `expected at least 3 stats items, got ${statsItems.length}`)
  })
})

// RICH_PAGES imported from eval/eval-fixture.ts (single source of truth)

/** Seed a session with the avocado-magic site data (8 pages) */
function seedRichSite(session: string) {
  const scoped = scopedSessionKey(session, SITE_ID)
  for (const page of RICH_PAGES) {
    setPage(scoped, structuredClone(page))
  }
}

// ---------------------------------------------------------------------------
// Tests 11–21 — complex real-life prompts against the rich avocado-magic site
// ---------------------------------------------------------------------------

describe(`e2e-editing-rich (${E2E_PROVIDER}/${E2E_MODEL_KEY})`, E2E_DESCRIBE_OPTIONS, () => {

  // 11. Multi-step conversation — two edits in the same session
  test("11. Multi-step conversation — edit hero then edit CTA in same session", async () => {
    const session = newSession()
    seedRichSite(session)

    // First edit: change hero heading
    const r1 = await chat(session, "/", "Change the hero heading to 'Avocado Paradise'")
    assert.equal(r1.body.status, "applied", `step 1: ${r1.body.status}: ${r1.body.summary}`)

    const after1 = await getDraft(session, "/")
    assert.equal(blockProps(findBlock(after1, (b) => b.type === "Hero")!).heading, "Avocado Paradise")

    // Second edit (same session): change CTA text
    const r2 = await chat(session, "/", "Change the CTA button text to 'Join Now'")
    assert.equal(r2.body.status, "applied", `step 2: ${r2.body.status}: ${r2.body.summary}`)

    const after2 = await getDraft(session, "/")
    // Hero heading from step 1 should persist
    assert.equal(blockProps(findBlock(after2, (b) => b.type === "Hero")!).heading, "Avocado Paradise")
    // CTA should be updated
    const cta = findBlock(after2, (b) => b.type === "CTA")
    assert.ok(cta, "CTA block should exist")
    assert.equal(blockProps(cta).ctaText, "Join Now")
  })

  // 12. Ambiguous block reference — "update the second section"
  test("12. Ordinal block reference — change title of the second section", async () => {
    const session = newSession()
    seedRichSite(session)

    const { body } = await chat(
      session, "/",
      "Change the title of the second section to 'Our Avocado Adventures'",
    )
    assert.equal(body.status, "applied", `${body.status}: ${body.summary}`)

    const page = await getDraft(session, "/")
    // The second section (after Hero) is CardGrid — its title should be updated
    const cardGrid = findBlock(page, (b) => b.type === "CardGrid")
    assert.ok(cardGrid, "CardGrid block should exist")
    const title = String(blockProps(cardGrid).title)
    assert.ok(
      /avocado adventure/i.test(title),
      `CardGrid title should contain 'Avocado Adventures', got: ${title}`,
    )
  })

  // 13. Remove a list item — "delete the first FAQ"
  test("13. Remove a list item — delete first FAQ on /strawberries", async () => {
    const session = newSession()
    seedRichSite(session)

    const before = await getDraft(session, "/strawberries")
    const faqBefore = findBlock(before, (b) => b.type === "FAQAccordion")
    assert.ok(faqBefore, "FAQAccordion should exist before edit")
    const itemsBefore = blockProps(faqBefore).items as Array<{ q: string }>
    assert.equal(itemsBefore.length, 3, "should start with 3 FAQ items")
    const firstQ = itemsBefore[0].q

    const { body } = await chat(
      session, "/strawberries",
      "Remove the first question from the FAQ section",
    )
    assert.equal(body.status, "applied", `${body.status}: ${body.summary}`)

    const page = await getDraft(session, "/strawberries")
    const faq = findBlock(page, (b) => b.type === "FAQAccordion")
    assert.ok(faq, "FAQAccordion should exist after edit")
    const itemsAfter = blockProps(faq).items as Array<{ q: string }>
    assert.ok(itemsAfter.length < itemsBefore.length, `expected fewer items, got ${itemsAfter.length} (was ${itemsBefore.length})`)
    // The first item should no longer be present
    assert.ok(
      !itemsAfter.some((item) => item.q === firstQ),
      `first question '${firstQ}' should be removed`,
    )
  })

  // 14. Move a block — "move CTA to the top"
  test("14. Move a block — move CTA to the top on /strawberries", async () => {
    const session = newSession()
    seedRichSite(session)

    const before = await getDraft(session, "/strawberries")
    const ctaBefore = findBlock(before, (b) => b.type === "CTA")
    assert.ok(ctaBefore, "CTA should exist")
    const ctaIdx = before.blocks.findIndex((b) => b.type === "CTA")
    assert.ok(ctaIdx > 0, `CTA should not already be at top, index=${ctaIdx}`)

    const { body } = await chat(
      session, "/strawberries",
      "Move the call-to-action section to the top of the page",
    )
    assert.equal(body.status, "applied", `${body.status}: ${body.summary}`)

    const page = await getDraft(session, "/strawberries")
    const ctaAfterIdx = page.blocks.findIndex((b) => b.type === "CTA")
    assert.ok(ctaAfterIdx >= 0, "CTA should still exist")
    assert.ok(ctaAfterIdx < ctaIdx, `CTA should have moved up: was index ${ctaIdx}, now ${ctaAfterIdx}`)
  })

  // 15. Vague/natural phrasing — "make the hero more exciting"
  test("15. Vague rewrite — make the hero more exciting", async () => {
    const session = newSession()
    seedRichSite(session)

    const before = await getDraft(session, "/bananas")
    const heroBefore = findBlock(before, (b) => b.type === "Hero")!
    const headingBefore = String(blockProps(heroBefore).heading)
    const subBefore = String(blockProps(heroBefore).subheading)

    const { body } = await chat(
      session, "/bananas",
      "Make the hero section more exciting and energetic",
    )
    assert.equal(body.status, "applied", `${body.status}: ${body.summary}`)

    const page = await getDraft(session, "/bananas")
    const hero = findBlock(page, (b) => b.type === "Hero")!
    const headingAfter = String(blockProps(hero).heading)
    const subAfter = String(blockProps(hero).subheading)
    // At least one of heading or subheading should have changed
    const changed = headingAfter !== headingBefore || subAfter !== subBefore
    assert.ok(changed, `hero should have been rewritten. heading: "${headingBefore}" → "${headingAfter}", sub: "${subBefore}" → "${subAfter}"`)
  })

  // 16. Typo in block name — "remove the testomonials"
  test("16. Typo tolerance — remove the testomonials section", async () => {
    const session = newSession()
    seedRichSite(session)

    const before = await getDraft(session, "/")
    assert.ok(findBlock(before, (b) => b.type === "Testimonials"), "Testimonials should exist before")

    const { body } = await chat(session, "/", "remove the testomonials section")
    assert.equal(body.status, "applied", `${body.status}: ${body.summary}`)

    const page = await getDraft(session, "/")
    assert.ok(
      !findBlock(page, (b) => b.type === "Testimonials"),
      "Testimonials should be gone after removal (despite typo)",
    )
  })

  // 17. Typo in action + sloppy phrasing — "ad a fetures section"
  test("17. Typo tolerance — ad a fetures section with 3 items", async () => {
    const session = newSession()
    seedRichSite(session)

    const before = await getDraft(session, "/oranges")
    const fgBefore = before.blocks.filter((b) => b.type === "FeatureGrid")
    assert.equal(fgBefore.length, 0, "oranges should not have FeatureGrid initially")

    const { body } = await chat(session, "/oranges", "ad a fetures section with 3 items")
    assert.equal(body.status, "applied", `${body.status}: ${body.summary}`)

    const page = await getDraft(session, "/oranges")
    const fg = findBlock(page, (b) => b.type === "FeatureGrid")
    assert.ok(fg, "FeatureGrid should be added despite typos ('ad', 'fetures')")
    const features = blockProps(fg).features as unknown[]
    assert.ok(Array.isArray(features), "features should be an array")
    assert.ok(features.length >= 2, `expected at least 2 features, got ${features.length}`)
  })

  // 18. Abbreviated/informal prompt — "put a cta at the bottom"
  test("18. Informal phrasing — put a cta at the bottom", async () => {
    const session = newSession()
    seedRichSite(session)

    const before = await getDraft(session, "/cherries")
    const ctaBefore = before.blocks.filter((b) => b.type === "CTA")
    assert.equal(ctaBefore.length, 0, "cherries should not have CTA initially")

    const { body } = await chat(session, "/cherries", "put a cta at the bottom")
    assert.equal(body.status, "applied", `${body.status}: ${body.summary}`)

    const page = await getDraft(session, "/cherries")
    const cta = findBlock(page, (b) => b.type === "CTA")
    assert.ok(cta, "CTA block should be added (informal 'put a cta')")
    // Should be near the bottom
    const ctaIdx = page.blocks.findIndex((b) => b.type === "CTA")
    assert.ok(
      ctaIdx >= page.blocks.length - 2,
      `CTA should be near bottom, index=${ctaIdx} of ${page.blocks.length}`,
    )
  })

  // 19. Delete a page
  test("19. Delete a page — /olives", async () => {
    const session = newSession()
    seedRichSite(session)

    const slugsBefore = await getDraftSlugs(session)
    assert.ok(slugsBefore.includes("/olives"), `/olives should exist before: ${JSON.stringify(slugsBefore)}`)

    const { body } = await chat(session, "/olives", "Delete this page")
    assert.equal(body.status, "applied", `${body.status}: ${body.summary}`)

    const slugsAfter = await getDraftSlugs(session)
    assert.ok(!slugsAfter.includes("/olives"), `/olives should be gone: ${JSON.stringify(slugsAfter)}`)
  })

  // 20. Duplicate a page
  test("20. Duplicate a page — /bananas to /plantains", async () => {
    const session = newSession()
    seedRichSite(session)

    const { body } = await chat(session, "/bananas", "Duplicate /bananas to /plantains")
    assert.equal(body.status, "applied", `${body.status}: ${body.summary}`)

    const slugs = await getDraftSlugs(session)
    assert.ok(slugs.includes("/plantains"), `/plantains should exist: ${JSON.stringify(slugs)}`)
    assert.ok(slugs.includes("/bananas"), `/bananas should still exist: ${JSON.stringify(slugs)}`)

    const original = await getDraft(session, "/bananas")
    const duplicate = await getDraft(session, "/plantains")
    // Duplicate should have similar block structure
    assert.ok(
      duplicate.blocks.length >= original.blocks.length,
      `duplicate should have at least as many blocks: got ${duplicate.blocks.length} vs original ${original.blocks.length}`,
    )
    // Should have a hero
    const hero = findBlock(duplicate, (b) => b.type === "Hero")
    assert.ok(hero, "duplicated page should have Hero block")
  })

  // 21. Batch add — multiple blocks at once
  test("21. Batch add — add testimonials and CTA to /about-us", async () => {
    const session = newSession()
    seedRichSite(session)

    const before = await getDraft(session, "/about-us")
    const blockCountBefore = before.blocks.length

    const { body } = await chat(
      session, "/about-us",
      "Add a testimonials section and a CTA section to the bottom of this page",
    )
    assert.equal(body.status, "applied", `${body.status}: ${body.summary}`)

    const page = await getDraft(session, "/about-us")
    assert.ok(page.blocks.length > blockCountBefore, `expected more blocks: got ${page.blocks.length} (was ${blockCountBefore})`)
    // At least 1 of the 2 requested block types should be present
    const hasType = (t: string) => page.blocks.some((b) => b.type === t)
    const addedTypes = [hasType("Testimonials"), hasType("CTA")].filter(Boolean).length
    assert.ok(addedTypes >= 1, `expected at least 1 of 2 requested block types, got ${addedTypes}`)
  })

  // 22. LM-heavy rewrite with constraints
  test("22. Voice rewrite with constraints — concise hero + no cliches", async () => {
    const session = newSession()
    seedRichSite(session)
    const { body } = await chat(
      session,
      "/bananas",
      "Rewrite the hero so it sounds confident and modern. Keep heading under 8 words, avoid cliches like 'unlock' or 'journey', keep CTA intact.",
    )
    assert.equal(body.status, "applied", `${body.status}: ${body.summary}`)
    const page = await getDraft(session, "/bananas")
    const hero = findBlock(page, (b) => b.type === "Hero")
    assert.ok(hero, "hero should exist")
    const heading = String(blockProps(hero).heading ?? "")
    assert.ok(heading.split(/\s+/).filter(Boolean).length <= 8, `heading should be <=8 words, got: "${heading}"`)
    assert.ok(!/\bunlock\b|\bjourney\b/i.test(heading), `heading should avoid banned cliches, got: "${heading}"`)
    await assertUsedLlmPlannerTier(session)
  })

  // 23. Multi-op semantic transformation
  test("23. Transform rich text into scannable benefits section", async () => {
    const session = newSession()
    seedRichSite(session)
    const before = await getDraft(session, "/oranges")
    const beforeRich = findBlock(before, (b) => b.type === "RichText")
    const beforeBody = String(blockProps(beforeRich).body ?? "")
    const { body } = await chat(
      session,
      "/oranges",
      "Refactor the existing rich-text body into exactly three concise benefit bullets, each starting with an action verb. Keep the same title and do not add new blocks.",
    )
    assert.equal(body.status, "applied", `${body.status}: ${body.summary}`)
    const page = await getDraft(session, "/oranges")
    const rich = findBlock(page, (b) => b.type === "RichText")
    assert.ok(rich, "rich text should exist")
    const bodyText = String(blockProps(rich).body ?? "")
    const hasBullets = /^\s*[-*]\s+/m.test(bodyText)
    const bodyChanged = bodyText !== beforeBody
    const blockCountIncreased = page.blocks.length > before.blocks.length
    assert.ok(
      hasBullets || bodyChanged || blockCountIncreased,
      "expected content transformation (body rewrite and/or added supporting block)",
    )
  })

  // 24. Cross-block consistency edit
  test("24. Cross-block consistency — align CTA language across page", async () => {
    const session = newSession()
    seedRichSite(session)
    const before = await getDraft(session, "/")
    const ctaBefore = findBlock(before, (b) => b.type === "CTA")
    const ctaTextBefore = String(blockProps(ctaBefore).ctaText ?? "")
    const { body } = await chat(
      session,
      "/",
      "Rewrite both CTA labels on this page so they are consistent and action-oriented: hero CTA should invite exploring, footer CTA should invite joining. Keep all links unchanged and avoid exclamation marks.",
    )
    assert.ok(
      body.status === "applied" || body.status === "needs_clarification",
      `unexpected status: ${body.status} (${body.summary})`,
    )
    if (body.status === "applied") {
      const page = await getDraft(session, "/")
      const cta = findBlock(page, (b) => b.type === "CTA")
      assert.ok(cta, "CTA block should exist")
      const ctaText = String(blockProps(cta).ctaText ?? "")
      assert.ok(!/!/.test(ctaText), `CTA text should not include exclamation mark, got: ${ctaText}`)
      assert.notEqual(ctaText, ctaTextBefore, "CTA text should change when edit is applied")
    } else {
      assert.ok(/clarify|which|confirm|cta/i.test(String(body.summary ?? "")), `unexpected clarification summary: ${body.summary}`)
    }
    await assertUsedLlmPlannerTier(session)
  })

  // 25. Ambiguous request requiring semantic block targeting
  test("25. Ambiguous target — clarification or direct disambiguation", async () => {
    const session = newSession()
    seedRichSite(session)
    const before = await getDraft(session, "/")
    const beforeCard = findBlock(before, (b) => b.type === "CardGrid")
    const beforeTitle = String(blockProps(beforeCard).title ?? "")
    const { body } = await chat(
      session,
      "/",
      "Make the second section title more premium and less generic, and tighten that section's copy.",
    )
    assert.ok(
      body.status === "needs_clarification" || body.status === "applied",
      `unexpected status: ${body.status} (${body.summary})`,
    )
    if (body.status === "needs_clarification") {
      assert.ok(/second section|confirm|clarify/i.test(String(body.summary ?? "")), `unexpected clarification summary: ${body.summary}`)
    } else {
      const after = await getDraft(session, "/")
      const afterCard = findBlock(after, (b) => b.type === "CardGrid")
      const afterTitle = String(blockProps(afterCard).title ?? "")
      assert.notEqual(afterTitle, beforeTitle, "CardGrid title should change when edit is directly applied")
    }
    await assertUsedLlmPlannerTier(session)
  })

  // 26. Multi-turn style carry-over
  test("26. Multi-turn style carry-over across edits", async () => {
    const session = newSession()
    seedRichSite(session)
    const r1 = await chat(
      session,
      "/cherries",
      "Rewrite the hero in a crisp, expert tone for health-conscious readers.",
    )
    assert.equal(r1.body.status, "applied", `${r1.body.status}: ${r1.body.summary}`)
    const r2 = await chat(
      session,
      "/cherries",
      "Now update the rich text intro to match that same tone, keep it under 2 sentences.",
    )
    assert.equal(r2.body.status, "applied", `${r2.body.status}: ${r2.body.summary}`)
    const page = await getDraft(session, "/cherries")
    const rich = findBlock(page, (b) => b.type === "RichText")
    assert.ok(rich, "RichText should exist")
    const text = String(blockProps(rich).body ?? "")
    const sentences = text.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean)
    assert.ok(sentences.length <= 2, `expected <=2 sentences, got ${sentences.length}: ${text}`)
    await assertUsedLlmPlannerTier(session)
  })

  // 27. Noisy instruction parsing with semantic constraints
  test("27. Noisy prompt — mixed shorthand and constraints", async () => {
    const session = newSession()
    seedRichSite(session)
    const { body } = await chat(
      session,
      "/about-us",
      "k, pls make hero less corp-y, more human. keep CTA link same. also trim subheading by ~30%, thx",
    )
    assert.equal(body.status, "applied", `${body.status}: ${body.summary}`)
    const page = await getDraft(session, "/about-us")
    const hero = findBlock(page, (b) => b.type === "Hero")
    assert.ok(hero, "Hero should exist")
    const props = blockProps(hero)
    assert.equal(props.ctaHref, "/about-us", "CTA link should stay unchanged")
    await assertUsedLlmPlannerTier(session)
  })
})
