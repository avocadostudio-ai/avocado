/**
 * Agent loop: multi-turn tool-use conversation with an LLM.
 *
 * Dispatches to provider-specific implementations (Anthropic / OpenAI) based on
 * the `provider` field in options (required — routes validate before calling).
 */

import Anthropic from "@anthropic-ai/sdk"
import type { AgentTool } from "./agent-tools.js"
import type { AgentProvider } from "./agent-provider.js"
import { AGENT_MAX_TOOL_CALLS, AGENT_MAX_TOKENS, AGENT_TEMPERATURE, AGENT_THINKING_BUDGET, shouldUseThinking } from "./agent-provider.js"
import { runOpenAIAgentLoop } from "./agent-loop-openai.js"
import { anthropicSystemPromptWithCache, anthropicToolWithCache, ANTHROPIC_FINE_GRAINED_STREAM_HEADERS } from "../chat/anthropic-cache.js"

export type AgentTokenUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; toolName: string; toolUseId: string }
  | { type: "tool_done"; toolName: string; toolUseId: string; result: string; isError?: boolean }
  | { type: "done"; summary: string; toolCallCount: number; usage: AgentTokenUsage }
  | { type: "error"; message: string }

export type AgentLoopOptions = {
  apiKey: string
  model: string
  provider: AgentProvider
  systemPrompt: string
  tools: AgentTool[]
  userMessage: string
  maxToolCalls?: number
  signal?: AbortSignal
}

/** Provider-agnostic entry point — dispatches to Anthropic or OpenAI loop. */
export async function* runAgentLoop(options: AgentLoopOptions): AsyncGenerator<AgentEvent> {
  if (options.provider === "openai") {
    yield* runOpenAIAgentLoop(options)
    return
  }
  yield* runAnthropicAgentLoop(options)
}

async function* runAnthropicAgentLoop(options: AgentLoopOptions): AsyncGenerator<AgentEvent> {
  const {
    apiKey,
    model,
    systemPrompt,
    tools,
    userMessage,
    maxToolCalls = AGENT_MAX_TOOL_CALLS,
    signal,
  } = options

  const client = new Anthropic({ apiKey })

  // Apply prompt caching to system prompt and last tool (cache breakpoints)
  const cachedSystem = anthropicSystemPromptWithCache(systemPrompt)
  const toolDefs: Anthropic.Messages.Tool[] = tools.map((t, i) =>
    i === tools.length - 1 ? anthropicToolWithCache(t.definition) : t.definition
  )
  const handlerMap = new Map(tools.map((t) => [t.definition.name, t.handler]))

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: userMessage },
  ]

  let toolCallCount = 0
  let fullSummary = ""
  const totalUsage: AgentTokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }

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
      // Enable thinking on first turn only for complex requests
      const useThinking = toolCallCount === 0 && shouldUseThinking(userMessage)
      if (useThinking) {
        console.log("[agent-loop] Extended thinking enabled (budget:", AGENT_THINKING_BUDGET, ")")
      }
      console.log("[agent-loop] Calling Anthropic API (streaming), turn", toolCallCount + 1)

      const stream = client.messages.stream({
        model,
        max_tokens: AGENT_MAX_TOKENS,
        temperature: useThinking ? 1 : AGENT_TEMPERATURE,
        system: cachedSystem,
        tools: toolDefs,
        messages,
        ...(useThinking ? { thinking: { type: "enabled", budget_tokens: AGENT_THINKING_BUDGET } } : {}),
      }, { headers: ANTHROPIC_FINE_GRAINED_STREAM_HEADERS })

      const emittedToolStarts = new Set<string>()

      for await (const event of stream) {
        // Skip thinking blocks (internal reasoning — not shown to user)
        if (event.type === "content_block_start" && event.content_block?.type === "thinking") continue
        if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta") continue

        if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
          const { id, name } = event.content_block
          if (!emittedToolStarts.has(id)) {
            emittedToolStarts.add(id)
            yield { type: "tool_start", toolName: name, toolUseId: id }
          }
        }

        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          const { text } = event.delta
          textParts.push(text)
          yield { type: "text_delta", text }
        }
      }

      response = await stream.finalMessage()

      for (const block of response.content) {
        if (block.type === "tool_use") {
          toolUseBlocks.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown> })
          // Fallback for non-fine-grained: emit tool_start if not already emitted
          if (!emittedToolStarts.has(block.id)) {
            yield { type: "tool_start", toolName: block.name, toolUseId: block.id }
          }
        } else if (block.type === "text" && !textParts.length) {
          textParts.push(block.text)
        }
      }

      // Accumulate token usage
      const u = response.usage
      if (u) {
        totalUsage.inputTokens += u.input_tokens ?? 0
        totalUsage.outputTokens += u.output_tokens ?? 0
        totalUsage.cacheReadTokens += (u as unknown as Record<string, number>).cache_read_input_tokens ?? 0
        totalUsage.cacheCreationTokens += (u as unknown as Record<string, number>).cache_creation_input_tokens ?? 0
      }

      console.log("[agent-loop] Stream complete, stop_reason:", response.stop_reason,
        "content blocks:", response.content.length,
        "tools:", toolUseBlocks.map(b => b.name))

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error("[agent-loop] API error:", msg)
      yield { type: "error", message: msg }
      return
    }

    messages.push({ role: "assistant", content: response.content })

    if (response.stop_reason === "end_turn" || toolUseBlocks.length === 0) {
      fullSummary += textParts.join("")
      yield { type: "done", summary: fullSummary, toolCallCount, usage: totalUsage }
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

  yield { type: "done", summary: `Completed with ${toolCallCount} tool calls (limit reached).`, toolCallCount, usage: totalUsage }
}
