import test from "node:test"
import assert from "node:assert/strict"
import type { EditPlan } from "@avocadostudio-ai/shared"

// These tests mock the planner via setGeneratePlanWithOpenAIForTests and then
// assert exact call counts / planner source / response codes for the sequential
// repair pipeline. The parallel intent-router + planner optimizations would
// invoke the same mock an extra time and bypass the repair path, so disable
// them for this file before importing the app (env is read per-request, but
// pinning here keeps the intent obvious).
process.env.CHAT_PARALLEL_PLANNER = "0"
process.env.CHAT_LLM_INTENT_ROUTER = "0"

// Several tests in this file don't set OPENAI_API_KEY themselves and were
// relying on a developer's local .env. In CI's test:integration step the
// secret is not propagated, so resolvePlannerSource falls through to "demo"
// or "gemini" and the openai planner mock never fires. Pin a placeholder key
// here — the mocks intercept all real planner calls, so no network is hit.
if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = "test-key"

import { app } from "./index.js"
import {
  detectImageOps,
  setDemoPlanFromMessageForTests,
  setGeneratePlanWithOpenAIForTests,
  setParseIntentWithOpenAIForTests,
  setParseIntentWithAnthropicForTests,
  shouldResolveCreatePageHeroImage
} from "./chat/chat-pipeline.js"
import { PlannerOutputError, type PlannerSchemaContextMeta } from "./chat/planner.js"

const STUB_SCHEMA_CONTEXT: PlannerSchemaContextMeta = {
  contractMode: "targeted",
  contractBytes: 0,
  contractBlockCount: 0,
  targetBlockTypes: [],
  strictJsonEnabled: false
}
import { pendingApprovalPlanBySession } from "./state/session-state.js"
import { ZERO_USAGE } from "./telemetry/usage.js"
import { createSessionFactory, parseSseData } from "./test/fixtures.js"

const newSession = createSessionFactory("chat-pipeline-int")

test("chat pending-plan lifecycle: plan_only -> apply_pending_plan applies mocked plan", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const targetHeading = `Planned heading ${Date.now()}`
  const mockedPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Updated hero heading.",
    change_log: ["Changed hero heading."],
    ops: [{ op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: targetHeading } }]
  }

  setGeneratePlanWithOpenAIForTests(async () => ({ plan: mockedPlan, usage: { ...ZERO_USAGE }, schemaContext: STUB_SCHEMA_CONTEXT }))

  const planReady = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "change hero heading",
      executionMode: "plan_only"
    }
  })
  assert.equal(planReady.statusCode, 200)
  const planPayload = planReady.json() as { status?: string; pendingPlanId?: string; summary?: string; changes?: string[] }
  assert.equal(planPayload.status, "plan_ready")
  assert.equal(typeof planPayload.pendingPlanId, "string")
  assert.ok(planPayload.pendingPlanId)
  // Approval-gate path must flip LLM past-tense copy to future tense so the
  // summary reads consistently with the "Approve plan" button.
  assert.match(String(planPayload.summary), /Will update hero heading/i)
  assert.ok(
    planPayload.changes?.every((line) => !/^Changed\b/.test(line)),
    `expected change_log entries rewritten to future tense, got ${JSON.stringify(planPayload.changes)}`
  )

  const applyPending = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      executionMode: "apply_pending_plan",
      pendingPlanId: planPayload.pendingPlanId
    }
  })
  assert.equal(applyPending.statusCode, 200)
  const applyPayload = applyPending.json() as { status?: string; summary?: string }
  assert.equal(applyPayload.status, "applied")
  assert.match(String(applyPayload.summary), /Updated hero heading/i)

  const pageRes = await app.inject({
    method: "GET",
    url: `/draft/pages?session=${encodeURIComponent(session)}&slug=${encodeURIComponent("/")}`
  })
  assert.equal(pageRes.statusCode, 200)
  const page = pageRes.json() as { blocks: Array<{ id: string; props: Record<string, unknown> }> }
  const hero = page.blocks.find((block) => block.id === "b_hero_home")
  assert.ok(hero)
  assert.equal(hero?.props.heading, targetHeading)
})

test("chat auto mode reuses pending plan when the same prompt is sent again", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const message = "Change the image to match the guide-led theme."
  const targetHeading = `Replay pending plan ${Date.now()}`
  let plannerCalls = 0
  setGeneratePlanWithOpenAIForTests(async () => {
    plannerCalls += 1
    if (plannerCalls === 1) {
      return {
        plan: {
          intent: "edit_plan",
          summary_for_user: "Updated hero heading.",
          change_log: ["Changed hero heading."],
          ops: [{ op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: targetHeading } }]
        },
        usage: { ...ZERO_USAGE },
        schemaContext: STUB_SCHEMA_CONTEXT
      }
    }
    return {
      plan: {
        intent: "edit_plan",
        summary_for_user: "No changes.",
        change_log: [],
        ops: []
      },
      usage: { ...ZERO_USAGE },
      schemaContext: STUB_SCHEMA_CONTEXT
    }
  })

  const planReady = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message,
      executionMode: "plan_only"
    }
  })
  assert.equal(planReady.statusCode, 200)
  const planPayload = planReady.json() as { status?: string }
  assert.equal(planPayload.status, "plan_ready")

  const replay = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message
    }
  })
  assert.equal(replay.statusCode, 200)
  const replayPayload = replay.json() as { status?: string; summary?: string }
  assert.equal(replayPayload.status, "applied")
  assert.match(String(replayPayload.summary), /Updated hero heading/i)
  assert.equal(plannerCalls, 1)

  const pageRes = await app.inject({
    method: "GET",
    url: `/draft/pages?session=${encodeURIComponent(session)}&slug=${encodeURIComponent("/")}`
  })
  assert.equal(pageRes.statusCode, 200)
  const page = pageRes.json() as { blocks: Array<{ id: string; props: Record<string, unknown> }> }
  const hero = page.blocks.find((block) => block.id === "b_hero_home")
  assert.ok(hero)
  assert.equal(hero?.props.heading, targetHeading)
})

test("chat pending-plan lifecycle resolves image for TwoColumn update on approval", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  t.after(() => {
    pendingApprovalPlanBySession.delete(session)
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const createPage = await app.inject({
    method: "POST",
    url: "/ops",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      ops: [
        {
          op: "create_page",
          page: {
            id: "p_adventures",
            slug: "/adventures",
            title: "Adventures",
            updatedAt: new Date().toISOString(),
            blocks: [
              {
                id: "b_two_col_test",
                type: "TwoColumn",
                props: {
                  variant: "default",
                  left: [
                    { type: "heading", text: "Rise above rest" },
                    { type: "paragraph", text: "Test body" }
                  ],
                  right: [
                    { type: "image", src: "/hero-generated.svg", alt: "A climber ascending a rugged snow-capped mountain peak at sunrise" }
                  ]
                }
              }
            ]
          }
        }
      ]
    }
  })
  assert.equal(createPage.statusCode, 200)

  const mockedPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Update section image.",
    change_log: ["Updated image."],
    ops: [
      {
        op: "update_props",
        pageSlug: "/adventures",
        blockId: "b_two_col_test",
        patch: {
          right: [
            { type: "image", src: "pending", alt: "A climber ascending a rugged snow-capped mountain peak at sunrise" }
          ]
        } as Record<string, unknown>
      }
    ]
  }
  const pendingPlanId = `${session}-pending-two-col`
  pendingApprovalPlanBySession.set(session, {
    id: pendingPlanId,
    createdAt: new Date().toISOString(),
    promptHash: "test-prompt-hash",
    requestedSlug: "/adventures",
    effectiveSlug: "/adventures",
    summary: mockedPlan.summary_for_user,
    source: "openai",
    modelUsed: "gpt-4o-mini",
    modelKey: "fast",
    plan: structuredClone(mockedPlan),
    originalMessage: "update image to pending from unsplash matching image alt text",
    pendingImageOps: [
      {
        blockId: "b_two_col_test",
        pageSlug: "/adventures",
        path: "right[0].src",
        altPath: "right[0].alt",
        query: "climber sunrise mountain",
        provider: "auto"
      }
    ]
  })

  const applyPending = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/adventures",
      executionMode: "apply_pending_plan",
      pendingPlanId
    }
  })
  assert.equal(applyPending.statusCode, 200)
  const applyPayload = applyPending.json() as { status?: string }
  assert.equal(applyPayload.status, "applied")

  const pageRes = await app.inject({
    method: "GET",
    url: `/draft/pages?session=${encodeURIComponent(session)}&slug=${encodeURIComponent("/adventures")}`
  })
  assert.equal(pageRes.statusCode, 200)
  const page = pageRes.json() as { blocks: Array<{ id: string; props: Record<string, unknown> }> }
  const twoCol = page.blocks.find((block) => block.id === "b_two_col_test")
  assert.ok(twoCol)
  const right = (twoCol?.props.right as Array<{ src?: string; type?: string }> | undefined) ?? []
  const resolvedImageUrl = String(right[0]?.src ?? "")
  assert.ok(resolvedImageUrl.length > 0)
  assert.equal(right[0]?.type, "image")
})

