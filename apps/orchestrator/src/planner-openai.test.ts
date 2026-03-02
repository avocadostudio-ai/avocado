import test from "node:test"
import assert from "node:assert/strict"
import { demoPublishedPages } from "@ai-site-editor/shared"
import { plannerContextPack } from "./nlp/deterministic-planner.js"
import { generatePlanWithOpenAI, parseIntentWithOpenAI, type PlannerOpenAIClient } from "./chat/planner.js"

function fakePlannerClientWithContent(content: string): PlannerOpenAIClient {
  return {
    chat: {
      completions: {
        create: async () =>
          ({
            choices: [{ message: { content } }]
          }) as unknown
      }
    },
    responses: {
      create: async () =>
        ({
          output_text: content
        }) as unknown
    }
  }
}

function basePlannerArgs(message: string) {
  const currentPage = demoPublishedPages()[0]
  const contextPack = plannerContextPack({
    session: "planner-openai-test",
    slug: "/",
    message,
    currentPage
  })
  return { currentPage, contextPack }
}

test("parseIntentWithOpenAI maps op-shaped output to ParsedIntent", async () => {
  const currentPage = demoPublishedPages()[0]
  const parsed = await parseIntentWithOpenAI({
    message: "add cta below hero",
    slug: "/",
    currentPage,
    model: "gpt-4o",
    client: fakePlannerClientWithContent(
      JSON.stringify({
        ops: [
          {
            op: "add_block",
            afterBlockId: "b_hero_home",
            block: { type: "CTA", props: { title: "Try now" } }
          }
        ]
      })
    )
  })

  assert.equal(parsed.action, "add")
  assert.equal(parsed.new_block_type, "CTA")
  assert.equal(parsed.position, "after")
  assert.equal(parsed.anchor_block_ref, "b_hero_home")
})

test("parseIntentWithOpenAI rejects malformed non-JSON output", async () => {
  const currentPage = demoPublishedPages()[0]
  await assert.rejects(
    () =>
      parseIntentWithOpenAI({
        message: "update hero title",
        slug: "/",
        currentPage,
        model: "gpt-4o",
        client: fakePlannerClientWithContent("not-json-response")
      }),
    /did not return JSON/i
  )
})

test("generatePlanWithOpenAI normalizes malformed one-key operations", async () => {
  const { currentPage, contextPack } = basePlannerArgs("move cta below hero")
  const { plan, usage } = await generatePlanWithOpenAI({
    message: "move cta below hero",
    slug: "/",
    currentPage,
    contextPack,
    model: "gpt-4o",
    client: fakePlannerClientWithContent(
      JSON.stringify({
        intent: "edit_plan",
        summary_for_user: "Moved CTA.",
        change_log: ["Moved CTA below Hero."],
        ops: [
          {
            move_block: {
              pageSlug: "/",
              blockId: "b_cta_home",
              afterBlockId: "b_hero_home"
            }
          }
        ]
      })
    )
  })

  assert.equal(plan.intent, "edit_plan")
  assert.equal(plan.ops.length, 1)
  assert.equal(plan.ops[0]?.op, "move_block")
  assert.equal(typeof usage.inputTokens, "number")
  assert.equal(typeof usage.outputTokens, "number")
  assert.equal(typeof usage.totalTokens, "number")
})

test("generatePlanWithOpenAI enforces strict primary-op mode from env", async () => {
  const previous = process.env.CHAT_STRICT_PRIMARY_OP_MODE
  process.env.CHAT_STRICT_PRIMARY_OP_MODE = "1"
  try {
    const { currentPage, contextPack } = basePlannerArgs("make two edits")
    const { plan } = await generatePlanWithOpenAI({
      message: "make two edits",
      slug: "/",
      currentPage,
      contextPack,
      model: "gpt-4o",
      client: fakePlannerClientWithContent(
        JSON.stringify({
          intent: "edit_plan",
          summary_for_user: "Applied changes.",
          change_log: ["Changed heading and subheading."],
          ops: [
            { op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: "Strict heading" } },
            { op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { subheading: "Strict subheading" } }
          ]
        })
      )
    })

    assert.equal(plan.intent, "edit_plan")
    assert.equal(plan.ops.length, 1)
    assert.equal(plan.ops[0]?.op, "update_props")
  } finally {
    if (previous === undefined) delete process.env.CHAT_STRICT_PRIMARY_OP_MODE
    else process.env.CHAT_STRICT_PRIMARY_OP_MODE = previous
  }
})

test("generatePlanWithOpenAI bypasses strict primary-op mode for multi-page create batch prompts", async () => {
  const previous = process.env.CHAT_STRICT_PRIMARY_OP_MODE
  process.env.CHAT_STRICT_PRIMARY_OP_MODE = "1"
  try {
    const { currentPage, contextPack } = basePlannerArgs("create pages for water explorers and wilderness survivalists")
    const { plan } = await generatePlanWithOpenAI({
      message: "create pages for water explorers and wilderness survivalists",
      slug: "/",
      currentPage,
      contextPack,
      model: "gpt-4o",
      client: fakePlannerClientWithContent(
        JSON.stringify({
          intent: "edit_plan",
          summary_for_user: "Will create both pages.",
          change_log: ["Will create page for water explorers.", "Will create page for wilderness survivalists."],
          ops: [
            { op: "create_page", page: { slug: "/for-water-explorers", blocks: [] } },
            { op: "create_page", page: { slug: "/for-wilderness-survivalists", blocks: [] } }
          ]
        })
      )
    })

    assert.equal(plan.intent, "edit_plan")
    assert.equal(plan.ops.length, 2)
    assert.equal(plan.ops[0]?.op, "create_page")
    assert.equal(plan.ops[1]?.op, "create_page")
  } finally {
    if (previous === undefined) delete process.env.CHAT_STRICT_PRIMARY_OP_MODE
    else process.env.CHAT_STRICT_PRIMARY_OP_MODE = previous
  }
})

test("generatePlanWithOpenAI rejects schema-invalid plans", async () => {
  const { currentPage, contextPack } = basePlannerArgs("change heading")
  await assert.rejects(
    () =>
      generatePlanWithOpenAI({
        message: "change heading",
        slug: "/",
        currentPage,
        contextPack,
        model: "gpt-4o",
        client: fakePlannerClientWithContent(
          JSON.stringify({
            intent: "edit_plan",
            summary_for_user: "Bad payload",
            change_log: "not-an-array",
            ops: []
          })
        )
      }),
    /(Invalid model output|Expected array|change_log)/i
  )
})
