/**
 * OpenAI agent loop: multi-turn tool-use conversation via Chat Completions API with streaming.
 *
 * Yields the same AgentEvent types as the Anthropic loop so the SSE transport
 * and editor UI work identically regardless of provider.
 */

import OpenAI from "openai"
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions"
import { openAIChatOptionsForModel } from "../chat/planner.js"
import type { AgentTool } from "./agent-tools.js"
import { AGENT_MAX_TOOL_CALLS, AGENT_MAX_TOKENS } from "./agent-provider.js"
import type { AgentEvent, AgentLoopOptions, AgentTokenUsage } from "./agent-loop.js"

type ToolCallAccumulator = {
  id: string
  name: string
  args: string
}

function agentToolToOpenAI(tool: AgentTool): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.definition.name,
      description: tool.definition.description ?? "",
      parameters: tool.definition.input_schema as Record<string, unknown>,
    },
  }
}

export async function* runOpenAIAgentLoop(options: AgentLoopOptions): AsyncGenerator<AgentEvent> {
  const {
    apiKey,
    model,
    systemPrompt,
    tools,
    userMessage,
    maxToolCalls = AGENT_MAX_TOOL_CALLS,
    signal,
    logger,
  } = options
  const log = logger ?? { info: (m: string) => console.log(m), warn: (m: string) => console.warn(m), error: (m: string) => console.error(m) }

  const client = new OpenAI({ apiKey })

  const openAITools = tools.map(agentToolToOpenAI)
  const handlerMap = new Map(tools.map((t) => [t.definition.name, t.handler]))

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ]

  let toolCallCount = 0
  let fullSummary = ""
  const totalUsage: AgentTokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
  const modelOptions = openAIChatOptionsForModel(model)

  while (toolCallCount < maxToolCalls) {
    if (signal?.aborted) {
      yield { type: "error", message: "Canceled" }
      return
    }

    const textParts: string[] = []
    const toolCallAccumulators = new Map<number, ToolCallAccumulator>()
    let finishReason: string | null = null

    try {
      log.info(`[agent-loop-openai] Calling OpenAI API (streaming), turn ${toolCallCount + 1}`)

      const stream = await client.chat.completions.create({
        model,
        max_tokens: AGENT_MAX_TOKENS,
        messages,
        tools: openAITools,
        stream: true,
        ...modelOptions,
      }, { signal })

      for await (const chunk of stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>) {
        // Accumulate usage from streaming chunks
        if (chunk.usage) {
          totalUsage.inputTokens += chunk.usage.prompt_tokens ?? 0
          totalUsage.outputTokens += chunk.usage.completion_tokens ?? 0
        }
        if (signal?.aborted) {
          yield { type: "error", message: "Canceled" }
          return
        }

        const choice = chunk.choices[0]
        if (!choice) continue

        const delta = choice.delta

        // Text content
        if (delta?.content) {
          textParts.push(delta.content)
          yield { type: "text_delta", text: delta.content }
        }

        // Tool call deltas — accumulate per index
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            let acc = toolCallAccumulators.get(tc.index)
            if (!acc) {
              acc = { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" }
              toolCallAccumulators.set(tc.index, acc)
            }
            if (tc.id) acc.id = tc.id
            if (tc.function?.name) acc.name = tc.function.name
            if (tc.function?.arguments) acc.args += tc.function.arguments
          }
        }

        if (choice.finish_reason) {
          finishReason = choice.finish_reason
        }
      }
    } catch (err: unknown) {
      if (signal?.aborted) {
        yield { type: "error", message: "Canceled" }
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      log.error(`[agent-loop-openai] API error: ${msg}`)
      yield { type: "error", message: msg }
      return
    }

    const turnText = textParts.join("")

    // Build assistant message for conversation history
    const assistantMessage: ChatCompletionMessageParam = {
      role: "assistant",
      content: turnText || null,
      ...(toolCallAccumulators.size > 0
        ? {
            tool_calls: [...toolCallAccumulators.values()].map((acc) => ({
              id: acc.id,
              type: "function" as const,
              function: { name: acc.name, arguments: acc.args },
            })),
          }
        : {}),
    }
    messages.push(assistantMessage)

    // Handle non-tool finish reasons
    if (finishReason === "length") {
      yield { type: "error", message: "Response truncated — max tokens reached" }
      return
    }
    if (finishReason === "content_filter") {
      yield { type: "error", message: "Content filtered by OpenAI" }
      return
    }

    // No tool calls → done
    if (toolCallAccumulators.size === 0 || finishReason === "stop") {
      fullSummary += turnText
      yield { type: "done", summary: fullSummary, toolCallCount, usage: totalUsage }
      return
    }

    // Execute tool calls
    const toolResults: ChatCompletionMessageParam[] = []

    for (const [, acc] of toolCallAccumulators) {
      if (signal?.aborted) {
        yield { type: "error", message: "Canceled" }
        return
      }

      toolCallCount++
      yield { type: "tool_start", toolName: acc.name, toolUseId: acc.id }

      let input: Record<string, unknown>
      try {
        input = JSON.parse(acc.args || "{}")
      } catch {
        const errorResult = `Failed to parse tool arguments for ${acc.name}`
        log.error(`[agent-loop-openai] ${errorResult} raw: ${acc.args.slice(0, 200)}`)
        toolResults.push({ role: "tool", tool_call_id: acc.id, content: errorResult })
        yield { type: "tool_done", toolName: acc.name, toolUseId: acc.id, result: errorResult, isError: true }
        continue
      }

      log.info(`[agent-loop-openai] Executing tool: ${acc.name} input: ${JSON.stringify(input).slice(0, 200)}`)

      const handler = handlerMap.get(acc.name)
      if (!handler) {
        const errorResult = `Unknown tool: ${acc.name}`
        toolResults.push({ role: "tool", tool_call_id: acc.id, content: errorResult })
        yield { type: "tool_done", toolName: acc.name, toolUseId: acc.id, result: errorResult, isError: true }
        continue
      }

      const { result, isError } = await handler(input)

      toolResults.push({ role: "tool", tool_call_id: acc.id, content: result })
      yield { type: "tool_done", toolName: acc.name, toolUseId: acc.id, result, isError }
    }

    if (turnText) {
      fullSummary += turnText
    }

    messages.push(...toolResults)
  }

  yield { type: "done", summary: `Completed with ${toolCallCount} tool calls (limit reached).`, toolCallCount, usage: totalUsage }
}