test("chat apply_pending_plan preserves detected image query when image fields were stripped", async (t) => {
  const previousUnsplash = process.env.UNSPLASH_ACCESS_KEY
  delete process.env.UNSPLASH_ACCESS_KEY
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    setParseIntentWithOpenAIForTests()
    setParseIntentWithAnthropicForTests()
    if (previousUnsplash === undefined) delete process.env.UNSPLASH_ACCESS_KEY
    else process.env.UNSPLASH_ACCESS_KEY = previousUnsplash
  })

  const session = newSession()
  const createPage = await app.inject({
    method: "POST",
    url: "/ops",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      ops: [
        {
          op: "create_page",
          page: {
            id: "p_test",
            slug: "/test",
            title: "Test",
            updatedAt: new Date().toISOString(),
            blocks: [
              {
                id: "b_hero_test",
                type: "Hero",
                props: {
                  heading: "Welcome",
                  subheading: "Discover the taste",
                  ctaText: "Explore",
                  ctaHref: "/",
                  imageUrl: "/hero-generated.svg",
                  imageAlt: "Bright yellow lemons in a bowl"
                }
              }
            ]
          }
        }
      ]
    }
  })
  assert.equal(createPage.statusCode, 200)

  const mockedPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Replace hero image.",
    change_log: ["Replace hero image."],
    ops: [
      {
        op: "update_props",
        pageSlug: "/test",
        blockId: "b_hero_test",
        patch: {
          imageUrl: "pending",
          imageAlt: "fresh ripe avocados bright"
        }
      }
    ]
  }
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: mockedPlan, usage: { ...ZERO_USAGE }, schemaContext: STUB_SCHEMA_CONTEXT }))
  // Mock intent parser to produce update with imageUrl: "pending" + imageAlt for query detection.
  // This test validates pipeline plumbing (image query preservation through plan_only → apply),
  // not LLM intent quality — the mocked intent ensures deterministic image alt text.
  const mockImageIntent = async () => ({
    action: "update" as const,
    target_block_ref: "b_hero_test",
    target_block_type: "Hero" as const,
    patch: { imageUrl: "pending", imageAlt: "fresh ripe avocados bright" }
  })
  setParseIntentWithOpenAIForTests(mockImageIntent as Parameters<typeof setParseIntentWithOpenAIForTests>[0])
  setParseIntentWithAnthropicForTests(mockImageIntent as Parameters<typeof setParseIntentWithAnthropicForTests>[0])

  const planReady = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/test",
      message: "replace this image from unsplash",
      executionMode: "plan_only",
      activeBlockId: "b_hero_test",
      activeEditablePath: "imageUrl"
    }
  })
  assert.equal(planReady.statusCode, 200)
  const planPayload = planReady.json() as { status?: string; pendingPlanId?: string }
  assert.equal(planPayload.status, "plan_ready")
  assert.equal(typeof planPayload.pendingPlanId, "string")
  assert.ok(planPayload.pendingPlanId)

  // Verify the pending plan preserved the image query from imageAlt
  const pending = pendingApprovalPlanBySession.get(session)
  assert.ok(pending, "pending plan should exist")
  const pendingImageOps = (pending as Record<string, unknown>).pendingImageOps as Array<{ query?: string }> | undefined
  assert.ok(pendingImageOps && pendingImageOps.length > 0, "pendingImageOps should exist")
  assert.ok((pendingImageOps[0].query ?? "").trim().length > 0, "image query should be populated")
})

test("detectImageOps finds nested child image targets", () => {
  const page = {
    id: "p_test",
    slug: "/test",
    title: "Test",
    updatedAt: new Date().toISOString(),
    blocks: [
      {
        id: "b_cardgrid_test",
        type: "CardGrid",
        props: {
          title: "Cards",
          cards: [
            { title: "Team", description: "Collaboration", ctaText: "Learn", ctaHref: "/", imageUrl: "pending" },
            { title: "Deploy", description: "Fast", ctaText: "Learn", ctaHref: "/", imageUrl: "pending" }
          ]
        }
      }
    ]
  }
  const plan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Add images",
    change_log: ["Add images"],
    ops: [
      {
        op: "update_props",
        pageSlug: "/test",
        blockId: "b_cardgrid_test",
        patch: {
          cards: [
            { title: "Team", description: "Collaboration", ctaText: "Learn", ctaHref: "/", imageUrl: "pending" },
            { title: "Deploy", description: "Fast", ctaText: "Learn", ctaHref: "/", imageUrl: "pending" }
          ]
        }
      }
    ]
  }
  const ops = detectImageOps({
    plan,
    message: "In the Card Grid, add images to all cards from Unsplash",
    slug: "/test",
    currentPage: page,
    activeBlockId: "b_cardgrid_test"
  })
  assert.equal(ops.length, 2)
  assert.deepEqual(
    ops.map((op) => op.path).sort(),
    ["cards[0].imageUrl", "cards[1].imageUrl"]
  )
  assert.ok(ops.every((op) => op.provider === "unsplash"))
})

test("detectImageOps honors ordinal card targeting for image replacement", () => {
  const page = {
    id: "p_test",
    slug: "/test",
    title: "About Lemons",
    updatedAt: new Date().toISOString(),
    blocks: [
      {
        id: "b_cardgrid_test",
        type: "CardGrid",
        props: {
          title: "Interesting Lemon Facts",
          cards: [
            { title: "Health Benefits", description: "Vitamin C and antioxidants", ctaText: "Learn", ctaHref: "/", imageUrl: "https://example.com/one.jpg" },
            { title: "Culinary Uses", description: "Flavor in dishes", ctaText: "Learn", ctaHref: "/", imageUrl: "https://example.com/two.jpg" },
            { title: "Lemon Varieties", description: "Different types", ctaText: "Learn", ctaHref: "/", imageUrl: "pending" }
          ]
        }
      }
    ]
  }
  const plan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Replace third card image",
    change_log: ["Replace third card image"],
    ops: [
      {
        op: "update_props",
        pageSlug: "/test",
        blockId: "b_cardgrid_test",
        patch: {
          cards: [
            { title: "Health Benefits", description: "Vitamin C and antioxidants", ctaText: "Learn", ctaHref: "/", imageUrl: "https://example.com/one.jpg" },
            { title: "Culinary Uses", description: "Flavor in dishes", ctaText: "Learn", ctaHref: "/", imageUrl: "https://example.com/two.jpg" },
            {
              title: "Lemon Varieties",
              description: "Different types",
              ctaText: "Learn",
              ctaHref: "/",
              imageUrl: "pending",
              imageAlt: "A woman holding two fresh lemon slices"
            }
          ]
        }
      }
    ]
  }

  const ops = detectImageOps({
    plan,
    message: "Replace the 3rd card image with a woman holding two slices lemon from Unsplash.",
    slug: "/test",
    currentPage: page,
    activeBlockId: "b_cardgrid_test"
  })

  assert.equal(ops.length, 1)
  assert.equal(ops[0]?.path, "cards[2].imageUrl")
  assert.equal(ops[0]?.altPath, "cards[2].imageAlt")
  assert.equal(ops[0]?.provider, "unsplash")
})

