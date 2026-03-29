/**
 * Agent mode E2E tests — real LLM tool-use loop via /agent/chat (blocking).
 *
 * These tests exercise the same code path the live editor uses:
 *   user prompt → agent loop → tool calls (get_page, batch_update_props, etc.) → site mutations
 *
 * Provider config (env):
 *   E2E_AGENT_PROVIDER   — "anthropic" (default) | "openai"
 *   E2E_AGENT_MODEL      — override model ID (default: provider's DEFAULT_MODELS)
 *   ANTHROPIC_API_KEY     — required for anthropic provider
 *   OPENAI_API_KEY        — required for openai provider
 *
 * Run:
 *   pnpm --filter @ai-site-editor/orchestrator test:e2e:agent
 */

import test, { describe, after } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, mkdirSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { app } from "./index.js"
import type { PageDoc, BlockInstance } from "@ai-site-editor/shared"
import { setPage, getPage, getSessionDraft, setSiteConfig, scopedSessionKey } from "./state/session-state.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Provider config — mirrors live agent defaults (Anthropic + claude-sonnet-4-6)
// ---------------------------------------------------------------------------

type AgentProvider = "anthropic" | "openai"

const E2E_PROVIDER: AgentProvider = (() => {
  const raw = (process.env.E2E_AGENT_PROVIDER ?? "anthropic").trim().toLowerCase()
  if (raw === "openai") return "openai" as const
  return "anthropic" as const
})()

const E2E_MODEL = process.env.E2E_AGENT_MODEL?.trim() || undefined // let server use its default

const E2E_API_KEY: string | undefined =
  E2E_PROVIDER === "anthropic"
    ? process.env.ANTHROPIC_API_KEY?.trim()
    : process.env.OPENAI_API_KEY?.trim()

const E2E_AVAILABLE = Boolean(E2E_API_KEY)
const E2E_OPTS = { timeout: 180_000, skip: !E2E_AVAILABLE }

// ---------------------------------------------------------------------------
// Result collection — written to .data/evals/agent-e2e-<provider>-<timestamp>.json
// ---------------------------------------------------------------------------

type TestResult = {
  test: string
  status: "pass" | "fail"
  durationMs: number
  toolCallCount: number
  toolsUsed: string[]
  usage?: TokenUsage
  costUsd?: number
  error?: string
}

const suiteStartedAt = new Date().toISOString()
const results: TestResult[] = []

function extractToolsUsed(result: AgentChatResponse): string[] {
  return [...new Set(
    result.events
      .filter(e => e.type === "tool_done" && e.toolName)
      .map(e => e.toolName!),
  )]
}

function recordResult(name: string, startMs: number, result: AgentChatResponse | null, error?: string) {
  const model = E2E_MODEL ?? (E2E_PROVIDER === "anthropic" ? "claude-sonnet-4-6" : "gpt-4o")
  const usage = result?.usage
  results.push({
    test: name,
    status: error ? "fail" : "pass",
    durationMs: Math.round(performance.now() - startMs),
    toolCallCount: result?.toolCallCount ?? 0,
    toolsUsed: result ? extractToolsUsed(result) : [],
    ...(usage ? { usage, costUsd: +estimateCostUsd(model, usage).toFixed(6) } : {}),
    ...(error ? { error } : {}),
  })
}

function writeReport() {
  const evalsDir = resolve(__dirname, "../../.data/evals")
  mkdirSync(evalsDir, { recursive: true })
  const ts = suiteStartedAt.replace(/[:.]/g, "-").replace("T", "_").slice(0, 19)
  const model = E2E_MODEL ?? (E2E_PROVIDER === "anthropic" ? "claude-sonnet-4-6" : "gpt-4o")
  const filename = `agent-e2e_${E2E_PROVIDER}_${model}_${ts}.json`
  const totalInputTokens = results.reduce((s, r) => s + (r.usage?.inputTokens ?? 0), 0)
  const totalOutputTokens = results.reduce((s, r) => s + (r.usage?.outputTokens ?? 0), 0)
  const totalCostUsd = results.reduce((s, r) => s + (r.costUsd ?? 0), 0)
  const report = {
    suite: "agent-e2e",
    startedAt: suiteStartedAt,
    finishedAt: new Date().toISOString(),
    provider: E2E_PROVIDER,
    model,
    testCount: results.length,
    passed: results.filter(r => r.status === "pass").length,
    failed: results.filter(r => r.status === "fail").length,
    totalDurationMs: results.reduce((s, r) => s + r.durationMs, 0),
    avgToolCalls: results.length ? +(results.reduce((s, r) => s + r.toolCallCount, 0) / results.length).toFixed(1) : 0,
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd: +totalCostUsd.toFixed(4),
    results,
  }
  const outPath = resolve(evalsDir, filename)
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n")
  console.log(`\n📊 Agent E2E report: ${outPath}`)
}

