import test from "node:test"
import assert from "node:assert/strict"
import { demoPublishedPages } from "@avocadostudio-ai/shared"
import { plannerContextPack } from "./nlp/deterministic-planner.js"
import {
  buildPlannerSchemaContext,
  generatePlanWithOpenAI,
  isPlannerOutputError,
  parseIntentWithOpenAI,
  type PlannerOpenAIClient
} from "./chat/planner.js"

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

test("parseIntentWithOpenAI maps intent-shaped output to ParsedIntent", async () => {
  const currentPage = demoPublishedPages()[0]
  const parsed = await parseIntentWithOpenAI({
    message: "add cta below hero",
    slug: "/",
    currentPage,
    model: "gpt-4o",
    client: fakePlannerClientWithContent(
      JSON.stringify({
        action: "add",
        new_block_type: "CTA",
        position: "after",
        anchor_block_ref: "b_hero_home",
        summary: "Add CTA below Hero"
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
    /not valid JSON|did not return JSON/i
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

test("generatePlanWithOpenAI rejects non-JSON planner output", async () => {
  const previousStrict = process.env.CHAT_STRICT_JSON_RESPONSE
  process.env.CHAT_STRICT_JSON_RESPONSE = "0"
  try {
  const { currentPage, contextPack } = basePlannerArgs("change heading")
  await assert.rejects(
    () =>
      generatePlanWithOpenAI({
        message: "change heading",
        slug: "/",
        currentPage,
        contextPack,
        model: "gpt-4o",
        client: fakePlannerClientWithContent("not-json")
      }),
    (error: unknown) => isPlannerOutputError(error) && error.reasonCategory === "malformed_output"
  )
  } finally {
    if (previousStrict === undefined) delete process.env.CHAT_STRICT_JSON_RESPONSE
    else process.env.CHAT_STRICT_JSON_RESPONSE = previousStrict
  }
})

test("generatePlanWithOpenAI classifies empty completion content as incomplete output", async () => {
  const { currentPage, contextPack } = basePlannerArgs("change heading")
  await assert.rejects(
    () =>
      generatePlanWithOpenAI({
        message: "change heading",
        slug: "/",
        currentPage,
        contextPack,
        model: "gpt-4o",
        client: fakePlannerClientWithContent("")
      }),
    (error: unknown) => isPlannerOutputError(error) && error.reasonCategory === "incomplete_output"
  )
})

test("generatePlanWithOpenAI classifies explicit refusal output", async () => {
  const { currentPage, contextPack } = basePlannerArgs("change heading")
  const client: PlannerOpenAIClient = {
    chat: {
      completions: {
        create: async () =>
          ({
            choices: [{ message: { content: "", refusal: "I can't comply with this request." } }]
          }) as unknown
      }
    },
    responses: {
      create: async () =>
        ({
          output_text: ""
        }) as unknown
    }
  }
  await assert.rejects(
    () =>
      generatePlanWithOpenAI({
        message: "change heading",
        slug: "/",
        currentPage,
        contextPack,
        model: "gpt-4o",
        client
      }),
    (error: unknown) => isPlannerOutputError(error) && error.reasonCategory === "planner_refusal"
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

test("buildPlannerSchemaContext uses targeted contracts for selected block edit", () => {
  const previousAdaptive = process.env.CHAT_ADAPTIVE_SCHEMA_CONTEXT
  process.env.CHAT_ADAPTIVE_SCHEMA_CONTEXT = "1"
  try {
  const currentPage = demoPublishedPages()[0]
  const selected = currentPage.blocks.find((block) => block.type === "Hero")
  assert.ok(selected)
  const contextPack = plannerContextPack({
    session: "planner-openai-test",
    slug: "/",
    message: "change the hero heading",
    currentPage,
    activeBlockId: selected?.id,
    activeBlockType: "Hero"
  })

  const result = buildPlannerSchemaContext({
    message: "change the hero heading",
    contextPack,
    batchOverride: false,
    pageWideTranslation: false,
    legacyIncludeContracts: true
  })

  assert.equal(result.meta.contractMode, "targeted")
  assert.ok(result.payload.blockContracts)
  assert.deepEqual(Object.keys(result.payload.blockContracts ?? {}), ["Hero"])
  } finally {
    if (previousAdaptive === undefined) delete process.env.CHAT_ADAPTIVE_SCHEMA_CONTEXT
    else process.env.CHAT_ADAPTIVE_SCHEMA_CONTEXT = previousAdaptive
  }
})

test("buildPlannerSchemaContext uses full contracts for full-page translation", () => {
  const previousAdaptive = process.env.CHAT_ADAPTIVE_SCHEMA_CONTEXT
  process.env.CHAT_ADAPTIVE_SCHEMA_CONTEXT = "1"
  try {
  const currentPage = demoPublishedPages()[0]
  const contextPack = plannerContextPack({
    session: "planner-openai-test",
    slug: "/",
    message: "translate the whole page to German",
    currentPage,
    includeFullProps: true
  })

  const result = buildPlannerSchemaContext({
    message: "translate the whole page to German",
    contextPack,
    batchOverride: false,
    pageWideTranslation: true,
    legacyIncludeContracts: true
  })

  assert.equal(result.meta.contractMode, "full")
  assert.equal(Object.keys(result.payload.blockContracts ?? {}).length > 1, true)
  } finally {
    if (previousAdaptive === undefined) delete process.env.CHAT_ADAPTIVE_SCHEMA_CONTEXT
    else process.env.CHAT_ADAPTIVE_SCHEMA_CONTEXT = previousAdaptive
  }
})

test("buildPlannerSchemaContext uses minimal contracts for straightforward move/remove", () => {
  const previousAdaptive = process.env.CHAT_ADAPTIVE_SCHEMA_CONTEXT
  process.env.CHAT_ADAPTIVE_SCHEMA_CONTEXT = "1"
  try {
    const currentPage = demoPublishedPages()[0]
    const contextPack = plannerContextPack({
      session: "planner-openai-test",
      slug: "/",
      message: "move this section to bottom",
      currentPage
    })

    const result = buildPlannerSchemaContext({
      message: "move this section to bottom",
      contextPack,
      batchOverride: false,
      pageWideTranslation: false,
      legacyIncludeContracts: false
    })

    assert.equal(result.meta.contractMode, "minimal")
    assert.equal(result.payload.blockContracts, undefined)
  } finally {
    if (previousAdaptive === undefined) delete process.env.CHAT_ADAPTIVE_SCHEMA_CONTEXT
    else process.env.CHAT_ADAPTIVE_SCHEMA_CONTEXT = previousAdaptive
  }
})

test("buildPlannerSchemaContext downgrades from full when schema budget is tiny", () => {
  const previousAdaptive = process.env.CHAT_ADAPTIVE_SCHEMA_CONTEXT
  const previousBudget = process.env.CHAT_SCHEMA_BUDGET_BYTES
  process.env.CHAT_ADAPTIVE_SCHEMA_CONTEXT = "1"
  process.env.CHAT_SCHEMA_BUDGET_BYTES = "300"
  try {
    const currentPage = demoPublishedPages()[0]
    const contextPack = plannerContextPack({
      session: "planner-openai-test",
      slug: "/",
      message: "translate the whole page to German",
      currentPage
    })

    const result = buildPlannerSchemaContext({
      message: "translate the whole page to German",
      contextPack,
      batchOverride: false,
      pageWideTranslation: true,
      legacyIncludeContracts: true
    })

    assert.notEqual(result.meta.contractMode, "full")
  } finally {
    if (previousAdaptive === undefined) delete process.env.CHAT_ADAPTIVE_SCHEMA_CONTEXT
    else process.env.CHAT_ADAPTIVE_SCHEMA_CONTEXT = previousAdaptive
    if (previousBudget === undefined) delete process.env.CHAT_SCHEMA_BUDGET_BYTES
    else process.env.CHAT_SCHEMA_BUDGET_BYTES = previousBudget
  }
})

test("buildPlannerSchemaContext includes pageMetaContract for description/char-limit messages", () => {
  const previousAdaptive = process.env.CHAT_ADAPTIVE_SCHEMA_CONTEXT
  process.env.CHAT_ADAPTIVE_SCHEMA_CONTEXT = "1"
  try {
    const currentPage = demoPublishedPages()[0]
    for (const msg of [
      "Fit within 160 characters",
      "update the description to be shorter",
      "Add structured data (schema.org) for berries",
    ]) {
      const contextPack = plannerContextPack({
        session: "planner-openai-test",
        slug: "/",
        message: msg,
        currentPage
      })
      const result = buildPlannerSchemaContext({
        message: msg,
        contextPack,
        batchOverride: false,
        pageWideTranslation: false,
        legacyIncludeContracts: true
      })
      assert.ok(
        result.payload.pageMetaContract,
        `pageMetaContract should be included for: "${msg}"`
      )
    }
  } finally {
    if (previousAdaptive === undefined) delete process.env.CHAT_ADAPTIVE_SCHEMA_CONTEXT
    else process.env.CHAT_ADAPTIVE_SCHEMA_CONTEXT = previousAdaptive
  }
})

// Note: CHAT_STRICT_JSON_RESPONSE no longer applies json_schema strict mode in
// generatePlanWithOpenAI — the planner always uses json_object response_format.
// Strict json_schema mode is now only used in parseIntentWithOpenAI.
test("generatePlanWithOpenAI uses json_object response_format (non-streaming)", async () => {
  const { currentPage, contextPack } = basePlannerArgs("change heading")
  let responseFormatType: unknown
  const client: PlannerOpenAIClient = {
    chat: {
      completions: {
        create: async (request: unknown) => {
          const typed = request as {
            response_format?: { type?: string }
          }
          responseFormatType = typed.response_format?.type
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    intent: "edit_plan",
                    summary_for_user: "Will update the heading.",
                    change_log: ["Will update hero heading."],
                    ops: [{ op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: "Hi" } }]
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
    message: "change heading",
    slug: "/",
    currentPage,
    contextPack,
    model: "gpt-4o",
    client
  })

  assert.equal(responseFormatType, "json_object")
})

// ---------------------------------------------------------------------------
// repairAndParseJson tests
// ---------------------------------------------------------------------------
import { repairAndParseJson, repairAndParseJsonWithMeta, repairJson } from "./nlp/plan-normalizer.js"

test("repairAndParseJson fixes bare minus sign (no number after minus)", () => {
  // Simulate the "No number after minus sign" error: bare `-` outside a string
  const malformed = '{"change_log": [- "Set SEO title"], "ops": []}'
  const parsed = repairAndParseJson(malformed) as { change_log: string[] }
  assert.ok(Array.isArray(parsed.change_log))
})

test("repairAndParseJson fixes truncated JSON by closing braces", () => {
  const truncated = '{"intent": "edit_plan", "ops": [{"op": "update_props"'
  const parsed = repairAndParseJson(truncated) as { intent: string }
  assert.equal(parsed.intent, "edit_plan")
})

test("repairAndParseJson preserves minus signs inside JSON strings", () => {
  const valid = '{"description": "150-160 chars - keep it focused"}'
  const parsed = repairAndParseJson(valid) as { description: string }
  assert.equal(parsed.description, "150-160 chars - keep it focused")
})

test("repairAndParseJson fixes unescaped newlines inside JSON strings", () => {
  // Simulate LLM producing literal newlines in summary_for_user with markdown
  const malformed = '{"summary_for_user": "Here are some tips:\n- Be concise\n- Use bold **text**", "ops": []}'
  const parsed = repairAndParseJson(malformed) as { summary_for_user: string; ops: unknown[] }
  assert.ok(parsed.summary_for_user.includes("Be concise"))
  assert.ok(parsed.summary_for_user.includes("Use bold"))
  assert.ok(Array.isArray(parsed.ops))
})

test("repairAndParseJson fixes unescaped tabs and carriage returns", () => {
  const malformed = '{"text": "col1\tcol2\r\nrow"}'
  const parsed = repairAndParseJson(malformed) as { text: string }
  assert.ok(parsed.text.includes("col1"))
  assert.ok(parsed.text.includes("col2"))
})

test("repairJson escapes control chars inside strings (baseline)", () => {
  // repairJson now handles control char escaping directly — no need for
  // repairAndParseJson fallback strategies
  const malformed = '{"summary": "line1\nline2\ttab"}'
  const repaired = repairJson(malformed)
  const parsed = JSON.parse(repaired) as { summary: string }
  assert.ok(parsed.summary.includes("line1"))
  assert.ok(parsed.summary.includes("line2"))
  assert.ok(parsed.summary.includes("tab"))
})

test("repairJson handles combined control chars and markdown bullets", () => {
  const malformed = '{"change_log": [- "Set title\nwith newline"], "ops": []}'
  const repaired = repairJson(malformed)
  const parsed = JSON.parse(repaired) as { change_log: string[]; ops: unknown[] }
  assert.ok(parsed.change_log[0]?.includes("Set title"))
  assert.ok(Array.isArray(parsed.ops))
})

// ---------------------------------------------------------------------------
// repairAndParseJsonWithMeta tests
// ---------------------------------------------------------------------------

test("repairAndParseJsonWithMeta returns basic_repair strategy for control char fix", () => {
  const malformed = '{"summary": "line1\\nline2"}'
  const result = repairAndParseJsonWithMeta(malformed)
  assert.equal(result.strategy, "basic_repair")
  assert.ok(result.parsed)
})

test("repairAndParseJsonWithMeta returns bare_minus_fix with mutationCount", () => {
  // Use a case where basic_repair doesn't fix it but bare minus does:
  // bare `-` as a numeric value (not in array with markdown bullet pattern)
  const malformed = '{"value": -, "name": "test"}'
  const result = repairAndParseJsonWithMeta(malformed)
  assert.equal(result.strategy, "bare_minus_fix")
  assert.equal(typeof result.mutationCount, "number")
  assert.ok(result.mutationCount! >= 1)
})

test("repairAndParseJsonWithMeta returns close_brackets for truncated JSON", () => {
  const truncated = '{"intent": "edit_plan", "ops": [{"op": "update_props"'
  const result = repairAndParseJsonWithMeta(truncated)
  assert.equal(result.strategy, "close_brackets")
  assert.equal((result.parsed as { intent: string }).intent, "edit_plan")
})

test("repairAndParseJsonWithMeta returns truncate_at_boundary with discardedBytes", () => {
  // Valid JSON prefix followed by raw markdown that breaks parsing
  const broken = '{"intent": "edit_plan", "ops": [{"op": "update_props"}], "summary": this is not json at all'
  const result = repairAndParseJsonWithMeta(broken)
  assert.equal(result.strategy, "truncate_at_boundary")
  assert.equal(typeof result.discardedBytes, "number")
  assert.ok(result.discardedBytes! > 0)
})

test("repairAndParseJsonWithMeta backward compat: repairAndParseJson returns parsed value only", () => {
  const truncated = '{"intent": "edit_plan", "ops": [{"op": "update_props"'
  const result = repairAndParseJson(truncated)
  assert.equal((result as { intent: string }).intent, "edit_plan")
})

// ---------------------------------------------------------------------------
// cleanupImagePlaceholders — recursive deep clearing
// ---------------------------------------------------------------------------
import { cleanupImagePlaceholders, isGeneratingPlaceholder, GENERATING_IMAGE_PLACEHOLDER } from "./chat/chat-pipeline.js"
import { getSessionDraft, setPage, bumpVersion } from "./state/session-state.js"

test("cleanupImagePlaceholders clears nested array placeholders", () => {
  const session = `test-cleanup-${Date.now()}`
  // Set up a page with nested image placeholders (e.g. cards array)
  setPage(session, {
    slug: "test",
    title: "Test",
    blocks: [
      {
        id: "hero-1",
        type: "Hero",
        props: { imageUrl: GENERATING_IMAGE_PLACEHOLDER, title: "Hello" }
      },
      {
        id: "cards-1",
        type: "CardGrid",
        props: {
          cards: [
            { title: "Card 1", imageUrl: GENERATING_IMAGE_PLACEHOLDER },
            { title: "Card 2", imageUrl: "https://example.com/real.jpg" },
            { title: "Card 3", imageUrl: GENERATING_IMAGE_PLACEHOLDER }
          ]
        }
      }
    ]
  } as any)
  bumpVersion(session)

  const cleared = cleanupImagePlaceholders(session)
  assert.equal(cleared, 3, "should clear 3 placeholders (1 hero + 2 cards)")

  const draft = getSessionDraft(session)
  const page = draft.get("test")!
  const heroProps = page.blocks[0]!.props as Record<string, unknown>
  assert.equal(heroProps.imageUrl, "")
  const cardProps = page.blocks[1]!.props as { cards: Array<{ imageUrl: string }> }
  assert.equal(cardProps.cards[0]!.imageUrl, "")
  assert.equal(cardProps.cards[1]!.imageUrl, "https://example.com/real.jpg")
  assert.equal(cardProps.cards[2]!.imageUrl, "")
})