test("detectImageOps skips already-resolved remote image urls", () => {
  const page = {
    id: "p_test",
    slug: "/test",
    title: "Gallery",
    updatedAt: new Date().toISOString(),
    blocks: [
      {
        id: "b_cardgrid_test",
        type: "CardGrid",
        props: {
          title: "Cards",
          cards: [
            { title: "A", description: "One", ctaText: "Learn", ctaHref: "/", imageUrl: "https://images.unsplash.com/photo-a" },
            { title: "B", description: "Two", ctaText: "Learn", ctaHref: "/", imageUrl: "https://images.unsplash.com/photo-b" }
          ]
        }
      }
    ]
  }
  const plan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Use selected images",
    change_log: ["Use selected images"],
    ops: [
      {
        op: "update_props",
        pageSlug: "/test",
        blockId: "b_cardgrid_test",
        patch: {
          cards: [
            { title: "A", description: "One", ctaText: "Learn", ctaHref: "/", imageUrl: "https://images.unsplash.com/photo-a" },
            { title: "B", description: "Two", ctaText: "Learn", ctaHref: "/", imageUrl: "https://images.unsplash.com/photo-b" }
          ]
        }
      }
    ]
  }

  const ops = detectImageOps({
    plan,
    message: "Replace all card images from Unsplash",
    slug: "/test",
    currentPage: page,
    activeBlockId: "b_cardgrid_test"
  })

  assert.equal(ops.length, 0)
})

test("plan_only rewrites add_block CardGrid image request to update existing block", async (t) => {
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
  })
  const session = newSession()
  const mockedPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Added CardGrid.",
    change_log: ["Added CardGrid."],
    ops: [
      {
        op: "add_block",
        pageSlug: "/",
        block: {
          id: "b_cardgrid_new",
          type: "CardGrid",
          props: {
            title: "Explore more",
            cards: [
              { title: "One", description: "Desc", ctaText: "Learn", ctaHref: "/" },
              { title: "Two", description: "Desc", ctaText: "Learn", ctaHref: "/" }
            ]
          }
        }
      }
    ]
  }
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: mockedPlan, usage: { ...ZERO_USAGE }, schemaContext: STUB_SCHEMA_CONTEXT }))

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "In the Card Grid, add images to all cards from Unsplash",
      executionMode: "plan_only"
    }
  })
  assert.equal(response.statusCode, 200)
  const payload = response.json() as { status?: string; pendingPlanId?: string }
  assert.equal(payload.status, "plan_ready")
  assert.ok(payload.pendingPlanId)

  const pending = pendingApprovalPlanBySession.get(session)
  assert.ok(pending)
  assert.equal(pending?.plan.ops[0]?.op, "update_props")
  if (pending?.plan.ops[0]?.op === "update_props") {
    assert.notEqual(pending.plan.ops[0].blockId, "b_cardgrid_new")
  }
})

test("plan_only rewrites add_block CardGrid image request phrased as 'to each card'", async (t) => {
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
  })
  const session = newSession()
  const mockedPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Added CardGrid.",
    change_log: ["Added CardGrid."],
    ops: [
      {
        op: "add_block",
        pageSlug: "/",
        block: {
          id: "b_cardgrid_new",
          type: "CardGrid",
          props: {
            title: "Explore more",
            cards: [
              { title: "One", description: "Desc", ctaText: "Learn", ctaHref: "/" },
              { title: "Two", description: "Desc", ctaText: "Learn", ctaHref: "/" }
            ]
          }
        }
      }
    ]
  }
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: mockedPlan, usage: { ...ZERO_USAGE }, schemaContext: STUB_SCHEMA_CONTEXT }))

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "generate and add images to each card usign unsplash and text from cards",
      executionMode: "plan_only"
    }
  })
  assert.equal(response.statusCode, 200)
  const payload = response.json() as { status?: string; pendingPlanId?: string }
  assert.equal(payload.status, "plan_ready")
  assert.ok(payload.pendingPlanId)

  const pending = pendingApprovalPlanBySession.get(session)
  assert.ok(pending)
  assert.equal(pending?.plan.ops[0]?.op, "update_props")
  if (pending?.plan.ops[0]?.op === "update_props") {
    assert.notEqual(pending.plan.ops[0].blockId, "b_cardgrid_new")
  }
})

test("compact context experiment reduces planner context payload for simple rewrite requests", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  const previousCompact = process.env.CHAT_COMPACT_CONTEXT_EXPERIMENT
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  delete process.env.CHAT_COMPACT_CONTEXT_EXPERIMENT

  const capturedSizes: number[] = []
  const mockedPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Updated selected block copy.",
    change_log: ["Updated selected block copy."],
    ops: [{ op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: "Refined heading" } }]
  }

  setGeneratePlanWithOpenAIForTests(async ({ contextPack }) => {
    capturedSizes.push(JSON.stringify(contextPack).length)
    return { plan: mockedPlan, usage: { ...ZERO_USAGE }, schemaContext: STUB_SCHEMA_CONTEXT }
  })

  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
    if (previousCompact === undefined) delete process.env.CHAT_COMPACT_CONTEXT_EXPERIMENT
    else process.env.CHAT_COMPACT_CONTEXT_EXPERIMENT = previousCompact
  })

  const session = newSession()
  const payload = {
    session,
    slug: "/",
    message: "rewrite this copy to be more benefit-driven and action-oriented",
    executionMode: "plan_only",
    activeBlockId: "b_hero_home"
  }

  const baseline = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload
  })
  assert.equal(baseline.statusCode, 200)
  assert.equal((baseline.json() as { status?: string }).status, "plan_ready")

  process.env.CHAT_COMPACT_CONTEXT_EXPERIMENT = "1"
  const compact = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: { ...payload, session: newSession() }
  })
  assert.equal(compact.statusCode, 200)
  assert.equal((compact.json() as { status?: string }).status, "plan_ready")

  assert.equal(capturedSizes.length, 2)
  assert.ok(capturedSizes[1]! < capturedSizes[0]!, `expected compact context (${capturedSizes[1]}) < baseline (${capturedSizes[0]})`)
})

test("minimal context experiment further reduces planner payload for selected-block rewrite", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  const previousCompact = process.env.CHAT_COMPACT_CONTEXT_EXPERIMENT
  const previousMinimal = process.env.CHAT_MINIMAL_CONTEXT_EXPERIMENT
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  delete process.env.CHAT_COMPACT_CONTEXT_EXPERIMENT
  delete process.env.CHAT_MINIMAL_CONTEXT_EXPERIMENT

  const capturedSizes: number[] = []
  const mockedPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Updated selected block copy.",
    change_log: ["Updated selected block copy."],
    ops: [{ op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: "Sharper heading" } }]
  }

  setGeneratePlanWithOpenAIForTests(async ({ contextPack }) => {
    capturedSizes.push(JSON.stringify(contextPack).length)
    return { plan: mockedPlan, usage: { ...ZERO_USAGE }, schemaContext: STUB_SCHEMA_CONTEXT }
  })

  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
    if (previousCompact === undefined) delete process.env.CHAT_COMPACT_CONTEXT_EXPERIMENT
    else process.env.CHAT_COMPACT_CONTEXT_EXPERIMENT = previousCompact
    if (previousMinimal === undefined) delete process.env.CHAT_MINIMAL_CONTEXT_EXPERIMENT
    else process.env.CHAT_MINIMAL_CONTEXT_EXPERIMENT = previousMinimal
  })

  const payload = {
    slug: "/",
    message: "rewrite this copy to be more direct",
    executionMode: "plan_only",
    activeBlockId: "b_hero_home"
  }

  const baseline = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: { ...payload, session: newSession() }
  })
  assert.equal(baseline.statusCode, 200)

  process.env.CHAT_COMPACT_CONTEXT_EXPERIMENT = "1"
  const compact = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: { ...payload, session: newSession() }
  })
  assert.equal(compact.statusCode, 200)

  process.env.CHAT_MINIMAL_CONTEXT_EXPERIMENT = "1"
  const minimal = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: { ...payload, session: newSession() }
  })
  assert.equal(minimal.statusCode, 200)

  assert.equal(capturedSizes.length, 3)
  assert.ok(capturedSizes[1]! < capturedSizes[0]!, `expected compact context (${capturedSizes[1]}) < baseline (${capturedSizes[0]})`)
  assert.ok(capturedSizes[2]! < capturedSizes[1]!, `expected minimal context (${capturedSizes[2]}) < compact (${capturedSizes[1]})`)
})

