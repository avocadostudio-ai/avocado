/**
 * Agent loop: multi-turn tool-use conversation with Claude.
 *
 * Uses the Anthropic Messages API **with streaming** for real-time text deltas.
 * Handles the loop: send message → Claude streams response → execute tools → feed results back → repeat.
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

  const toolDefs: Anthropic.Messages.Tool[] = tools.map((t) => t.definition)
  const handlerMap = new Map(tools.map((t) => [t.definition.name, t.handler]))

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

    let response: Anthropic.Messages.Message
    const textParts: string[] = []
    const toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }> = []

    try {
      console.log("[agent-loop] Calling Anthropic API (streaming), turn", toolCallCount + 1)

      const stream = client.messages.stream({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        tools: toolDefs,
        messages,
      })

      // Event-driven queue: callbacks push events, notify wakes the generator
      const pendingEvents: AgentEvent[] = []
      let notify: () => void
      let dataReady = new Promise<void>(r => { notify = r })

      stream.on("text", (text) => {
        pendingEvents.push({ type: "text_delta", text })
        notify()
      })

      stream.on("contentBlock", (block) => {
        if (block.type === "text") {
          textParts.push(block.text)
        } else if (block.type === "tool_use") {
          toolUseBlocks.push({
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          })
          pendingEvents.push({ type: "tool_start", toolName: block.name, toolUseId: block.id })
          notify()
        }
      })

      const streamDone = stream.finalMessage()
      let done = false
      streamDone.then(() => { done = true; notify() })

      // Drain events as they arrive — no polling, wake only on data or completion
      while (!done) {
        await Promise.race([dataReady, streamDone])
        while (pendingEvents.length > 0) {
          yield pendingEvents.shift()!
        }
        // Reset the notify promise for next wakeup
        dataReady = new Promise<void>(r => { notify = r })
      }

      // Final drain after stream completes
      while (pendingEvents.length > 0) {
        yield pendingEvents.shift()!
      }

      response = await streamDone

      console.log("[agent-loop] Stream complete, stop_reason:", response.stop_reason,
        "content blocks:", response.content.length,
        "tools:", response.content.filter(b => b.type === "tool_use").map(b => (b as { name: string }).name))

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error("[agent-loop] API error:", msg)
      yield { type: "error", message: msg }
      return
    }

    messages.push({ role: "assistant", content: response.content })

    if (response.stop_reason === "end_turn" || toolUseBlocks.length === 0) {
      fullSummary = textParts.join("")
      yield { type: "done", summary: fullSummary, toolCallCount }
      return
    }

    // Execute tool calls
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = []

    for (const toolUse of toolUseBlocks) {
      toolCallCount++

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

    if (textParts.length > 0) {
      fullSummary += textParts.join("")
    }

    messages.push({ role: "user", content: toolResults })
  }

  yield { type: "done", summary: `Completed with ${toolCallCount} tool calls (limit reached).`, toolCallCount }
}
