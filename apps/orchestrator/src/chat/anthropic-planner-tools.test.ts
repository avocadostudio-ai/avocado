import test from "node:test"
import assert from "node:assert/strict"
import type Anthropic from "@anthropic-ai/sdk"
import type { PageDoc } from "@ai-site-editor/shared"
import { generatePlanWithAnthropic, type PlannerAnthropicClient } from "./anthropic-planner.js"
import { plannerContextPack } from "../nlp/deterministic-planner.js"
import { ToolRegistry } from "../tools/registry.js"
import { ToolExecutor } from "../tools/executor.js"
import type { ToolRuntime } from "../tools/runtime.js"

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
        props: {
          heading: "Welcome",
          subheading: "Sub",
          imageUrl: "/hero-generated.svg",
          imageAlt: "Hero"
        }
      }
    ]
  }
}

test("generatePlanWithAnthropic executes runtime tool calls before submit_edit_plan", async () => {
  const registry = new ToolRegistry()
  registry.registerBuiltin(
    {
      name: "unsplash.search",
      description: "Search",
      capability: "read",
      timeoutMs: 1000,
      retryPolicy: { maxAttempts: 1 },
      idempotent: true,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: { query: { type: "string" } }
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["items"],
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              required: ["imageUrl"],
              properties: { imageUrl: { type: "string" } }
            }
          }
        }
      }
    },
    async () => ({ items: [{ imageUrl: "https://images.unsplash.com/photo-1" }] })
  )
  const runtime: ToolRuntime = {
    registry,
    executor: new ToolExecutor(registry, { info: () => {}, warn: () => {} }),
    defaultPolicy: { autoRunRead: true, requireApprovalForWrite: true }
  }

  let createCalls = 0
  const client: PlannerAnthropicClient = {
    messages: {
      create: async () => {
        createCalls += 1
        if (createCalls === 1) {
          return {
            content: [
              {
                type: "tool_use",
                id: "toolu_1",
                name: "unsplash.search",
                input: { query: "mountain sunset" }
              }
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
          } as unknown as Anthropic.Messages.Message
        }
        return {
          content: [
            {
              type: "tool_use",
              id: "toolu_2",
              name: "submit_edit_plan",
              input: {
                intent: "edit_plan",
                summary_for_user: "Will update the hero image.",
                change_log: ["Will set a new hero image."],
                ops: [
                  {
                    op: "update_props",
                    pageSlug: "/",
                    blockId: "b_hero_home",
                    patch: { imageUrl: "https://images.unsplash.com/photo-1", imageAlt: "Mountain at sunset" }
                  }
                ]
              }
            }
          ],
          usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 }
        } as unknown as Anthropic.Messages.Message
      }
    }
  }

  const executedTools: string[] = []
  const { plan, usage } = await generatePlanWithAnthropic({
    message: "replace hero image with mountain sunset from Unsplash",
    slug: "/",
    currentPage: makePage(),
    contextPack: {
      route: "/",
      pageRoutes: ["/"],
      selected: { blockId: "b_hero_home", editablePath: "imageUrl", block: null },
      neighbors: { previous: null, next: null },
      pageOutline: [{ id: "b_hero_home", type: "Hero", props: { heading: "Welcome" }, arrayProps: [] }],
      resolvedReferences: { target: null, anchor: null, mentionedBlocks: [] },
      recentSuccessfulEdits: []
    } as unknown as ReturnType<typeof plannerContextPack>,
    model: "claude-sonnet-4-6",
    toolRuntime: runtime,
    toolCallContext: { siteId: "demo", sessionId: "s1", traceId: "trace-1" },
    onToolExecution: (event) => executedTools.push(event.toolName),
    client
  })

  assert.equal(createCalls, 2)
  assert.equal(plan.intent, "edit_plan")
  assert.equal(plan.ops.length, 1)
  assert.equal(plan.ops[0]?.op, "update_props")
  assert.deepEqual(executedTools, ["unsplash.search"])
  assert.equal(usage.totalTokens, 27)
})