test("result debug timeline records first_structured_progress when planner streams op candidates", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"

  setGeneratePlanWithOpenAIForTests(async ({ onPlannedOp }) => {
    onPlannedOp?.({ op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: "Streamed heading" } }, 1)
    return {
      plan: {
        intent: "edit_plan",
        summary_for_user: "Updated hero heading.",
        change_log: ["Updated hero heading."],
        ops: [{ op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: "Streamed heading" } }]
      },
      usage: { ...ZERO_USAGE },
      schemaContext: STUB_SCHEMA_CONTEXT
    }
  })

  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session: newSession(),
      slug: "/",
      message: "rewrite this copy to improve conversion",
      activeBlockId: "b_hero_home"
    }
  })
  assert.equal(response.statusCode, 200)
  const payload = response.json() as {
    status?: string
    debug?: {
      timeline?: Array<{ stage?: string; atMs?: number }>
    }
  }
  assert.equal(payload.status, "applied")
  const stages = (payload.debug?.timeline ?? []).map((entry) => entry.stage)
  assert.ok(stages.includes("first_structured_progress"))
})

test("plan_only does not rewrite when prompt asks for a new CardGrid", async (t) => {
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
  })
  const session = newSession()
  const mockedPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Added CardGrid.",
    change_log: ["Added CardGrid."],
    ops: [
      {
        op: "add_block",
        pageSlug: "/",
        block: {
          id: "b_cardgrid_new",
          type: "CardGrid",
          props: {
            title: "Explore more",
            cards: [
              { title: "One", description: "Desc", ctaText: "Learn", ctaHref: "/" },
              { title: "Two", description: "Desc", ctaText: "Learn", ctaHref: "/" }
            ]
          }
        }
      }
    ]
  }
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: mockedPlan, usage: { ...ZERO_USAGE }, schemaContext: STUB_SCHEMA_CONTEXT }))

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "add a new card grid with images for each card from unsplash",
      executionMode: "plan_only"
    }
  })
  assert.equal(response.statusCode, 200)
  const payload = response.json() as { status?: string; pendingPlanId?: string }
  assert.equal(payload.status, "plan_ready")
  assert.ok(payload.pendingPlanId)

  const pending = pendingApprovalPlanBySession.get(session)
  assert.ok(pending)
  assert.equal(pending?.plan.ops[0]?.op, "add_block")
})

test("plan_only rewrites add_block Card image request to existing CardGrid", async (t) => {
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
  })

  const session = newSession()
  const createPage = await app.inject({
    method: "POST",
    url: "/ops",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      ops: [
        {
          op: "create_page",
          page: {
            id: "p_test_cardgrid",
            slug: "/test-cardgrid",
            title: "Test CardGrid",
            updatedAt: new Date().toISOString(),
            blocks: [
              {
                id: "b_cardgrid_test",
                type: "CardGrid",
                props: {
                  title: "Facts",
                  cards: [
                    { title: "One", description: "Desc", ctaText: "Learn", ctaHref: "/" },
                    { title: "Two", description: "Desc", ctaText: "Learn", ctaHref: "/" }
                  ]
                }
              },
              {
                id: "b_card_standalone",
                type: "Card",
                props: {
                  title: "Standalone card",
                  description: "Desc",
                  ctaText: "Learn",
                  ctaHref: "/"
                }
              }
            ]
          }
        }
      ]
    }
  })
  assert.equal(createPage.statusCode, 200)

  const mockedPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Added Card.",
    change_log: ["Added Card."],
    ops: [
      {
        op: "add_block",
        pageSlug: "/test-cardgrid",
        block: {
          id: "b_card_new",
          type: "Card",
          props: {
            title: "New card",
            description: "Desc",
            ctaText: "Learn",
            ctaHref: "/"
          }
        }
      }
    ]
  }
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: mockedPlan, usage: { ...ZERO_USAGE }, schemaContext: STUB_SCHEMA_CONTEXT }))

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/test-cardgrid",
      message: "generate and add images to each card usign unsplash and text from cards",
      executionMode: "plan_only"
    }
  })
  assert.equal(response.statusCode, 200)
  const payload = response.json() as { status?: string; pendingPlanId?: string }
  assert.equal(payload.status, "plan_ready")
  assert.ok(payload.pendingPlanId)

  const pending = pendingApprovalPlanBySession.get(session)
  assert.ok(pending)
  assert.equal(pending?.plan.ops[0]?.op, "update_props")
  if (pending?.plan.ops[0]?.op === "update_props") {
    assert.equal(pending.plan.ops[0].blockId, "b_cardgrid_test")
  }
})

test("plan_only rewrites add_block image request even when planner emits wrong pageSlug", async (t) => {
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
  })

  const session = newSession()
  const createPage = await app.inject({
    method: "POST",
    url: "/ops",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      ops: [
        {
          op: "create_page",
          page: {
            id: "p_test_wrong_slug",
            slug: "/test-wrong-slug",
            title: "Test Wrong Slug",
            updatedAt: new Date().toISOString(),
            blocks: [
              {
                id: "b_cardgrid_wrong_slug",
                type: "CardGrid",
                props: {
                  title: "Facts",
                  cards: [
                    { title: "One", description: "Desc", ctaText: "Learn", ctaHref: "/" },
                    { title: "Two", description: "Desc", ctaText: "Learn", ctaHref: "/" }
                  ]
                }
              }
            ]
          }
        }
      ]
    }
  })
  assert.equal(createPage.statusCode, 200)

  const mockedPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Added Card.",
    change_log: ["Added Card."],
    ops: [
      {
        op: "add_block",
        pageSlug: "/",
        block: {
          id: "b_card_new_wrong_slug",
          type: "Card",
          props: {
            title: "New card",
            description: "Desc",
            ctaText: "Learn",
            ctaHref: "/"
          }
        }
      }
    ]
  }
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: mockedPlan, usage: { ...ZERO_USAGE }, schemaContext: STUB_SCHEMA_CONTEXT }))

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/test-wrong-slug",
      message: "generate and add images to each card usign unsplash and text from cards",
      executionMode: "plan_only"
    }
  })
  assert.equal(response.statusCode, 200)
  const payload = response.json() as { status?: string; pendingPlanId?: string }
  assert.equal(payload.status, "plan_ready")
  assert.ok(payload.pendingPlanId)

  const pending = pendingApprovalPlanBySession.get(session)
  assert.ok(pending)
  assert.equal(pending?.plan.ops[0]?.op, "update_props")
  if (pending?.plan.ops[0]?.op === "update_props") {
    assert.equal(pending.plan.ops[0].pageSlug, "/test-wrong-slug")
    assert.equal(pending.plan.ops[0].blockId, "b_cardgrid_wrong_slug")
  }
})

test("shouldResolveCreatePageHeroImage returns true for local placeholder urls", () => {
  assert.equal(shouldResolveCreatePageHeroImage(""), true)
  assert.equal(shouldResolveCreatePageHeroImage("/hero-generated.svg"), true)
  assert.equal(shouldResolveCreatePageHeroImage("hero-generated.svg"), true)
})

test("shouldResolveCreatePageHeroImage returns false for explicit remote urls", () => {
  assert.equal(shouldResolveCreatePageHeroImage("https://example.com/hero.jpg"), false)
  assert.equal(shouldResolveCreatePageHeroImage("http://example.com/hero.jpg"), false)
})

test("chat applies remove via real LLM intent router without calling full model planner", async (t) => {
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
  })

  const session = newSession()
  // Full planner should NOT be called — the cheap LLM intent router should handle it
  setGeneratePlanWithOpenAIForTests(async () => {
    throw new Error("full model planner should not be called for LLM-routed remove")
  })

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "remove hero section",
      provider: "anthropic",
      modelKey: "balanced"
    }
  })

  assert.equal(response.statusCode, 200)
  const payload = response.json() as { status?: string; summary?: string }
  assert.equal(payload.status, "applied", `expected applied, got ${payload.status}: ${payload.summary}`)
  assert.match(String(payload.summary), /Removed|removed|Hero/i)

  const pageRes = await app.inject({
    method: "GET",
    url: `/draft/pages?session=${encodeURIComponent(session)}&slug=${encodeURIComponent("/")}`
  })
  assert.equal(pageRes.statusCode, 200)
  const page = pageRes.json() as { blocks: Array<{ id: string }> }
  assert.equal(page.blocks.some((block) => block.id === "b_hero_home"), false)
})

