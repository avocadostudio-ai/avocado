/**
 * Agent loop: multi-turn tool-use conversation with Claude.
 *
 * Uses the raw Anthropic Messages API with tools.
 * Handles the loop: send message → Claude calls tools → execute → feed results back → repeat.
 */

import Anthropic from "@anthropic-ai/sdk"
import type { AgentTool } from "./agent-tools.js"

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; toolName: string; toolUseId: string }
  | { type: "tool_done"; toolName: string; toolUseId: string; result: string; isError?: boolean }
  | { type: "done"; summary: string; toolCallCount: number }
  | { type: "error"; message: string }

export type AgentLoopOptions = {
  apiKey: string
  model?: string
  systemPrompt: string
  tools: AgentTool[]
  userMessage: string
  maxToolCalls?: number
  signal?: AbortSignal
}

const DEFAULT_MODEL = "claude-sonnet-4-6"
const DEFAULT_MAX_TOOL_CALLS = 20

export async function* runAgentLoop(options: AgentLoopOptions): AsyncGenerator<AgentEvent> {
  const {
    apiKey,
    model = DEFAULT_MODEL,
    systemPrompt,
    tools,
    userMessage,
    maxToolCalls = DEFAULT_MAX_TOOL_CALLS,
    signal,
  } = options

  const client = new Anthropic({ apiKey })

  // Build tool definitions for the API
  const toolDefs: Anthropic.Messages.Tool[] = tools.map((t) => t.definition)

  // Build handler map
  const handlerMap = new Map(tools.map((t) => [t.definition.name, t.handler]))

  // Conversation messages
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: userMessage },
  ]

  let toolCallCount = 0
  let fullSummary = ""

  // Tool-use loop
  while (toolCallCount < maxToolCalls) {
    if (signal?.aborted) {
      yield { type: "error", message: "Canceled" }
      return
    }

    // Call Claude
    let response: Anthropic.Messages.Message
    try {
      console.log("[agent-loop] Calling Anthropic API, turn", toolCallCount + 1)
      response = await client.messages.create({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        tools: toolDefs,
        messages,
      })
      console.log("[agent-loop] Got response, stop_reason:", response.stop_reason, "content blocks:", response.content.length,
        "tools:", response.content.filter(b => b.type === "tool_use").map(b => (b as { name: string }).name))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error("[agent-loop] API error:", msg)
      yield { type: "error", message: msg }
      return
    }

    // Process response content
    const textBlocks: string[] = []
    const toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }> = []

    for (const block of response.content) {
      if (block.type === "text") {
        textBlocks.push(block.text)
        yield { type: "text_delta", text: block.text }
      } else if (block.type === "tool_use") {
        toolUseBlocks.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        })
      }
    }

    // Add assistant message to conversation
    messages.push({ role: "assistant", content: response.content })

    // If stop_reason is end_turn (no tool calls), we're done
    if (response.stop_reason === "end_turn" || toolUseBlocks.length === 0) {
      fullSummary = textBlocks.join("\n")
      yield { type: "done", summary: fullSummary, toolCallCount }
      return
    }

    // Execute tool calls
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = []

    for (const toolUse of toolUseBlocks) {
      toolCallCount++
      console.log("[agent-loop] PRE-YIELD tool_start for:", toolUse.name)
      yield { type: "tool_start" as const, toolName: toolUse.name, toolUseId: toolUse.id }
      console.log("[agent-loop] POST-YIELD tool_start for:", toolUse.name)

      console.log("[agent-loop] Executing tool:", toolUse.name, "input:", JSON.stringify(toolUse.input).slice(0, 200))
      const handler = handlerMap.get(toolUse.name)
      if (!handler) {
        const errorResult = `Unknown tool: ${toolUse.name}`
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: errorResult,
          is_error: true,
        })
        yield { type: "tool_done", toolName: toolUse.name, toolUseId: toolUse.id, result: errorResult, isError: true }
        continue
      }

      const { result, isError } = await handler(toolUse.input)

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result,
        ...(isError ? { is_error: true } : {}),
      })

      yield { type: "tool_done", toolName: toolUse.name, toolUseId: toolUse.id, result, isError }
    }

    // Add tool results to conversation
    messages.push({ role: "user", content: toolResults })
  }

  // Max tool calls reached
  yield { type: "done", summary: `Completed with ${toolCallCount} tool calls (limit reached).`, toolCallCount }
}
