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

test("generatePlanWithOpenAI bypasses strict primary-op mode for explicit multi-block add prompts", async () => {
  const previous = process.env.CHAT_STRICT_PRIMARY_OP_MODE
  process.env.CHAT_STRICT_PRIMARY_OP_MODE = "1"
  try {
    const message = "add 3 blocks: hero, cardgrid and CTA"
    const { currentPage, contextPack } = basePlannerArgs(message)
    const { plan } = await generatePlanWithOpenAI({
      message,
      slug: "/",
      currentPage,
      contextPack,
      model: "gpt-4o",
      client: fakePlannerClientWithContent(
        JSON.stringify({
          intent: "edit_plan",
          summary_for_user: "Will add three sections.",
          change_log: ["Will add a Hero.", "Will add a CardGrid.", "Will add a CTA."],
          ops: [
            { op: "add_block", pageSlug: "/", block: { id: "b_hero_1", type: "Hero", props: {} } },
            { op: "add_block", pageSlug: "/", block: { id: "b_cardgrid_1", type: "CardGrid", props: {} } },
            { op: "add_block", pageSlug: "/", block: { id: "b_cta_1", type: "CTA", props: {} } }
          ]
        })
      )
    })

    assert.equal(plan.intent, "edit_plan")
    assert.equal(plan.ops.length, 3)
    assert.equal(plan.ops[0]?.op, "add_block")
    assert.equal(plan.ops[1]?.op, "add_block")
    assert.equal(plan.ops[2]?.op, "add_block")
  } finally {
    if (previous === undefined) delete process.env.CHAT_STRICT_PRIMARY_OP_MODE
    else process.env.CHAT_STRICT_PRIMARY_OP_MODE = previous
  }
})

test("generatePlanWithOpenAI bypasses strict primary-op mode for full-page translation prompts", async () => {
  const previous = process.env.CHAT_STRICT_PRIMARY_OP_MODE
  process.env.CHAT_STRICT_PRIMARY_OP_MODE = "1"
  try {
    const { currentPage, contextPack } = basePlannerArgs("Translate the full page to German")
    const { plan } = await generatePlanWithOpenAI({
      message: "Translate the full page to German",
      slug: "/",
      currentPage,
      contextPack,
      model: "gpt-4o",
      client: fakePlannerClientWithContent(
        JSON.stringify({
          intent: "edit_plan",
          summary_for_user: "Will translate the page.",
          change_log: ["Will translate Hero.", "Will translate Feature Grid."],
          ops: [
            { op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: "Hallo Welt" } },
            { op: "update_props", pageSlug: "/", blockId: "b_features_home", patch: { title: "Warum Teams es nutzen" } }
          ]
        })
      )
    })

    assert.equal(plan.intent, "edit_plan")
    assert.equal(plan.ops.length, 2)
    assert.equal(plan.ops[0]?.op, "update_props")
    assert.equal(plan.ops[1]?.op, "update_props")
  } finally {
    if (previous === undefined) delete process.env.CHAT_STRICT_PRIMARY_OP_MODE
    else process.env.CHAT_STRICT_PRIMARY_OP_MODE = previous
  }
})

test("generatePlanWithOpenAI includes explicit list-child coverage instructions for full-page translation", async () => {
  const { currentPage, contextPack } = basePlannerArgs("Translate the whole page to Greek")
  let sawListChildTranslationInstruction = false
  const client: PlannerOpenAIClient = {
    chat: {
      completions: {
        create: async (request: unknown) => {
          const typed = request as { messages?: Array<{ role?: string; content?: string }> }
          const systemMessage = typed.messages?.find((m) => m.role === "system")?.content ?? ""
          sawListChildTranslationInstruction = systemMessage.includes(
            "For list-based child items across all blocks"
          )
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    intent: "edit_plan",
                    summary_for_user: "Will translate the page.",
                    change_log: ["Will translate all requested content."],
                    ops: [{ op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: "Γεια" } }]
                  })
                }
              }
            ]
          } as unknown
        }
      }
    },
    responses: {
      create: async () => ({ output_text: "" }) as unknown
    }
  }

  await generatePlanWithOpenAI({
    message: "Translate the whole page to Greek",
    slug: "/",
    currentPage,
    contextPack,
    model: "gpt-4o",
    client
  })

  assert.equal(sawListChildTranslationInstruction, true)
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

test("generatePlanWithOpenAI normalizes list aliases itemPath/arrayProp for update_item", async () => {
  const { currentPage, contextPack } = basePlannerArgs("populate 3rd question")
  const { plan } = await generatePlanWithOpenAI({
    message: "populate 3rd question",
    slug: "/",
    currentPage,
    contextPack,
    model: "gpt-4o",
    client: fakePlannerClientWithContent(
      JSON.stringify({
        intent: "edit_plan",
        summary_for_user: "Will update the 3rd FAQ question.",
        change_log: ["Will update the 3rd FAQ item content."],
        ops: [
          {
            op: "update_item",
            pageSlug: "/",
            blockId: "b_faq_home",
            itemPath: "items[2]",
            patch: { q: "How should I store lemons to keep them fresh?" }
          },
          {
            op: "update_item",
            pageSlug: "/",
            blockId: "b_faq_home",
            arrayProp: "items",
            index: 2,
            patch: { a: "Store whole lemons in the refrigerator in a sealed bag." }
          }
        ]
      })
    )
  })

  assert.equal(plan.intent, "edit_plan")
  assert.equal(plan.ops.length, 2)
  const first = plan.ops[0]
  const second = plan.ops[1]
  assert.equal(first.op, "update_item")
  assert.equal(second.op, "update_item")
  if (first.op === "update_item") {
    assert.equal(first.listKey, "items")
    assert.equal(first.index, 2)
  }
  if (second.op === "update_item") {
    assert.equal(second.listKey, "items")
    assert.equal(second.index, 2)
  }
})

test("plannerContextPack with includeFullProps sends array props for all blocks", () => {
  const currentPage = demoPublishedPages()[0]
  const contextPack = plannerContextPack({
    session: "planner-openai-test",
    slug: "/",
    message: "translate this page to German",
    currentPage,
    includeFullProps: true
  })
  // Every block with array props should have them included in the outline
  for (const outlineBlock of contextPack.pageOutline) {
    const original = currentPage.blocks.find((b) => b.id === outlineBlock.id)!
    const originalProps = original.props as Record<string, unknown>
    for (const [key, value] of Object.entries(originalProps)) {
      if (Array.isArray(value)) {
        assert.ok(Array.isArray((outlineBlock.props as Record<string, unknown>)[key]),
          `Block ${outlineBlock.id} should include array prop "${key}" when includeFullProps is true`)
      }
    }
  }
})

test("plannerContextPack without includeFullProps strips array props from non-selected blocks", () => {
  const currentPage = demoPublishedPages()[0]
  const contextPack = plannerContextPack({
    session: "planner-openai-test",
    slug: "/",
    message: "change the heading",
    currentPage
  })
  // Non-selected blocks should have array props stripped (only scalars kept)
  for (const outlineBlock of contextPack.pageOutline) {
    const original = currentPage.blocks.find((b) => b.id === outlineBlock.id)!
    const originalProps = original.props as Record<string, unknown>
    for (const [key, value] of Object.entries(originalProps)) {
      if (Array.isArray(value)) {
        assert.ok(!Array.isArray((outlineBlock.props as Record<string, unknown>)[key]),
          `Block ${outlineBlock.id} should NOT include array prop "${key}" without includeFullProps`)
      }
    }
  }
})