test("rewrite without selected editable path falls back to model planner", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const targetHeading = `Model rewrite ${Date.now()}`
  let plannerCalls = 0
  setGeneratePlanWithOpenAIForTests(async () => {
    plannerCalls += 1
    return {
      plan: {
        intent: "edit_plan",
        summary_for_user: "Rewrite heading.",
        change_log: ["Rewrite heading."],
        ops: [{ op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: targetHeading } }]
      },
      usage: { ...ZERO_USAGE },
      schemaContext: STUB_SCHEMA_CONTEXT
    }
  })

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "rewrite this copy",
      activeBlockId: "b_hero_home"
    }
  })
  assert.equal(response.statusCode, 200)
  const payload = response.json() as { status?: string }
  assert.equal(payload.status, "applied")
  assert.equal(plannerCalls, 1)

  const pageRes = await app.inject({
    method: "GET",
    url: `/draft/pages?session=${encodeURIComponent(session)}&slug=${encodeURIComponent("/")}`
  })
  assert.equal(pageRes.statusCode, 200)
  const page = pageRes.json() as { blocks: Array<{ id: string; props: Record<string, unknown> }> }
  const hero = page.blocks.find((block) => block.id === "b_hero_home")
  assert.ok(hero)
  assert.equal(hero?.props.heading, targetHeading)
})

// TODO: deterministic rewrite was disabled (see
// apps/orchestrator/src/chat/chat-pipeline-deterministic.ts ~line 385 — the
// helper now always returns null because the substitution-based rewrite was
// too simplistic). Rewrite is now delegated to the LLM planner, so this test's
// "planner must not be called" assertion is no longer valid. Skip until the
// deterministic path is restored or until we rewrite the test to assert the
// LLM-path sanitization behaviour instead.
test("focused deterministic rewrite sanitizes markdown emphasis", { skip: "deterministic rewrite path disabled — see chat-pipeline-deterministic.ts" }, async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  setGeneratePlanWithOpenAIForTests(async () => {
    throw new Error("model planner should not be called for focused deterministic rewrite")
  })

  const createPage = await app.inject({
    method: "POST",
    url: "/ops",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      ops: [
        {
          op: "create_page",
          page: {
            id: "p_rewrite_test",
            slug: "/rewrite-test",
            title: "Rewrite Test",
            updatedAt: new Date().toISOString(),
            blocks: [
              {
                id: "b_richtext_rewrite",
                type: "RichText",
                props: {
                  title: "Keep title",
                  body: "**Amazing** [offers](https://example.com) for very teams"
                }
              }
            ]
          }
        }
      ]
    }
  })
  assert.equal(createPage.statusCode, 200)

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/rewrite-test",
      message: "rewrite this copy",
      activeBlockId: "b_richtext_rewrite",
      activeEditablePath: "body"
    }
  })
  assert.equal(response.statusCode, 200)
  const payload = response.json() as { status?: string }
  assert.equal(payload.status, "applied")

  const pageRes = await app.inject({
    method: "GET",
    url: `/draft/pages?session=${encodeURIComponent(session)}&slug=${encodeURIComponent("/rewrite-test")}`
  })
  assert.equal(pageRes.statusCode, 200)
  const page = pageRes.json() as { blocks: Array<{ id: string; props: Record<string, unknown> }> }
  const richText = page.blocks.find((block) => block.id === "b_richtext_rewrite")
  assert.ok(richText)
  const body = String(richText?.props.body ?? "")
  assert.equal(body.includes("**"), false)
  assert.equal(body.includes("["), false)
  assert.equal(body.includes("]("), false)
  assert.equal(richText?.props.title, "Keep title")
})

test("chat stream emits op_applied events for mocked multi-op plan", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const mockedPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Updated hero copy.",
    change_log: ["Changed heading and subheading."],
    ops: [
      { op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: `Stream heading ${Date.now()}` } },
      { op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { subheading: `Stream subheading ${Date.now()}` } }
    ]
  }
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: mockedPlan, usage: { ...ZERO_USAGE }, schemaContext: STUB_SCHEMA_CONTEXT }))

  const response = await app.inject({
    method: "GET",
    url: `/chat/stream?session=${encodeURIComponent(session)}&slug=${encodeURIComponent("/")}&message=${encodeURIComponent("update hero copy")}`
  })
  assert.equal(response.statusCode, 200)

  const events = parseSseData(response.body)
  const opApplied = events.filter((event) => event.type === "op_applied")
  assert.equal(opApplied.length, mockedPlan.ops.length)
  const finalEvent = events.find((event) => event.type === "final")
  assert.ok(finalEvent)
  const result = (finalEvent as { result?: Record<string, unknown> }).result
  assert.ok(result)
  assert.equal(result?.status, "applied")
})

test("chat stream emits field_draft events before op_applied for mocked planner drafts", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const mockedPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Updated hero heading.",
    change_log: ["Changed hero heading."],
    ops: [{ op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: `Streaming ${Date.now()}` } }]
  }
  setGeneratePlanWithOpenAIForTests(async (args) => {
    args.onFieldDraft?.({ blockId: "b_hero_home", editablePath: "heading", value: "S" })
    args.onFieldDraft?.({ blockId: "b_hero_home", editablePath: "heading", value: "St" })
    args.onFieldDraft?.({ blockId: "b_hero_home", editablePath: "heading", value: "Str" })
    return { plan: mockedPlan, usage: { ...ZERO_USAGE }, schemaContext: STUB_SCHEMA_CONTEXT }
  })

  const response = await app.inject({
    method: "GET",
    url: `/chat/stream?session=${encodeURIComponent(session)}&slug=${encodeURIComponent("/")}&message=${encodeURIComponent("update hero heading")}`
  })
  assert.equal(response.statusCode, 200)

  const events = parseSseData(response.body)
  const fieldDraftEvents = events.filter((event) => event.type === "field_draft")
  assert.equal(fieldDraftEvents.length, 3)
  assert.deepEqual(fieldDraftEvents.map((event) => event.value), ["S", "St", "Str"])

  const firstFieldDraftIndex = events.findIndex((event) => event.type === "field_draft")
  const firstOpAppliedIndex = events.findIndex((event) => event.type === "op_applied")
  assert.ok(firstFieldDraftIndex >= 0, "expected at least one field_draft event")
  assert.ok(firstOpAppliedIndex >= 0, "expected op_applied event")
  assert.ok(firstFieldDraftIndex < firstOpAppliedIndex, "field_draft should be emitted before op_applied")
})

test("chat stream afterSeq replay includes field_draft events", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const mockedPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Updated hero heading.",
    change_log: ["Changed hero heading."],
    ops: [{ op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: `Replay ${Date.now()}` } }]
  }
  setGeneratePlanWithOpenAIForTests(async (args) => {
    args.onFieldDraft?.({ blockId: "b_hero_home", editablePath: "heading", value: "R" })
    args.onFieldDraft?.({ blockId: "b_hero_home", editablePath: "heading", value: "Re" })
    return { plan: mockedPlan, usage: { ...ZERO_USAGE }, schemaContext: STUB_SCHEMA_CONTEXT }
  })

  const startRes = await app.inject({
    method: "POST",
    url: "/chat/start",
    headers: { "content-type": "application/json" },
    payload: { session, slug: "/", message: "update hero heading replay" }
  })
  assert.equal(startRes.statusCode, 200)
  const { streamId } = startRes.json() as { streamId: string }

  const streamRes = await app.inject({
    method: "GET",
    url: `/chat/stream?streamId=${streamId}`
  })
  assert.equal(streamRes.statusCode, 200)
  const events = parseSseData(streamRes.body)
  const firstFieldDraft = events.find((event) => event.type === "field_draft" && typeof event._seq === "number")
  assert.ok(firstFieldDraft, "expected a field_draft event with sequence number")
  const firstFieldDraftSeq = Number(firstFieldDraft._seq)
  assert.ok(Number.isFinite(firstFieldDraftSeq) && firstFieldDraftSeq > 0)

  const replayRes = await app.inject({
    method: "GET",
    url: `/chat/stream?streamId=${streamId}&afterSeq=${firstFieldDraftSeq - 1}`
  })
  assert.equal(replayRes.statusCode, 200)
  const replayEvents = parseSseData(replayRes.body)
  assert.ok(
    replayEvents.some((event) => event.type === "field_draft"),
    "expected replay to include at least one field_draft event"
  )
})