// ---------------------------------------------------------------------------
// Test site data — reuse the avocado-magic rich fixture
// ---------------------------------------------------------------------------

const SITE_ID = "agent-e2e"
let sessionCounter = 0

function newSession() {
  return `agent-e2e-${++sessionCounter}`
}

const RICH_PAGES: PageDoc[] = [
  {
    id: "p_home", slug: "/", title: "Home", updatedAt: "2026-03-03T22:46:56.033Z",
    blocks: [
      { id: "b_hero_home", type: "Hero", props: { heading: "Discover the Magic of Avocados", subheading: "Experience the vibrant taste and health benefits of our avocados.", ctaText: "Get Started", ctaHref: "/", imageUrl: "/hero.svg", imageAlt: "Avocados" } },
      { id: "b_cardgrid_home", type: "CardGrid", props: { title: "Avocado Adventures", cards: [{ title: "Culinary Delights", description: "Uncover new culinary uses.", ctaText: "Try Now", ctaHref: "/culinary" }, { title: "Wellness", description: "Explore the wellness benefits.", ctaText: "Discover", ctaHref: "/wellness" }, { title: "Sustainability", description: "Learn about sustainable farming.", ctaText: "Learn More", ctaHref: "/sustainability" }] } },
      { id: "b_featuregrid_home", type: "FeatureGrid", props: { title: "Why Readers Love Avocados", features: [{ title: "Nutrition", description: "Packed with healthy fats, fiber, and vitamins." }, { title: "Versatility", description: "Perfect for toast, salads, and smoothies." }, { title: "Flavor", description: "Creamy texture with a rich, satisfying taste." }] } },
      { id: "b_testimonials_home", type: "Testimonials", props: { title: "What People Say", items: [{ quote: "Avocados are a superfood!", author: "Emily Green" }, { quote: "My culinary secret weapon.", author: "Michael Chef" }] } },
      { id: "b_cta_home", type: "CTA", props: { title: "Join the Avocado Revolution", description: "Experience the richness of premium avocados.", ctaText: "Get Started", ctaHref: "/signup" } },
    ],
  },
  {
    id: "p_about", slug: "/about-us", title: "About Us", updatedAt: "2026-02-26T20:01:21.390Z",
    blocks: [
      { id: "b_hero_about", type: "Hero", props: { heading: "Welcome to Our Company", subheading: "Celebrating 100 years of innovation", ctaText: "Discover", ctaHref: "/about-us", imageUrl: "/hero.svg", imageAlt: "About" } },
      { id: "b_richtext_about", type: "RichText", props: { title: "Our Story", body: "**Our journey with avocados** began over a century ago in the sun-drenched valleys of Mexico." } },
      { id: "b_faq_about", type: "FAQAccordion", props: { title: "Frequently Asked Questions", items: [{ q: "Where are your avocados grown?", a: "Sustainable farms in Mexico, California, and Peru." }, { q: "Do you offer wholesale?", a: "Yes, we offer wholesale pricing for bulk orders." }, { q: "How can I become a supplier?", a: "Contact our partnerships team at partners@avocadomagic.com." }] } },
    ],
  },
  {
    id: "p_bananas", slug: "/bananas", title: "Bananas", updatedAt: "2026-02-26T23:55:19.815Z",
    blocks: [
      { id: "b_hero_bananas", type: "Hero", props: { heading: "Bananas: Nature's Energy Booster", subheading: "Explore the benefits and versatility of bananas.", ctaText: "Learn More", ctaHref: "/banana-benefits", imageUrl: "/hero.svg", imageAlt: "Bananas" } },
      { id: "b_richtext_bananas", type: "RichText", props: { title: "", body: "**Bananas** are a great source of energy and essential nutrients." } },
    ],
  },
]

const seededSessions = new Set<string>()

function ensureSeeded(session: string) {
  if (seededSessions.has(session)) return
  const scoped = scopedSessionKey(session, SITE_ID)
  for (const page of RICH_PAGES) {
    setPage(scoped, structuredClone(page))
  }
  setSiteConfig(scoped, { name: "Avocado Magic", logo: "/logo.svg" })
  seededSessions.add(session)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TokenUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

type AgentChatResponse = {
  status: "applied" | "error"
  summary: string
  toolCallCount: number
  usage?: TokenUsage
  events: Array<{ type: string; toolName?: string; text?: string; isError?: boolean }>
}

// Pricing per million tokens (USD) — updated 2026-03
const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4, cacheRead: 0.08 },
  "claude-sonnet-4-6":        { input: 3, output: 15, cacheRead: 0.3 },
  "claude-opus-4-6":          { input: 15, output: 75, cacheRead: 1.5 },
  "gpt-4o":                   { input: 2.5, output: 10, cacheRead: 1.25 },
  "gpt-4o-mini":              { input: 0.15, output: 0.6, cacheRead: 0.075 },
}

