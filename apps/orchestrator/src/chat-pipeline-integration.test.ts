import test from "node:test"
import assert from "node:assert/strict"
import type { EditPlan } from "@ai-site-editor/shared"
import { app } from "./index.js"
import {
  detectImageOps,
  setDemoPlanFromMessageForTests,
  setGeneratePlanWithOpenAIForTests,
  shouldResolveCreatePageHeroImage
} from "./chat/chat-pipeline.js"
import { pendingApprovalPlanBySession } from "./state/session-state.js"
import { ZERO_USAGE } from "./telemetry/usage.js"

let sessionCounter = 0
function newSession() {
  return `chat-pipeline-int-${++sessionCounter}`
}

function parseSseData(body: string) {
  const events: Array<Record<string, unknown>> = []
  const chunks = body
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter(Boolean)

  for (const chunk of chunks) {
    const line = chunk
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith("data:"))
    if (!line) continue
    const raw = line.slice("data:".length).trim()
    if (!raw) continue
    try {
      events.push(JSON.parse(raw) as Record<string, unknown>)
    } catch {
      // Ignore malformed lines.
    }
  }
  return events
}

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

  setGeneratePlanWithOpenAIForTests(async () => ({ plan: mockedPlan, usage: { ...ZERO_USAGE } }))

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
  const planPayload = planReady.json() as { status?: string; pendingPlanId?: string }
  assert.equal(planPayload.status, "plan_ready")
  assert.equal(typeof planPayload.pendingPlanId, "string")
  assert.ok(planPayload.pendingPlanId)

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
        usage: { ...ZERO_USAGE }
      }
    }
    return {
      plan: {
        intent: "edit_plan",
        summary_for_user: "No changes.",
        change_log: [],
        ops: []
      },
      usage: { ...ZERO_USAGE }
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
    setGeneratePlanWithOpenAIForTests()
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
                  heading: "Rise above rest",
                  body: "Test body",
                  imageUrl: "/hero-generated.svg",
                  imageAlt: "A climber ascending a rugged snow-capped mountain peak at sunrise",
                  imagePosition: "right"
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
        patch: { props: { imageUrl: "pending" } } as Record<string, unknown>
      }
    ]
  }
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: mockedPlan, usage: { ...ZERO_USAGE } }))

  const planReady = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/adventures",
      message: "update image to \"pending\" from unsplash matching image alt text",
      executionMode: "plan_only",
      activeBlockId: "b_two_col_test",
      activeEditablePath: "imageUrl"
    }
  })
  assert.equal(planReady.statusCode, 200)
  const planPayload = planReady.json() as { status?: string; pendingPlanId?: string }
  assert.equal(planPayload.status, "plan_ready")
  assert.equal(typeof planPayload.pendingPlanId, "string")
  assert.ok(planPayload.pendingPlanId)

  const applyPending = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/adventures",
      executionMode: "apply_pending_plan",
      pendingPlanId: planPayload.pendingPlanId
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
  const resolvedImageUrl = String(twoCol?.props.imageUrl ?? "")
  assert.ok(resolvedImageUrl.length > 0)
  assert.equal(typeof twoCol?.props.heading, "string")
})

test("chat apply_pending_plan preserves detected image query when image fields were stripped", async (t) => {
  const previousUnsplash = process.env.UNSPLASH_ACCESS_KEY
  delete process.env.UNSPLASH_ACCESS_KEY
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
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
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: mockedPlan, usage: { ...ZERO_USAGE } }))

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

  const applyPending = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/test",
      executionMode: "apply_pending_plan",
      pendingPlanId: planPayload.pendingPlanId
    }
  })
  assert.equal(applyPending.statusCode, 200)
  const applyPayload = applyPending.json() as { status?: string }
  assert.equal(applyPayload.status, "applied")

  const pageRes = await app.inject({
    method: "GET",
    url: `/draft/pages?session=${encodeURIComponent(session)}&slug=${encodeURIComponent("/test")}`
  })
  assert.equal(pageRes.statusCode, 200)
  const page = pageRes.json() as { blocks: Array<{ id: string; props: Record<string, unknown> }> }
  const hero = page.blocks.find((block) => block.id === "b_hero_test")
  assert.ok(hero)
  const resolvedImageUrl = String(hero?.props.imageUrl ?? "")
  assert.match(resolvedImageUrl, /avocados/i)
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
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: mockedPlan, usage: { ...ZERO_USAGE } }))

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
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: mockedPlan, usage: { ...ZERO_USAGE } }))

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
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: mockedPlan, usage: { ...ZERO_USAGE } }))

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
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: mockedPlan, usage: { ...ZERO_USAGE } }))

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
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: mockedPlan, usage: { ...ZERO_USAGE } }))

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