test("chat telemetry includes received -> plan_generated -> result phases for mocked planner run", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const mockedPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Updated heading for telemetry.",
    change_log: ["Changed heading."],
    ops: [{ op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: `Telemetry ${Date.now()}` } }]
  }
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: mockedPlan, usage: { ...ZERO_USAGE }, schemaContext: STUB_SCHEMA_CONTEXT }))

  const chatResponse = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "update hero heading"
    }
  })
  assert.equal(chatResponse.statusCode, 200)

  const telemetryResponse = await app.inject({
    method: "GET",
    url: `/telemetry/chat?session=${encodeURIComponent(session)}&limit=50`
  })
  assert.equal(telemetryResponse.statusCode, 200)
  const telemetry = telemetryResponse.json() as {
    rows?: Array<{ phase?: string }>
  }
  const phases = new Set((telemetry.rows ?? []).map((row) => row.phase))
  assert.ok(phases.has("received"))
  assert.ok(phases.has("plan_generated"))
  assert.ok(phases.has("result"))
})

test("chat discard_pending_plan returns canceled when no pending plan exists", async () => {
  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      executionMode: "discard_pending_plan"
    }
  })
  assert.equal(response.statusCode, 200)
  const payload = response.json() as { status?: string; summary?: string }
  assert.equal(payload.status, "canceled")
  assert.match(String(payload.summary), /No pending plan to stop/i)
})

test("chat pending-plan lifecycle: mismatch ids for discard/apply return 409", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const mockedPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Ready plan for mismatch checks.",
    change_log: ["Prepared heading update."],
    ops: [{ op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: `Mismatch ${Date.now()}` } }]
  }
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: mockedPlan, usage: { ...ZERO_USAGE }, schemaContext: STUB_SCHEMA_CONTEXT }))

  const planReady = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "change hero heading",
      executionMode: "plan_only"
    }
  })
  assert.equal(planReady.statusCode, 200)
  const planPayload = planReady.json() as { pendingPlanId?: string }
  assert.equal(typeof planPayload.pendingPlanId, "string")
  assert.ok(planPayload.pendingPlanId)

  const badApply = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      executionMode: "apply_pending_plan",
      pendingPlanId: "wrong-pending-id"
    }
  })
  assert.equal(badApply.statusCode, 409)
  const applyPayload = badApply.json() as { status?: string; summary?: string }
  assert.equal(applyPayload.status, "validation_error")
  assert.match(String(applyPayload.summary), /does not match/i)

  const badDiscard = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      executionMode: "discard_pending_plan",
      pendingPlanId: "wrong-pending-id"
    }
  })
  assert.equal(badDiscard.statusCode, 409)
  const discardPayload = badDiscard.json() as { error?: string }
  assert.match(String(discardPayload.error), /pending plan mismatch/i)
})

test("chat returns planning_exhausted after three failed OpenAI planning attempts", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  let attempts = 0
  setGeneratePlanWithOpenAIForTests(async () => {
    attempts += 1
    throw new Error("invalid planner payload")
  })
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "update hero heading in a safer way"
    }
  })

  assert.equal(response.statusCode, 500)
  assert.equal(attempts, 3)
  const payload = response.json() as { status?: string; debug?: { outcome?: string }; validationErrors?: string[] }
  assert.equal(payload.status, "error")
  assert.equal(payload.debug?.outcome, "planning_exhausted")
  assert.ok(Array.isArray(payload.validationErrors))
  assert.equal(payload.validationErrors?.length, 3)
})

test("chat redirects variation-like typo prompt to clarification instead of planner exhaustion", async () => {
  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "generate 4 content variaqtions"
    }
  })

  assert.equal(response.statusCode, 200)
  const payload = response.json() as {
    status?: string
    summary?: string
    debug?: { outcome?: string; reasonCategory?: string }
    suggestions?: string[]
  }
  assert.equal(payload.status, "needs_clarification")
  assert.equal(payload.debug?.outcome, "variation_request_redirect")
  assert.equal(payload.debug?.reasonCategory, "ambiguity")
  assert.match(String(payload.summary), /select a block/i)
  assert.ok(Array.isArray(payload.suggestions))
})

test("chat redirects 'show me 3 variants' without activeBlockId to clarification", async () => {
  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "show me 3 variants"
    }
  })

  assert.equal(response.statusCode, 200)
  const payload = response.json() as {
    status?: string
    summary?: string
    debug?: { outcome?: string; reasonCategory?: string }
    suggestions?: string[]
  }
  assert.equal(payload.status, "needs_clarification")
  assert.equal(payload.debug?.outcome, "variation_request_redirect")
  assert.match(String(payload.summary), /select a block/i)
})

test("chat routes 'show me 3 variants' with activeBlockId to variation pipeline", async () => {
  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "show me 3 variants",
      activeBlockId: "b_hero_home",
      activeBlockType: "Hero",
      provider: "demo"
    }
  })

  // The variation pipeline should respond (either success or error, but NOT needs_clarification)
  const payload = response.json() as { status?: string; error?: string; variations?: unknown[] }
  assert.notEqual(payload.status, "needs_clarification", "should not redirect to clarification when activeBlockId is set")
})

test("chat returns repair_failed when deterministic repair generation throws", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  // Unknown props are silently stripped (planner_hallucinated_prop), so use an
  // enum violation that actually fails Zod validation and triggers the repair
  // path. imagePosition only accepts "left" | "right" | "full".
  const invalidPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Try unsupported hero field.",
    change_log: ["Attempted invalid patch."],
    ops: [
      {
        op: "update_props",
        pageSlug: "/",
        blockId: "b_hero_home",
        patch: { imagePosition: "middle" } as Record<string, unknown>
      }
    ]
  }
  let calls = 0
  setGeneratePlanWithOpenAIForTests(async () => {
    calls += 1
    if (calls === 1) return { plan: invalidPlan, usage: { ...ZERO_USAGE }, schemaContext: STUB_SCHEMA_CONTEXT }
    throw new Error("invalid repair response")
  })
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "change hero heading"
    }
  })

  assert.equal(response.statusCode, 400)
  assert.equal(calls, 2)
  const payload = response.json() as { status?: string; debug?: { outcome?: string }; validationErrors?: string[] }
  assert.equal(payload.status, "validation_error")
  assert.equal(payload.debug?.outcome, "repair_failed")
  assert.ok(Array.isArray(payload.validationErrors))
  assert.match(String(payload.validationErrors?.[0]), /schema_violation/i)
})

test("chat apply_pending_plan without pending plan and no message returns pending_plan_missing", async () => {
  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      executionMode: "apply_pending_plan"
    }
  })

  assert.equal(response.statusCode, 409)
  const payload = response.json() as { status?: string; debug?: { outcome?: string }; summary?: string }
  assert.equal(payload.status, "needs_clarification")
  assert.equal(payload.debug?.outcome, "pending_plan_missing")
  assert.match(String(payload.summary), /No pending plan/i)
})

test("chat applies repaired OpenAI plan after initial schema violation", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  // imagePosition enum violation triggers schema_violation → repair, whereas
  // unknown props are silently stripped without ever invoking repair.
  const invalidPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Invalid first attempt.",
    change_log: ["Attempted invalid patch."],
    ops: [
      {
        op: "update_props",
        pageSlug: "/",
        blockId: "b_hero_home",
        patch: { imagePosition: "middle" } as Record<string, unknown>
      }
    ]
  }
  const repairedHeading = `Repaired heading ${Date.now()}`
  const repairedPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Updated hero heading after repair.",
    change_log: ["Applied repaired heading update."],
    ops: [{ op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: repairedHeading } }]
  }
  let calls = 0
  setGeneratePlanWithOpenAIForTests(async () => {
    calls += 1
    return { plan: calls === 1 ? invalidPlan : repairedPlan, usage: { ...ZERO_USAGE }, schemaContext: STUB_SCHEMA_CONTEXT }
  })
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "change hero heading"
    }
  })

  assert.equal(response.statusCode, 200)
  assert.equal(calls, 2)
  const payload = response.json() as { status?: string; summary?: string }
  assert.equal(payload.status, "applied")
  assert.match(String(payload.summary), /after repair/i)
})

