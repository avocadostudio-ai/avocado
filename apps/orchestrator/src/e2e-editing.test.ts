import test, { describe } from "node:test"
import assert from "node:assert/strict"
import { app } from "./index.js"
import type { PageDoc, BlockInstance } from "@ai-site-editor/shared"
import { setPage, scopedSessionKey } from "./state/session-state.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SITE_ID = "e2e-test"
const E2E_PROVIDER = ((process.env.E2E_CHAT_PROVIDER ?? "openai").trim().toLowerCase() === "anthropic" ? "anthropic" : "openai")
const E2E_MODEL_KEY = (process.env.E2E_CHAT_MODEL_KEY ?? "balanced").trim()
const E2E_PROVIDER_AVAILABLE =
  E2E_PROVIDER === "anthropic" ? Boolean(process.env.ANTHROPIC_API_KEY?.trim()) : Boolean(process.env.OPENAI_API_KEY?.trim())
const E2E_DESCRIBE_OPTIONS = { timeout: 120_000, skip: !E2E_PROVIDER_AVAILABLE }
let sessionCounter = 0

function newSession() {
  return `e2e-${++sessionCounter}`
}

type ChatOpts = {
  executionMode?: "auto" | "plan_only" | "apply_pending_plan"
  pendingPlanId?: string
}

async function chat(session: string, slug: string, message: string, opts: ChatOpts = {}) {
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
  const res = await app.inject({
    method: "GET",
    url: `/draft/pages?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(SITE_ID)}&slug=${encodeURIComponent(slug)}`,
  })
  assert.equal(res.statusCode, 200, `getDraft(${slug}) returned ${res.statusCode}`)
  return res.json() as PageDoc
}

