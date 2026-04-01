/**
 * CLI-based migration agent runner — uses `claude` CLI with user's subscription
 * instead of the Agent SDK API (zero per-token cost).
 *
 * Spawns claude --print --output-format stream-json with an MCP config pointing
 * to our stdio MCP server for site migration tools.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { writeFile, mkdir } from "node:fs/promises"
import { resolve, dirname } from "node:path"
import { tmpdir } from "node:os"
import type { FastifyReply } from "fastify"
import { buildSitesAgentSystemPrompt } from "../agent/sites-agent-context.js"
import { buildIntegrationSystemPrompt } from "../agent/integration-prompt.js"
import { pushMigrationTelemetry } from "../telemetry/migration-telemetry.js"
import { describeToolUse, TOOL_PHASE_MAP, PHASES, INTEGRATION_PHASES, type PhaseId } from "./sites-agent.js"

export type CliStreamEntry = {
  body: { message?: string; session?: string; locale?: string; mode?: "migrate" | "integrate" }
  state: string
  abortController: AbortController
  siteCreatedConfigs: Record<string, unknown>[]
  subscribers: Set<FastifyReply>
  currentPhase: PhaseId | null
  emittedPhases: Set<PhaseId>
  imageCount: number
}

type EmitEventFn = (streamId: string, event: Record<string, unknown>) => void

export async function runCliAgent(
  body: CliStreamEntry["body"],
  entry: CliStreamEntry,
  streamId: string,
  emitEvent: EmitEventFn,
) {
  const startedAt = Date.now()
  let toolCallCount = 0
  const toolsUsed: string[] = []
  let summaryText = ""
  let proc: ChildProcess | null = null

  try {
    const isIntegrate = body.mode === "integrate"
    const systemPrompt = isIntegrate
      ? buildIntegrationSystemPrompt({ locale: body.locale })
      : buildSitesAgentSystemPrompt({ locale: body.locale })
    const session = body.session ?? "dev"

    // Write system prompt to temp file (too long for CLI arg)
    const tmpDir = resolve(tmpdir(), "sites-agent-cli")
    await mkdir(tmpDir, { recursive: true })
    const promptFile = resolve(tmpDir, `prompt-${streamId.slice(0, 8)}.txt`)
    await writeFile(promptFile, systemPrompt, "utf-8")

    // Write MCP config pointing to our stdio server
    const mcpConfigFile = resolve(tmpDir, `mcp-${streamId.slice(0, 8)}.json`)
    const orchestratorDir = resolve(dirname(new URL(import.meta.url).pathname), "../../")
    const mcpConfig = {
      mcpServers: {
        "sites-agent": {
          type: "stdio" as const,
          command: "npx",
          args: ["tsx", resolve(orchestratorDir, "src/migration/mcp-server-stdio.ts")],
          env: { MIGRATION_SESSION: session },
        },
      },
    }
    await writeFile(mcpConfigFile, JSON.stringify(mcpConfig), "utf-8")

    // Spawn claude CLI
    const allowedTools = isIntegrate
      ? "mcp__sites-agent__clone_repo,mcp__sites-agent__analyze_codebase,mcp__sites-agent__integrate_site,mcp__sites-agent__launch_site,mcp__sites-agent__register_site,mcp__sites-agent__list_sites,mcp__sites-agent__bootstrap_pages,mcp__sites-agent__apply_theme,Read,Write,Edit,Bash,Glob,Grep"
      : "mcp__sites-agent__discover_site_structure,mcp__sites-agent__generate_page_specs,mcp__sites-agent__scrape_url,mcp__sites-agent__extract_design_tokens,mcp__sites-agent__create_site,mcp__sites-agent__bootstrap_pages,mcp__sites-agent__download_remote_image,mcp__sites-agent__download_remote_images,mcp__sites-agent__apply_theme,Write,Edit,Bash"

    const cliArgs = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--system-prompt-file", promptFile,
      "--mcp-config", mcpConfigFile,
      "--strict-mcp-config",
      "--model", "sonnet",
      "--permission-mode", "bypassPermissions",
      "--no-session-persistence",
      "--allowed-tools", allowedTools,
      "--", body.message!,
    ]

    console.log(`[sites-agent-cli] ${streamId.slice(0, 8)} spawning claude CLI...`)
    // Strip API keys so the CLI uses the user's subscription (OAuth), not the API key
    const cliEnv = { ...process.env }
    delete cliEnv.ANTHROPIC_API_KEY
    delete cliEnv.OPENAI_API_KEY

    proc = spawn("claude", cliArgs, {
      env: cliEnv,
      stdio: ["ignore", "pipe", "pipe"],
    })

    // Handle abort
    const abortHandler = () => { proc?.kill("SIGTERM") }
    entry.abortController.signal.addEventListener("abort", abortHandler)

    // Buffer for incomplete JSON lines
    let buffer = ""

    proc.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? "" // keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line) as Record<string, unknown>
          const events = translateCliMessage(msg, entry, streamId, emitEvent)
          for (const event of events) {
            if (event.type === "summary_token") summaryText += (event as { text: string }).text
            if (event.type === "tool_use") {
              toolCallCount++
              const toolName = (event as { toolName: string }).toolName
              toolsUsed.push(toolName)
            }
            emitEvent(streamId, event)
          }

          // Detect tool results that contain site config (for site_created event)
          const toolResults = extractToolResults(msg)
          for (const result of toolResults) {
            if (result.siteId && result.port) {
              const config = {
                id: result.siteId,
                name: result.name ?? result.siteId,
                purpose: result.purpose ?? "",
                hosting: "local",
                previewUrl: `http://localhost:${result.port}`,
              }
              entry.siteCreatedConfigs.push(config)
              emitEvent(streamId, { type: "site_created", config })
            }
          }
        } catch {
          // Not valid JSON — log for debugging
          if (line.length > 5) console.log(`[sites-agent-cli] ${streamId.slice(0, 8)} non-json: ${line.slice(0, 100)}`)
        }
      }
    })

    let stderrOutput = ""
    proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) {
        stderrOutput += text + "\n"
        console.error(`[sites-agent-cli] ${streamId.slice(0, 8)} stderr: ${text.slice(0, 200)}`)
      }
    })

    // Wait for process to exit
    const exitCode = await new Promise<number>((resolve) => {
      proc!.on("close", (code) => resolve(code ?? 0))
    })

    entry.abortController.signal.removeEventListener("abort", abortHandler)
    const durationMs = Date.now() - startedAt
    const isSuccess = exitCode === 0

    console.log(`[sites-agent-cli] ${streamId.slice(0, 8)} exited code=${exitCode} tools=${toolCallCount} duration=${Math.round(durationMs / 1000)}s`)
    if (stderrOutput) console.log(`[sites-agent-cli] ${streamId.slice(0, 8)} stderr summary: ${stderrOutput.slice(0, 500)}`)

    const errorDetail = !isSuccess && stderrOutput ? ` (${stderrOutput.trim().split("\n").pop()})` : ""
    emitEvent(streamId, {
      type: "final",
      result: {
        status: isSuccess ? "applied" : "error",
        summary: summaryText.slice(-2000) || (isSuccess ? "Migration completed (CLI)" : `Migration failed${errorDetail}`),
        suggestions: [],
        toolCallCount,
        sitesCreated: entry.siteCreatedConfigs,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          totalCostUsd: 0,
          numTurns: toolCallCount,
          cliMode: true,
        },
      },
    })

    pushMigrationTelemetry({
      timestamp: new Date().toISOString(),
      streamId,
      status: isSuccess ? "success" : "error",
      durationMs,
      numTurns: toolCallCount,
      toolCallCount,
      toolsUsed,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0,
      sitesCreated: entry.siteCreatedConfigs.map((c) => String(c.id ?? "")),
      userMessage: body.message?.slice(0, 200),
      debugDir: resolve(tmpdir(), "sites-agent-cli"),
    })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[sites-agent-cli] ${streamId.slice(0, 8)} ERROR: ${msg}`)
    emitEvent(streamId, { type: "error", result: { status: "error", summary: msg } })
  }
}

/** Extract tool result data from CLI stream-json messages (for detecting site creation, etc.) */
function extractToolResults(msg: Record<string, unknown>): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = []

  // Try to find JSON with siteId/port in any text content within the message
  const textsToCheck: string[] = []

  // Format 1: user message with tool_result blocks (SDK-style)
  if (msg.type === "user") {
    const message = msg.message as { content?: Array<Record<string, unknown>> } | undefined
    if (message?.content) {
      for (const block of message.content) {
        if (block.type === "tool_result" && typeof block.content === "string") {
          textsToCheck.push(block.content)
        }
      }
    }
  }

  // Format 2: result message (CLI stream-json tool results)
  if (msg.type === "result") {
    const result = msg.result as string | undefined
    if (result) textsToCheck.push(result)
    // Also check subResult for MCP
    const subResult = msg.subResult as string | undefined
    if (subResult) textsToCheck.push(subResult)
  }

  // Format 3: assistant message with tool_result content blocks
  if (msg.type === "assistant") {
    const message = msg.message as { content?: Array<Record<string, unknown>> } | undefined
    if (message?.content) {
      for (const block of message.content) {
        if (typeof block.text === "string") textsToCheck.push(block.text)
        if (typeof block.content === "string") textsToCheck.push(block.content)
      }
    }
  }

  // Parse any JSON strings that contain siteId or port
  for (const text of textsToCheck) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      if (parsed.siteId || parsed.port) results.push(parsed)
    } catch {
      // Try to find JSON within the text (MCP results may have wrapper text)
      const jsonMatch = text.match(/\{[^{}]*"siteId"[^{}]*\}/)
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>
          if (parsed.siteId || parsed.port) results.push(parsed)
        } catch { /* not valid JSON */ }
      }
    }
  }
  return results
}