test("chat returns guardrail failure when repaired plan still fails to apply", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  // imagePosition enum violation reliably triggers schema_violation → repair.
  const invalidPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Invalid first attempt.",
    change_log: ["Attempted invalid patch."],
    ops: [
      {
        op: "update_props",
        pageSlug: "/",
        blockId: "b_hero_home",
        patch: { imagePosition: "middle" } as Record<string, unknown>
      }
    ]
  }
  // Repair attempt also violates schema → repair_failed.
  const stillBadRepairPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Still invalid after repair.",
    change_log: ["Attempted another invalid enum value."],
    ops: [
      {
        op: "update_props",
        pageSlug: "/",
        blockId: "b_hero_home",
        patch: { imagePosition: "diagonal" } as Record<string, unknown>
      }
    ]
  }
  setGeneratePlanWithOpenAIForTests(async ({ feedback }) => ({ plan: feedback ? stillBadRepairPlan : invalidPlan, usage: { ...ZERO_USAGE }, schemaContext: STUB_SCHEMA_CONTEXT }))
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "change hero heading"
    }
  })

  assert.equal(response.statusCode, 400)
  const payload = response.json() as { status?: string; debug?: { reasonCategory?: string } }
  assert.equal(payload.status, "validation_error")
  assert.equal(payload.debug?.reasonCategory, "schema_violation")
})

test("chat returns planning_missing when planner returns null plan", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: null as unknown as EditPlan, usage: { ...ZERO_USAGE }, schemaContext: STUB_SCHEMA_CONTEXT }))
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "change hero heading"
    }
  })

  assert.equal(response.statusCode, 500)
  const payload = response.json() as { status?: string; debug?: { outcome?: string } }
  assert.equal(payload.status, "error")
  assert.equal(payload.debug?.outcome, "planning_missing")
})

test("chat returns needs_clarification without repair when planner refuses output", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  let calls = 0
  setGeneratePlanWithOpenAIForTests(async () => {
    calls += 1
    throw new PlannerOutputError("Model refused planning output: unsafe request", {
      reasonCategory: "planner_refusal",
      retryable: false
    })
  })
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "change hero heading"
    }
  })

  assert.equal(response.statusCode, 200)
  assert.equal(calls, 1)
  const payload = response.json() as { status?: string; debug?: { outcome?: string; reasonCategory?: string } }
  assert.equal(payload.status, "needs_clarification")
  assert.equal(payload.debug?.outcome, "planning_refusal")
  assert.equal(payload.debug?.reasonCategory, "planner_refusal")
})

test("chat returns error without repair when planner output is incomplete", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  let calls = 0
  setGeneratePlanWithOpenAIForTests(async () => {
    calls += 1
    throw new PlannerOutputError("Model returned incomplete planning output", {
      reasonCategory: "incomplete_output",
      retryable: false
    })
  })
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "change hero heading"
    }
  })

  assert.equal(response.statusCode, 500)
  assert.equal(calls, 1)
  const payload = response.json() as { status?: string; debug?: { outcome?: string; reasonCategory?: string } }
  assert.equal(payload.status, "error")
  assert.equal(payload.debug?.outcome, "planning_incomplete")
  assert.equal(payload.debug?.reasonCategory, "incomplete_output")
})

test("chat returns direct guardrail failure when initial apply error is not repair-eligible", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  const invalidPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Invalid not-found plan.",
    change_log: ["Attempted update on missing block."],
    ops: [{ op: "update_props", pageSlug: "/", blockId: "missing_block", patch: { heading: "x" } }]
  }
  let calls = 0
  setGeneratePlanWithOpenAIForTests(async () => {
    calls += 1
    return { plan: invalidPlan, usage: { ...ZERO_USAGE }, schemaContext: STUB_SCHEMA_CONTEXT }
  })
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "change hero heading"
    }
  })

  assert.equal(response.statusCode, 400)
  assert.equal(calls, 1)
  const payload = response.json() as { status?: string; debug?: { reasonCategory?: string } }
  assert.equal(payload.status, "validation_error")
  assert.equal(payload.debug?.reasonCategory, "not_found")
})

test("chat returns no_effective_change when plan updates a prop to its current value", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"

  const session = newSession()
  const pageRes = await app.inject({
    method: "GET",
    url: `/draft/pages?session=${encodeURIComponent(session)}&slug=${encodeURIComponent("/")}`
  })
  assert.equal(pageRes.statusCode, 200)
  const page = pageRes.json() as { blocks: Array<{ id: string; props: Record<string, unknown> }> }
  const hero = page.blocks.find((block) => block.id === "b_hero_home")
  assert.ok(hero)
  const currentHeading = String(hero?.props.heading ?? "")
  assert.ok(currentHeading.length > 0)

  const noOpPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "No-op heading update.",
    change_log: ["Tried to set heading to the same value."],
    ops: [{ op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: currentHeading } }]
  }
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: noOpPlan, usage: { ...ZERO_USAGE }, schemaContext: STUB_SCHEMA_CONTEXT }))
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "set hero heading to the same text"
    }
  })

  assert.equal(response.statusCode, 200)
  const payload = response.json() as { status?: string; summary?: string; debug?: { outcome?: string } }
  assert.equal(payload.status, "applied")
  assert.match(String(payload.summary), /already up to date/i)
  assert.equal(payload.debug?.outcome, "no_effective_change")
})

test("chat uses demo planner path when OPENAI_API_KEY is missing", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  const previousAnthropicKey = process.env.ANTHROPIC_API_KEY
  const previousGoogleKey = process.env.GOOGLE_GENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.GOOGLE_GENAI_API_KEY
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
    if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousAnthropicKey
    if (previousGoogleKey === undefined) delete process.env.GOOGLE_GENAI_API_KEY
    else process.env.GOOGLE_GENAI_API_KEY = previousGoogleKey
  })

  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "add testimonials"
    }
  })

  assert.equal(response.statusCode, 200)
  const payload = response.json() as { status?: string; plannerSource?: string; summary?: string }
  assert.equal(payload.status, "applied")
  assert.equal(payload.plannerSource, "demo")
  assert.match(String(payload.summary), /testimonials/i)
})

test("chat returns planner_exception when demo planner throws", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  const previousAnthropicKey = process.env.ANTHROPIC_API_KEY
  const previousGoogleKey = process.env.GOOGLE_GENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.GOOGLE_GENAI_API_KEY
  setDemoPlanFromMessageForTests(() => {
    throw new Error("demo planner exploded")
  })
  t.after(() => {
    setDemoPlanFromMessageForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
    if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousAnthropicKey
    if (previousGoogleKey === undefined) delete process.env.GOOGLE_GENAI_API_KEY
    else process.env.GOOGLE_GENAI_API_KEY = previousGoogleKey
  })

  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "anything"
    }
  })

  assert.equal(response.statusCode, 500)
  const payload = response.json() as { status?: string; debug?: { outcome?: string }; plannerSource?: string }
  assert.equal(payload.status, "error")
  assert.equal(payload.debug?.outcome, "planner_exception")
  assert.equal(payload.plannerSource, "demo")
})

