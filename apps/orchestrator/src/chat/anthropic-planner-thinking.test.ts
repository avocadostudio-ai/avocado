import test from "node:test"
import assert from "node:assert/strict"
import type Anthropic from "@anthropic-ai/sdk"
import type { PageDoc } from "@ai-site-editor/shared"
import { generatePlanWithAnthropic, type PlannerAnthropicClient } from "./anthropic-planner.js"
import { plannerContextPack } from "../nlp/deterministic-planner.js"

function makePage(): PageDoc {
  return {
    id: "p_home",
    slug: "/",
    title: "Home",
    updatedAt: new Date().toISOString(),
    blocks: [
      {
        id: "b_hero_home",
        type: "Hero",
        props: { heading: "Welcome", subheading: "Sub" }
      }
    ]
  }
}

function baseContextPack() {
  return {
    route: "/",
    pageRoutes: ["/"],
    selected: { blockId: "b_hero_home", editablePath: null, block: null },
    neighbors: { previous: null, next: null },
    pageOutline: [{ id: "b_hero_home", type: "Hero", props: { heading: "Welcome" }, arrayProps: [] }],
    resolvedReferences: { target: null, anchor: null, mentionedBlocks: [] },
    recentSuccessfulEdits: []
  } as unknown as ReturnType<typeof plannerContextPack>
}

test("generatePlanWithAnthropic: passes thinking param when args.thinking is set", async () => {
  let capturedArgs: Record<string, unknown> | null = null
  const client: PlannerAnthropicClient = {
    messages: {
      create: async (rawArgs) => {
        capturedArgs = rawArgs as Record<string, unknown>
        return {
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "submit_edit_plan",
              input: {
                intent: "edit_plan",
                summary_for_user: "ok",
                change_log: [],
                ops: []
              }
            }
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        } as unknown as Anthropic.Messages.Message
      }
    }
  }

  const thinkingEvents: Array<{ type: string }> = []
  await generatePlanWithAnthropic({
    message: "restructure the hero with a more persuasive tone",
    slug: "/",
    currentPage: makePage(),
    contextPack: baseContextPack(),
    model: "claude-sonnet-4-6",
    client,
    thinking: { budgetTokens: 2048 },
    onThinking: (e) => thinkingEvents.push(e)
  })

  assert.ok(capturedArgs, "expected messages.create to be called")
  const thinking = (capturedArgs as Record<string, unknown>).thinking as
    | { type?: string; budget_tokens?: number }
    | undefined
  assert.ok(thinking, "expected thinking arg to be forwarded")
  assert.equal(thinking?.type, "enabled")
  assert.equal(thinking?.budget_tokens, 2048)

  // With thinking enabled, tool_choice should be relaxed from forced-tool to auto
  const toolChoice = (capturedArgs as Record<string, unknown>).tool_choice as
    | { type?: string }
    | undefined
  assert.equal(toolChoice?.type, "auto")
})

test("generatePlanWithAnthropic: omits thinking when args.thinking is undefined", async () => {
  let capturedArgs: Record<string, unknown> | null = null
  const client: PlannerAnthropicClient = {
    messages: {
      create: async (rawArgs) => {
        capturedArgs = rawArgs as Record<string, unknown>
        return {
          content: [
            {
              type: "tool_use",
              id: "toolu_2",
              name: "submit_edit_plan",
              input: {
                intent: "edit_plan",
                summary_for_user: "ok",
                change_log: [],
                ops: []
              }
            }
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        } as unknown as Anthropic.Messages.Message
      }
    }
  }

  await generatePlanWithAnthropic({
    message: "change the headline",
    slug: "/",
    currentPage: makePage(),
    contextPack: baseContextPack(),
    model: "claude-sonnet-4-6",
    client
  })

  assert.ok(capturedArgs, "expected messages.create to be called")
  assert.equal(
    (capturedArgs as Record<string, unknown>).thinking,
    undefined,
    "thinking field should not be present when not requested"
  )
})

test("generatePlanWithAnthropic: drops thinking below 1024 budget (Anthropic minimum)", async () => {
  let capturedArgs: Record<string, unknown> | null = null
  const client: PlannerAnthropicClient = {
    messages: {
      create: async (rawArgs) => {
        capturedArgs = rawArgs as Record<string, unknown>
        return {
          content: [
            {
              type: "tool_use",
              id: "toolu_3",
              name: "submit_edit_plan",
              input: {
                intent: "edit_plan",
                summary_for_user: "ok",
                change_log: [],
                ops: []
              }
            }
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        } as unknown as Anthropic.Messages.Message
      }
    }
  }

  await generatePlanWithAnthropic({
    message: "change the headline",
    slug: "/",
    currentPage: makePage(),
    contextPack: baseContextPack(),
    model: "claude-sonnet-4-6",
    client,
    thinking: { budgetTokens: 512 }
  })

  assert.ok(capturedArgs, "expected messages.create to be called")
  assert.equal(
    (capturedArgs as Record<string, unknown>).thinking,
    undefined,
    "thinking field should be dropped when budget is below minimum"
  )
})