function estimateCostUsd(model: string, usage: TokenUsage): number {
  const p = PRICING[model]
  if (!p) return 0
  return (
    (usage.inputTokens * p.input +
     usage.outputTokens * p.output +
     usage.cacheReadTokens * p.cacheRead) / 1_000_000
  )
}

async function agentChat(session: string, slug: string, message: string): Promise<AgentChatResponse & { _startMs: number }> {
  ensureSeeded(session)
  const startMs = performance.now()
  const res = await app.inject({
    method: "POST",
    url: "/agent/chat",
    headers: { "x-agent-api-key": E2E_API_KEY! },
    payload: {
      session,
      siteId: SITE_ID,
      slug,
      message,
      ...(E2E_MODEL ? { model: E2E_MODEL } : {}),
    },
  })
  assert.equal(res.statusCode, 200, `agent/chat returned ${res.statusCode}: ${res.body}`)
  const json = res.json() as AgentChatResponse
  return { ...json, _startMs: startMs }
}

function getDraft(session: string, slug: string): PageDoc {
  const scoped = scopedSessionKey(session, SITE_ID)
  const page = getPage(scoped, slug)
  assert.ok(page, `page ${slug} not found in session ${session}`)
  return page
}

function findBlock(page: PageDoc, predicate: (b: BlockInstance) => boolean) {
  return page.blocks.find(predicate)
}

function blockProps(block: BlockInstance | undefined) {
  return (block?.props ?? {}) as Record<string, unknown>
}

function getDraftSlugs(session: string): string[] {
  const scoped = scopedSessionKey(session, SITE_ID)
  const draft = getSessionDraft(scoped)
  return [...draft.keys()]
}

function toolsUsed(result: AgentChatResponse): string[] {
  return extractToolsUsed(result)
}

// ---------------------------------------------------------------------------
// Agent E2E Tests
// ---------------------------------------------------------------------------