test("chat unsplash hero request: LLM placeholder matching current value still applies (no false no_effective_change)", async (t) => {
  // Regression for traceId a3508c99: "populate hero image with unsplash" returned
  // "No changes needed" because the LLM emitted update_props with imageUrl equal to
  // the current placeholder (/hero-generated.svg). The image-strip block left the
  // patch empty → applyOpsAtomically threw no_effective_change → deferred image
  // resolution never ran. Strip should leave a shimmer placeholder behind so apply
  // succeeds and downstream resolution can swap in the real image.
  const previousKey = process.env.OPENAI_API_KEY
  const previousUnsplash = process.env.UNSPLASH_ACCESS_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  delete process.env.UNSPLASH_ACCESS_KEY
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
    if (previousUnsplash === undefined) delete process.env.UNSPLASH_ACCESS_KEY
    else process.env.UNSPLASH_ACCESS_KEY = previousUnsplash
  })

  const session = newSession()
  const placeholderUrl = "/hero-generated.svg"
  const createPage = await app.inject({
    method: "POST",
    url: "/ops",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      ops: [
        {
          op: "create_page",
          page: {
            id: "p_spring",
            slug: "/spring",
            title: "Spring",
            updatedAt: new Date().toISOString(),
            blocks: [
              {
                id: "b_hero_spring",
                type: "Hero",
                props: {
                  heading: "Spring Avocados",
                  subheading: "Fresh from the orchard",
                  ctaText: "Shop",
                  ctaHref: "/",
                  imageUrl: placeholderUrl,
                  imageAlt: "spring avocados"
                }
              }
            ]
          }
        }
      ]
    }
  })
  assert.equal(createPage.statusCode, 200)

  // Mock the planner to mimic what Claude Haiku 4.5 actually did in trace
  // a3508c99: an update_props on the Hero whose imageUrl is identical to the
  // current value (the placeholder).
  const mockedPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Populate hero image from Unsplash.",
    change_log: ["Set the hero image."],
    ops: [
      {
        op: "update_props",
        pageSlug: "/spring",
        blockId: "b_hero_spring",
        patch: { props: { imageUrl: placeholderUrl, imageAlt: "spring avocados from unsplash" } }
      }
    ]
  }
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: mockedPlan, usage: { ...ZERO_USAGE }, schemaContext: STUB_SCHEMA_CONTEXT }))

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/spring",
      message: "populate hero image with unsplash"
    }
  })

  assert.equal(response.statusCode, 200)
  const payload = response.json() as { status?: string; summary?: string; debug?: { outcome?: string } }
  assert.notEqual(
    payload.debug?.outcome,
    "no_effective_change",
    `expected apply to succeed (shimmer placeholder), got no_effective_change with summary: ${payload.summary}`
  )
  assert.doesNotMatch(String(payload.summary ?? ""), /already up to date/i)
})

// ---------------------------------------------------------------------------
// PHASE-1 auto-routing shadow tests
// Validates that when the LLM intent router emits complexity: "complex" we
// log a shadow event and stamp `debug.routingDecision` WITHOUT actually
// switching to the reasoning model. Flipping the behaviour live is gated
// behind CHAT_AUTO_UPGRADE_COMPLEX in a follow-up PR.
// ---------------------------------------------------------------------------

test("auto-routing: complex router signal stamps routingDecision in shadow mode and does NOT swap model", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  // Auto-routing depends on the parallel LLM intent router, which is disabled
  // at the top of this file for the repair-pipeline tests. Re-enable both flags.
  const previousRouter = process.env.CHAT_LLM_INTENT_ROUTER
  const previousParallel = process.env.CHAT_PARALLEL_PLANNER
  process.env.CHAT_LLM_INTENT_ROUTER = "1"
  process.env.CHAT_PARALLEL_PLANNER = "1"
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    setParseIntentWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
    if (previousRouter === undefined) delete process.env.CHAT_LLM_INTENT_ROUTER
    else process.env.CHAT_LLM_INTENT_ROUTER = previousRouter
    if (previousParallel === undefined) delete process.env.CHAT_PARALLEL_PLANNER
    else process.env.CHAT_PARALLEL_PLANNER = previousParallel
  })

  const session = newSession()
  const targetHeading = `Complex shadow run ${Date.now()}`

  // Router returns "complex" via clarify so its compile yields no usable plan
  // → full planner runs, which is when the routing decision is stamped.
  setParseIntentWithOpenAIForTests(async () => ({
    action: "clarify",
    target_block_ref: null,
    target_block_type: null,
    new_block_type: null,
    position: null,
    anchor_block_ref: null,
    summary: null,
    assumption: null,
    complexity: "complex"
  }))

  let plannerModelSeen: string | undefined
  setGeneratePlanWithOpenAIForTests(async (args) => {
    plannerModelSeen = args.model
    return {
      plan: {
        intent: "edit_plan",
        summary_for_user: "Rewrote hero heading.",
        change_log: ["Changed hero heading."],
        ops: [{ op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: targetHeading } }]
      },
      usage: { ...ZERO_USAGE },
      schemaContext: STUB_SCHEMA_CONTEXT
    }
  })

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      // "rewrite" makes shouldPreferFastModelForMessage true → likelySimple true
      // so the full planner awaits the router (deterministic; no race).
      message: "rewrite this copy",
      activeBlockId: "b_hero_home",
      // Explicit modelKey blocks the regex downgrade path so alreadyFastModel = false
      // and the await-router branch fires.
      modelKey: "balanced"
    }
  })

  assert.equal(response.statusCode, 200)
  const payload = response.json() as {
    status?: string
    modelUsed?: string
    debug?: {
      modelUsed?: string
      routingDecision?: {
        from?: string
        to?: string
        reason?: string
        complexity?: string
      }
    }
  }
  assert.equal(payload.status, "applied")

  // SHADOW assertion #1: routingDecision is stamped with reason "shadow".
  assert.ok(
    payload.debug?.routingDecision,
    `expected debug.routingDecision to be set, got: ${JSON.stringify(payload.debug)}`
  )
  assert.equal(payload.debug?.routingDecision?.reason, "shadow")
  assert.equal(payload.debug?.routingDecision?.complexity, "complex")
  assert.equal(payload.debug?.routingDecision?.from, "balanced")
  assert.equal(payload.debug?.routingDecision?.to, "reasoning")

  // SHADOW assertion #2: the planner was NOT actually called with the reasoning model.
  // It must still be the model resolved for modelKey "balanced".
  assert.ok(plannerModelSeen, "planner was not called")
  assert.ok(
    !/reasoning|opus|gpt-5|o[13]/i.test(String(plannerModelSeen)),
    `planner should not run on reasoning tier in shadow mode, got: ${plannerModelSeen}`
  )
})

test("auto-routing: simple router signal still downgrades AND stamps routingDecision", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  const previousRouter = process.env.CHAT_LLM_INTENT_ROUTER
  const previousParallel = process.env.CHAT_PARALLEL_PLANNER
  process.env.CHAT_LLM_INTENT_ROUTER = "1"
  process.env.CHAT_PARALLEL_PLANNER = "1"
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    setParseIntentWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
    if (previousRouter === undefined) delete process.env.CHAT_LLM_INTENT_ROUTER
    else process.env.CHAT_LLM_INTENT_ROUTER = previousRouter
    if (previousParallel === undefined) delete process.env.CHAT_PARALLEL_PLANNER
    else process.env.CHAT_PARALLEL_PLANNER = previousParallel
  })

  const session = newSession()
  const targetHeading = `Simple downgrade run ${Date.now()}`

  setParseIntentWithOpenAIForTests(async () => ({
    action: "clarify",
    target_block_ref: null,
    target_block_type: null,
    new_block_type: null,
    position: null,
    anchor_block_ref: null,
    summary: null,
    assumption: null,
    complexity: "simple"
  }))

  setGeneratePlanWithOpenAIForTests(async () => ({
    plan: {
      intent: "edit_plan",
      summary_for_user: "Rewrote hero heading.",
      change_log: ["Changed hero heading."],
      ops: [{ op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: targetHeading } }]
    },
    usage: { ...ZERO_USAGE },
    schemaContext: STUB_SCHEMA_CONTEXT
  }))

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "rewrite this copy",
      activeBlockId: "b_hero_home",
      modelKey: "balanced"
    }
  })

  assert.equal(response.statusCode, 200)
  const payload = response.json() as {
    status?: string
    debug?: {
      routingDecision?: { from?: string; to?: string; reason?: string; complexity?: string }
    }
  }
  assert.equal(payload.status, "applied")
  assert.equal(payload.debug?.routingDecision?.reason, "simple_downgrade")
  assert.equal(payload.debug?.routingDecision?.complexity, "simple")
  assert.equal(payload.debug?.routingDecision?.from, "balanced")
  assert.equal(payload.debug?.routingDecision?.to, "fast")
})