/** Translate CLI stream-json messages to SSE events with enriched labels and phase detection. */
function translateCliMessage(
  msg: Record<string, unknown>,
  entry: CliStreamEntry,
  streamId: string,
  emitEvent: EmitEventFn,
): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = []
  const type = msg.type as string

  if (type === "assistant") {
    const message = msg.message as { content?: Array<Record<string, unknown>> } | undefined
    if (!message?.content) return events

    for (const block of message.content) {
      if (block.type === "text") {
        const text = block.text as string
        if (text) events.push({ type: "summary_token", text })
      } else if (block.type === "tool_use") {
        const toolName = block.name as string ?? "unknown"
        const input = block.input as Record<string, unknown> | undefined

        // Enriched label using shared describeToolUse
        const label = describeToolUse(toolName, input)
        events.push({ type: "status", message: `${label}...` })
        events.push({ type: "tool_use", toolName })

        // Phase detection — same logic as SDK path
        const detectedPhase = TOOL_PHASE_MAP[toolName] as PhaseId | undefined
        const activePhases = entry.body.mode === "integrate" ? INTEGRATION_PHASES : PHASES
        if (detectedPhase && !entry.emittedPhases.has(detectedPhase)) {
          const phaseInfo = activePhases.find(p => p.id === detectedPhase)
          if (phaseInfo) {
            entry.currentPhase = detectedPhase
            entry.emittedPhases.add(detectedPhase)
            emitEvent(streamId, { type: "phase", phase: detectedPhase, activeLabel: phaseInfo.activeLabel, doneLabel: phaseInfo.doneLabel })
          }
        }
      }
    }
  }

  return events
}