test("chat applies deterministic plan for high-confidence remove request without calling model planner", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  setGeneratePlanWithOpenAIForTests(async () => {
    throw new Error("model planner should not be called for deterministic remove")
  })

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "remove hero section"
    }
  })

  assert.equal(response.statusCode, 200)
  const payload = response.json() as { status?: string; summary?: string }
  assert.equal(payload.status, "applied")
  assert.match(String(payload.summary), /Removed/i)

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
      usage: { ...ZERO_USAGE }
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

test("focused deterministic rewrite sanitizes markdown emphasis", async (t) => {
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
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: mockedPlan, usage: { ...ZERO_USAGE } }))

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
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: mockedPlan, usage: { ...ZERO_USAGE } }))

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
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: mockedPlan, usage: { ...ZERO_USAGE } }))

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

test("chat returns repair_failed when deterministic repair generation throws", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  const invalidPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Try unsupported hero field.",
    change_log: ["Attempted invalid patch."],
    ops: [
      {
        op: "update_props",
        pageSlug: "/",
        blockId: "b_hero_home",
        patch: { notARealHeroProp: "x" } as Record<string, unknown>
      }
    ]
  }
  let calls = 0
  setGeneratePlanWithOpenAIForTests(async () => {
    calls += 1
    if (calls === 1) return { plan: invalidPlan, usage: { ...ZERO_USAGE } }
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
  const invalidPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Invalid first attempt.",
    change_log: ["Attempted invalid patch."],
    ops: [
      {
        op: "update_props",
        pageSlug: "/",
        blockId: "b_hero_home",
        patch: { notARealHeroProp: "x" } as Record<string, unknown>
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
    return { plan: calls === 1 ? invalidPlan : repairedPlan, usage: { ...ZERO_USAGE } }
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
  const invalidPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Invalid first attempt.",
    change_log: ["Attempted invalid patch."],
    ops: [
      {
        op: "update_props",
        pageSlug: "/",
        blockId: "b_hero_home",
        patch: { notARealHeroProp: "x" } as Record<string, unknown>
      }
    ]
  }
  const stillBadRepairPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Still invalid after repair.",
    change_log: ["Attempted patch on missing block."],
    ops: [{ op: "update_props", pageSlug: "/", blockId: "missing_block", patch: { heading: "x" } }]
  }
  setGeneratePlanWithOpenAIForTests(async ({ feedback }) => ({ plan: feedback ? stillBadRepairPlan : invalidPlan, usage: { ...ZERO_USAGE } }))
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
  assert.equal(payload.debug?.reasonCategory, "not_found")
})

test("chat returns planning_missing when planner returns null plan", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: null as unknown as EditPlan, usage: { ...ZERO_USAGE } }))
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
    return { plan: invalidPlan, usage: { ...ZERO_USAGE } }
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
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: noOpPlan, usage: { ...ZERO_USAGE } }))
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
  delete process.env.OPENAI_API_KEY
  t.after(() => {
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
  delete process.env.OPENAI_API_KEY
  setDemoPlanFromMessageForTests(() => {
    throw new Error("demo planner exploded")
  })
  t.after(() => {
    setDemoPlanFromMessageForTests()
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
      message: "anything"
    }
  })

  assert.equal(response.statusCode, 500)
  const payload = response.json() as { status?: string; debug?: { outcome?: string }; plannerSource?: string }
  assert.equal(payload.status, "error")
  assert.equal(payload.debug?.outcome, "planner_exception")
  assert.equal(payload.plannerSource, "demo")
})