async function getDraftSlugs(session: string): Promise<string[]> {
  const res = await app.inject({
    method: "GET",
    url: `/draft/slugs?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(SITE_ID)}`,
  })
  assert.equal(res.statusCode, 200)
  return (res.json() as { slugs: string[] }).slugs
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
    const before = await getDraft(session, "/pricing")
    const faqBefore = findBlock(before, (b) => b.type === "FAQAccordion")
    assert.ok(faqBefore, "FAQAccordion block not found before edit")
    const itemsBefore = (blockProps(faqBefore).items as unknown[]) ?? []

    const { body } = await chat(
      session,
      "/pricing",
      "Add a new FAQ question: 'Do you offer a free trial?' with the answer 'Yes, all plans include a 14-day free trial'",
    )
    assert.equal(body.status, "applied", `expected applied, got ${body.status}: ${body.summary}`)

    const page = await getDraft(session, "/pricing")
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
  test("7. Rename a page — /pricing to /plans", async () => {
    const session = newSession()
    const { body } = await chat(
      session,
      "/pricing",
      "Rename this page to /plans and update its title to 'Our Plans'",
    )
    assert.equal(body.status, "applied", `expected applied, got ${body.status}: ${body.summary}`)

    const slugs = await getDraftSlugs(session)
    assert.ok(!slugs.includes("/pricing"), `/pricing should be gone: ${JSON.stringify(slugs)}`)
    assert.ok(slugs.includes("/plans"), `/plans should be present: ${JSON.stringify(slugs)}`)

    const page = await getDraft(session, "/plans")
    assert.ok(/plans/i.test(page.title), `page title should contain 'Plans', got: ${page.title}`)
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

// ---------------------------------------------------------------------------
// Rich site fixture — based on real "avocado-magic" site with 8 pages
// ---------------------------------------------------------------------------

const RICH_PAGES: PageDoc[] = [
  {
    id: "p_home", slug: "/", title: "Home", updatedAt: "2026-03-03T22:46:56.033Z",
    blocks: [
      { id: "b_hero_home_rich", type: "Hero", props: { heading: "Discover the Magic of Avocados", subheading: "Experience the vibrant taste and health benefits of our avocados — a delightful addition to any dish.", ctaText: "Get Started", ctaHref: "/", imageUrl: "/hero-generated.svg", imageAlt: "Avocados in natural light" } },
      { id: "b_cardgrid_home", type: "CardGrid", props: { title: "Sustainable Avocado Adventures", cards: [{ title: "Avocado Culinary Delights", description: "Uncover new culinary uses for avocados.", ctaText: "Try Now", ctaHref: "/avocado-culinary" }, { title: "Avocado Wellness", description: "Explore the wellness benefits of avocados.", ctaText: "Discover", ctaHref: "/avocado-wellness" }, { title: "Avocado Sustainability", description: "Learn about sustainable avocado farming practices.", ctaText: "Learn More", ctaHref: "/avocado-sustainability" }] } },
      { id: "b_testimonials_home", type: "Testimonials", props: { title: "Testimonials from Avocado Enthusiasts", items: [{ quote: "Avocados are a superfood that never fails to impress!", author: "Emily Avocado" }, { quote: "Avocados are my culinary secret weapon.", author: "Michael Green" }, { quote: "The best avocados I've ever tasted!", author: "Sarah Chef" }] } },
      { id: "b_richtext_home", type: "RichText", props: { title: "Discover the Magic of Avocados", body: "# Nutritional Benefits of Avocados\n\nAvocados are not only delicious but also packed with essential nutrients." } },
      { id: "b_cta_home_rich", type: "CTA", props: { title: "Join the Avocado Revolution", description: "Experience the richness and health benefits of our premium avocados.", ctaText: "Get Started", ctaHref: "/signup" } },
      { id: "b_richtext_home_2", type: "RichText", props: { title: "", body: "# From Farm to Table\n\nAt Avocado Magic we believe that great food starts with great ingredients." } },
    ],
  },
  {
    id: "p_bananas", slug: "/bananas", title: "Bananas", updatedAt: "2026-02-26T23:55:19.815Z",
    blocks: [
      { id: "b_hero_bananas", type: "Hero", props: { heading: "Bananas: Nature's Energy Booster", subheading: "Explore the benefits and versatility of bananas.", ctaText: "Learn More", ctaHref: "/banana-benefits", imageUrl: "/hero-generated.svg", imageAlt: "Bananas" } },
      { id: "b_richtext_bananas", type: "RichText", props: { title: "", body: "**Bananas** are not only a great source of energy but also packed with essential nutrients." } },
      { id: "b_cardgrid_bananas", type: "CardGrid", props: { title: "Explore More Banana Benefits", cards: [{ title: "Nutritional Facts", description: "Discover the essential nutrients packed in bananas.", ctaText: "Learn More", ctaHref: "/banana-nutrition" }, { title: "Banana Recipes", description: "Try delicious banana recipes for every meal.", ctaText: "Get Recipes", ctaHref: "/banana-recipes" }, { title: "Health Benefits", description: "Understand how bananas contribute to your health.", ctaText: "Read More", ctaHref: "/banana-health" }] } },
    ],
  },
  {
    id: "p_strawberries", slug: "/strawberries", title: "Strawberries", updatedAt: "2026-02-26T20:02:58.431Z",
    blocks: [
      { id: "b_hero_strawberries", type: "Hero", props: { heading: "Discover the Sweetness of Strawberries", subheading: "Nature's candy packed with nutrients.", ctaText: "Learn More", ctaHref: "/strawberries", imageUrl: "/hero-generated.svg", imageAlt: "Fresh strawberries" } },
      { id: "b_richtext_strawberries", type: "RichText", props: { title: "Why Strawberries?", body: "Strawberries are not only delicious but also packed with vitamins, fiber, and high levels of antioxidants." } },
      { id: "b_featuregrid_strawberries", type: "FeatureGrid", props: { title: "Health Benefits", features: [{ title: "Rich in Nutrients", description: "Strawberries are an excellent source of vitamin C and manganese." }, { title: "Antioxidant Powerhouse", description: "These berries are loaded with antioxidants and plant compounds." }] } },
      { id: "b_faq_strawberries", type: "FAQAccordion", props: { title: "Frequently Asked Questions", items: [{ q: "What are the health benefits of strawberries?", a: "Strawberries are rich in vitamins, fiber, and antioxidants." }, { q: "How should I store strawberries?", a: "Store strawberries in the refrigerator and wash them just before eating." }, { q: "Can strawberries be frozen?", a: "Yes, strawberries can be frozen. Wash and dry them thoroughly first." }] } },
      { id: "b_cta_strawberries", type: "CTA", props: { title: "Enjoy Strawberries Today", description: "Add strawberries to your diet and enjoy their sweet taste and health benefits.", ctaText: "Find Recipes", ctaHref: "/strawberries-recipes" } },
    ],
  },
  {
    id: "p_oranges", slug: "/oranges", title: "Oranges", updatedAt: "2026-02-26T22:40:07.960Z",
    blocks: [
      { id: "b_hero_oranges", type: "Hero", props: { heading: "Citrus Bliss", subheading: "Discover the vibrant world of citrus fruits.", ctaText: "Learn More", ctaHref: "/oranges", imageUrl: "/hero-generated.svg", imageAlt: "Oranges" } },
      { id: "b_richtext_oranges", type: "RichText", props: { title: "The Wonders of Oranges", body: "**Oranges** are among the most beloved fruits globally, cherished for their delicious taste and nutritional benefits." } },
    ],
  },
  {
    id: "p_olives", slug: "/olives", title: "Olives", updatedAt: "2026-02-26T23:56:20.128Z",
    blocks: [
      { id: "b_hero_olives", type: "Hero", props: { heading: "Finest Olive Oils", subheading: "From sun-soaked Mediterranean groves to small artisan producers.", ctaText: "Shop the Collection", ctaHref: "/shop", imageUrl: "/hero-generated.svg", imageAlt: "Olives" } },
      { id: "b_cardgrid_olives", type: "CardGrid", props: { title: "Key Health Benefits of Olive Oil", cards: [{ title: "Rich in Healthy Fats", description: "Olive oil is high in oleic acid, a monounsaturated fat.", ctaText: "Learn More", ctaHref: "/health-benefits" }, { title: "High in Antioxidants", description: "Contains large amounts of antioxidants.", ctaText: "Discover More", ctaHref: "/antioxidants" }, { title: "Supports Heart Health", description: "Regular consumption linked to reduced risk of heart disease.", ctaText: "Find Out More", ctaHref: "/heart-health" }] } },
      { id: "b_richtext_olives", type: "RichText", props: { title: "", body: "Olive oil is a staple in many kitchens worldwide." } },
    ],
  },
  {
    id: "p_cherries", slug: "/cherries", title: "Cherries", updatedAt: "2026-02-27T23:24:35.403Z",
    blocks: [
      { id: "b_hero_cherries", type: "Hero", props: { heading: "Discover the Delight of Cherries", subheading: "Explore the sweet and tart flavors of our premium cherries.", ctaText: "Learn More", ctaHref: "/cherries", imageUrl: "/hero-generated.svg", imageAlt: "Cherries" } },
      { id: "b_richtext_cherries_1", type: "RichText", props: { title: "Benefits of Cherries", body: "Cherries are not only delicious but also packed with nutrients and antioxidants." } },
      { id: "b_faq_cherries", type: "FAQAccordion", props: { title: "Frequently Asked Questions about Cherries", items: [{ q: "What are the health benefits of cherries?", a: "Cherries are rich in antioxidants, vitamin C, potassium, and fiber." }, { q: "Can cherries help improve sleep?", a: "Yes, cherries contain natural melatonin which can help regulate sleep." }, { q: "Are cherries good for muscle recovery?", a: "Cherries have anti-inflammatory properties that can aid in muscle recovery." }] } },
      { id: "b_richtext_cherries_2", type: "RichText", props: { title: "Vitamins in Cherries", body: "Cherries are a great source of essential vitamins including vitamin C and vitamin A." } },
    ],
  },
  {
    id: "p_about_us", slug: "/about-us", title: "About Us", updatedAt: "2026-02-26T20:01:21.390Z",
    blocks: [
      { id: "b_hero_about", type: "Hero", props: { heading: "Welcome to Our Company", subheading: "Celebrating 100 years of innovation and excellence", ctaText: "Discover Our Legacy", ctaHref: "/about-us", imageUrl: "/hero-generated.svg", imageAlt: "Welcome to Our Company" } },
      { id: "b_cardgrid_about", type: "CardGrid", props: { title: "Our Values", cards: [{ title: "Quality", description: "We source only the finest ingredients.", ctaText: "Learn More", ctaHref: "/quality" }, { title: "Sustainability", description: "Committed to sustainable farming.", ctaText: "Learn More", ctaHref: "/sustainability" }, { title: "Community", description: "Supporting local communities worldwide.", ctaText: "Learn More", ctaHref: "/community" }] } },
      { id: "b_richtext_about", type: "RichText", props: { title: "", body: "**Our journey with avocados** began over a century ago." } },
      { id: "b_faq_about", type: "FAQAccordion", props: { title: "Frequently Asked Questions", items: [{ q: "Where are your avocados grown?", a: "Our avocados are sourced from sustainable farms in Mexico, California, and Peru." }, { q: "Do you offer wholesale?", a: "Yes, we offer wholesale pricing for bulk orders." }, { q: "How can I become a supplier?", a: "Please contact our partnerships team at partners@avocadomagic.com." }] } },
    ],
  },
  {
    id: "p_about_lemons", slug: "/about-lemons", title: "About Lemons", updatedAt: "2026-02-27T23:25:08.636Z",
    blocks: [
      { id: "b_hero_lemons", type: "Hero", props: { heading: "Explore the Benefits of Lemons", subheading: "Discover Health and Culinary Uses", ctaText: "Find Out More", ctaHref: "/about-lemons", imageUrl: "/hero-generated.svg", imageAlt: "Lemons" } },
      { id: "b_richtext_lemons", type: "RichText", props: { title: "The Zesty World of Lemons", body: "When life gives you lemons, make lemonade! Lemons are not just a fruit; they are a versatile powerhouse." } },
      { id: "b_cardgrid_lemons", type: "CardGrid", props: { title: "Interesting Lemon Facts", cards: [{ title: "Rich in Vitamin C", description: "Lemons are one of the best sources of vitamin C.", ctaText: "Learn More", ctaHref: "/lemon-nutrition" }, { title: "Natural Cleaner", description: "Lemon juice is a powerful natural cleaning agent.", ctaText: "Discover", ctaHref: "/lemon-uses" }, { title: "Culinary Uses", description: "From dressings to desserts, lemons enhance any recipe.", ctaText: "Get Recipes", ctaHref: "/lemon-recipes" }] } },
    ],
  },
]

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
})