describe(`agent-e2e (${E2E_PROVIDER}/${E2E_MODEL ?? "default"})`, E2E_OPTS, () => {

  // Write report after all tests complete (pass or fail)
  after(() => writeReport())

  /** Wrap a test body to record timing & tool usage into the results array. */
  let lastResult: AgentChatResponse | null = null
  function tracked(name: string, fn: () => Promise<void>) {
    test(name, async () => {
      lastResult = null
      const startMs = performance.now()
      try {
        await fn()
        recordResult(name, startMs, lastResult)
      } catch (err) {
        recordResult(name, startMs, lastResult, err instanceof Error ? err.message : String(err))
        throw err
      }
    })
  }

  /** Call agentChat and stash the result for recording. */
  async function chat(session: string, slug: string, message: string) {
    const result = await agentChat(session, slug, message)
    lastResult = result
    return result
  }

  // ---- Read-only / context-gathering ----

  tracked("1. Read-only query — agent describes the page without mutating it", async () => {
    const session = newSession()
    const result = await chat(session, "/", "What sections does this page have?")
    assert.equal(result.status, "applied")
    assert.ok(result.summary.length > 0, "should return a summary")
    // Summary should reference block types present on the page
    assert.ok(/hero|card|feature|testimonial|cta/i.test(result.summary),
      `summary should mention page sections, got: ${result.summary.slice(0, 200)}`)
    // Page should be unchanged
    const page = getDraft(session, "/")
    assert.equal(page.blocks.length, RICH_PAGES[0].blocks.length, "block count should be unchanged")
  })

  // ---- Simple text edit ----

  tracked("2. Simple text edit — change hero heading", async () => {
    const session = newSession()
    const result = await chat(session, "/", "Change the hero heading to 'Fresh Avocado Magic'")
    assert.equal(result.status, "applied", `${result.status}: ${result.summary}`)

    const page = getDraft(session, "/")
    const hero = findBlock(page, b => b.type === "Hero")
    assert.ok(hero, "Hero block not found")
    assert.equal(blockProps(hero).heading, "Fresh Avocado Magic")
  })

  // ---- Multi-field update ----

  tracked("3. Multi-field update — hero subheading + CTA section button", async () => {
    const session = newSession()
    const result = await chat(
      session, "/",
      "Set the hero subheading to 'Your daily dose of green goodness' and in the CTA section titled 'Join the Avocado Revolution' change the button text to 'Start Now'",
    )
    assert.equal(result.status, "applied", `${result.status}: ${result.summary}`)

    const page = getDraft(session, "/")
    const hero = findBlock(page, b => b.type === "Hero")!
    assert.equal(blockProps(hero).subheading, "Your daily dose of green goodness")
    const cta = findBlock(page, b => b.type === "CTA")!
    assert.equal(blockProps(cta).ctaText, "Start Now")
  })

  // ---- Add a new block ----

  tracked("4. Add block — add a FAQ section to the home page", async () => {
    const session = newSession()
    const beforeCount = RICH_PAGES[0].blocks.length

    const result = await chat(
      session, "/",
      "Add a FAQ section with 3 questions about avocado nutrition",
    )
    assert.equal(result.status, "applied", `${result.status}: ${result.summary}`)

    const page = getDraft(session, "/")
    const faq = findBlock(page, b => b.type === "FAQAccordion")
    assert.ok(faq, "FAQAccordion should have been added")
    const items = blockProps(faq).items as Array<{ q: string; a: string }>
    assert.ok(Array.isArray(items) && items.length >= 2, `expected >=2 FAQ items, got ${items?.length}`)
    assert.ok(page.blocks.length > beforeCount, "block count should increase")
  })

  // ---- Remove a block ----

  tracked("5. Remove block — remove the testimonials section", async () => {
    const session = newSession()
    const result = await chat(session, "/", "Remove the testimonials section")
    assert.equal(result.status, "applied", `${result.status}: ${result.summary}`)

    const page = getDraft(session, "/")
    assert.ok(
      !findBlock(page, b => b.type === "Testimonials"),
      "Testimonials should be gone",
    )
  })

  // ---- Move a block ----

  tracked("6. Move block — move CTA to right after the hero", async () => {
    const session = newSession()
    const result = await chat(
      session, "/",
      "Move the call-to-action section to right after the hero",
    )
    assert.equal(result.status, "applied", `${result.status}: ${result.summary}`)

    const page = getDraft(session, "/")
    const heroIdx = page.blocks.findIndex(b => b.type === "Hero")
    const ctaIdx = page.blocks.findIndex(b => b.type === "CTA")
    assert.ok(ctaIdx >= 0, "CTA should still exist")
    assert.equal(ctaIdx, heroIdx + 1, `CTA should be right after hero (idx ${heroIdx}), got idx ${ctaIdx}`)
  })

  // ---- Create a new page ----

  tracked("7. Create page — /recipes with hero and content", async () => {
    const session = newSession()
    const result = await chat(
      session, "/",
      "Create a new page at /recipes with a hero titled 'Avocado Recipes' and a RichText block with a few recipe ideas",
    )
    assert.equal(result.status, "applied", `${result.status}: ${result.summary}`)

    const page = getDraft(session, "/recipes")
    assert.ok(page, "/recipes page should exist")
    const hero = findBlock(page, b => b.type === "Hero")
    assert.ok(hero, "Hero should exist on /recipes")
    assert.ok(/recipe/i.test(String(blockProps(hero).heading)), `hero heading should mention recipes`)
    const rt = findBlock(page, b => b.type === "RichText")
    assert.ok(rt, "RichText should exist on /recipes")
  })

  // ---- Rename page ----

  tracked("8. Rename page — /bananas to /tropical-bananas", async () => {
    const session = newSession()
    const result = await chat(
      session, "/bananas",
      "Rename this page to /tropical-bananas and update its title to 'Tropical Bananas'",
    )
    assert.equal(result.status, "applied", `${result.status}: ${result.summary}`)

    const slugs = getDraftSlugs(session)
    assert.ok(!slugs.includes("/bananas"), `/bananas should be gone: ${JSON.stringify(slugs)}`)
    assert.ok(slugs.includes("/tropical-bananas"), `/tropical-bananas should exist: ${JSON.stringify(slugs)}`)

    const page = getDraft(session, "/tropical-bananas")
    assert.ok(/tropical|banana/i.test(page.title), `page title should reflect rename, got: ${page.title}`)
  })

  // ---- Add list item ----

  tracked("9. Add list item — new FAQ question on /about-us", async () => {
    const session = newSession()
    const result = await chat(
      session, "/about-us",
      "Add a new FAQ: 'Do you ship internationally?' with the answer 'Yes, we ship to over 50 countries worldwide.'",
    )
    assert.equal(result.status, "applied", `${result.status}: ${result.summary}`)

    const page = getDraft(session, "/about-us")
    const faq = findBlock(page, b => b.type === "FAQAccordion")!
    const items = blockProps(faq).items as Array<{ q: string; a: string }>
    const added = items.find(item => /ship internationally/i.test(item.q))
    assert.ok(added, "new FAQ item about shipping should exist")
    assert.ok(/50 countries/i.test(added.a), `answer should mention 50 countries, got: ${added.a}`)
  })

  // ---- Remove list item ----

  tracked("10. Remove list item — delete a specific FAQ on /about-us", async () => {
    const session = newSession()
    const faqBefore = findBlock(RICH_PAGES[1], b => b.type === "FAQAccordion")!
    const itemsBefore = blockProps(faqBefore).items as Array<{ q: string }>

    const result = await chat(
      session, "/about-us",
      "Remove the FAQ question about where avocados are grown",
    )
    assert.equal(result.status, "applied", `${result.status}: ${result.summary}`)

    const page = getDraft(session, "/about-us")
    const faq = findBlock(page, b => b.type === "FAQAccordion")!
    const items = blockProps(faq).items as Array<{ q: string }>
    assert.ok(items.length < itemsBefore.length, "item count should decrease")
    assert.ok(
      !items.some(item => /where.*grown/i.test(item.q)),
      `avocado-grown FAQ should be removed, remaining: ${items.map(i => i.q).join("; ")}`,
    )
  })

  // ---- Vague / creative rewrite ----

  tracked("11. Creative rewrite — make the hero more exciting", async () => {
    const session = newSession()
    const heroBefore = findBlock(RICH_PAGES[0], b => b.type === "Hero")!
    const headingBefore = String(blockProps(heroBefore).heading)

    const result = await chat(session, "/", "Make the hero section more exciting and vibrant")
    assert.equal(result.status, "applied", `${result.status}: ${result.summary}`)

    const tools = toolsUsed(result)
    const page = getDraft(session, "/")
    const hero = findBlock(page, b => b.type === "Hero")!
    const headingAfter = String(blockProps(hero).heading)

    // Agent may either apply a direct rewrite (batch_update_props) or offer variations (generate_variations).
    // Both are valid responses to a vague creative prompt.
    const directlyRewrote = headingAfter !== headingBefore
    const offeredVariations = tools.includes("generate_variations")
    assert.ok(
      directlyRewrote || offeredVariations,
      `expected hero rewrite or variations. heading: "${headingBefore}" → "${headingAfter}", tools: ${JSON.stringify(tools)}`,
    )
  })

  // ---- Cross-page awareness ----

  tracked("12. Cross-page awareness — agent knows about other pages", async () => {
    const session = newSession()
    const result = await chat(session, "/", "How many pages does this site have and what are they?")
    assert.equal(result.status, "applied")
    // Summary should mention the pages (agent gets site overview via context or list_pages tool)
    assert.ok(/about|banana/i.test(result.summary), `summary should mention site pages, got: ${result.summary.slice(0, 200)}`)
    // Should know there are 3 pages
    assert.ok(/3|three/i.test(result.summary), `summary should mention page count, got: ${result.summary.slice(0, 200)}`)
  })

  // ---- Duplicate block ----

  tracked("13. Duplicate block — duplicate the features grid", async () => {
    const session = newSession()
    const result = await chat(session, "/", "Duplicate the features grid section")
    assert.equal(result.status, "applied", `${result.status}: ${result.summary}`)

    const page = getDraft(session, "/")
    const fgs = page.blocks.filter(b => b.type === "FeatureGrid")
    assert.equal(fgs.length, 2, `expected 2 FeatureGrid blocks, got ${fgs.length}`)
    assert.notEqual(fgs[0].id, fgs[1].id, "duplicated blocks should have different IDs")
  })

  // ---- Tool call count sanity ----

  tracked("14. Efficiency — simple edit completes without runaway loops", async () => {
    const session = newSession()
    const result = await chat(session, "/bananas", "Change the hero heading to 'Go Bananas!'")
    assert.equal(result.status, "applied", `${result.status}: ${result.summary}`)
    // Guard against runaway agent loops, not exact tool-call counts.
    // Typical: 2-4 calls. Threshold is generous to tolerate model variation.
    assert.ok(
      result.toolCallCount <= 10,
      `expected <=10 tool calls for simple edit, got ${result.toolCallCount} — possible runaway loop`,
    )
    const page = getDraft(session, "/bananas")
    const hero = findBlock(page, b => b.type === "Hero")
    assert.equal(blockProps(hero).heading, "Go Bananas!")
  })
})
