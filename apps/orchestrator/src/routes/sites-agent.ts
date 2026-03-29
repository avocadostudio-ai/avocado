/**
 * Sites-agent routes — powered by Claude Agent SDK.
 *
 *   POST /sites-agent/start   — accepts request, returns streamId
 *   GET  /sites-agent/stream  — SSE connection, runs agent via SDK query(), streams events
 *   POST /sites-agent/cancel  — abort running agent
 */

import { randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyReply } from "fastify"
import type { RouteContext } from "./route-context.js"
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { createSitesAgentMcpServer } from "../agent/sites-agent-tools.js"
import { buildSitesAgentSystemPrompt } from "../agent/sites-agent-context.js"
import { sseWrite, parseSuggestionsFromSummary } from "../chat/chat-pipeline-shared.js"

type SitesAgentRequestBody = {
  session?: string
  message?: string
  locale?: string
}

type StreamEntry = {
  body: SitesAgentRequestBody
  apiKey: string
  origin: string
  createdAt: number
  state: "pending" | "active" | "done" | "error"
  events: Array<{ seq: number; payload: Record<string, unknown> }>
  lastSeq: number
  subscribers: Set<FastifyReply>
  abortController: AbortController
  siteCreatedConfigs: Record<string, unknown>[]
}

/** Human-readable labels for tool names shown in SSE status events. */
const TOOL_LABELS: Record<string, string> = {
  // MCP tools (prefixed by SDK)
  "mcp__sites-agent__list_sites": "Checking existing sites",
  "mcp__sites-agent__discover_site_structure": "Discovering site pages",
  "mcp__sites-agent__create_site": "Scaffolding site project",
  "mcp__sites-agent__scrape_url": "Analyzing website",
  "mcp__sites-agent__extract_design_tokens": "Extracting design tokens",
  "mcp__sites-agent__bootstrap_pages": "Creating pages with blocks",
  "mcp__sites-agent__download_remote_image": "Downloading image",
  "mcp__sites-agent__apply_theme": "Applying theme",
  // Built-in tools
  Write: "Writing file",
  Edit: "Editing file",
  Read: "Reading file",
  Bash: "Running command",
  Glob: "Searching files",
  Grep: "Searching code",
}

const streamContexts = new Map<string, StreamEntry>()
const STREAM_TTL_MS = 300_000 // 5 min
const STREAM_HEARTBEAT_INTERVAL_MS = 4_000

function cleanExpired() {
  const now = Date.now()
  for (const [id, entry] of streamContexts) {
    if (entry.state === "active") continue
    if (now - entry.createdAt > STREAM_TTL_MS) streamContexts.delete(id)
  }
}

function emitEvent(streamId: string, payload: Record<string, unknown>) {
  const entry = streamContexts.get(streamId)
  if (!entry) return
  entry.lastSeq++
  const event = { seq: entry.lastSeq, payload: { ...payload, _seq: entry.lastSeq } }
  entry.events.push(event)
  for (const sub of entry.subscribers) {
    sseWrite(sub, event.payload)
  }
}

/** Resolve the server-side API key. Agent SDK requires Anthropic. */
function resolveServerApiKey(): { apiKey: string } | null {
  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    return { apiKey: process.env.ANTHROPIC_API_KEY.trim() }
  }
  return null
}

export async function registerSitesAgentRoutes(app: FastifyInstance, ctx: RouteContext) {

  // ---------------------------------------------------------------------------
  // POST /sites-agent/start
  // ---------------------------------------------------------------------------
  app.post("/sites-agent/start", async (request, reply) => {
    cleanExpired()

    const resolved = resolveServerApiKey()
    if (!resolved) return reply.code(503).send({ error: "No Anthropic API key configured. Set ANTHROPIC_API_KEY (required for Agent SDK)." })

    const body = request.body as SitesAgentRequestBody
    if (!body.message?.trim()) return reply.code(400).send({ error: "message is required" })

    const streamId = randomUUID()
    streamContexts.set(streamId, {
      body,
      apiKey: resolved.apiKey,
      origin: (request.headers.origin as string) ?? "*",
      createdAt: Date.now(),
      state: "pending",
      events: [],
      lastSeq: 0,
      subscribers: new Set(),
      abortController: new AbortController(),
      siteCreatedConfigs: [],
    })
    return reply.code(200).send({ streamId })
  })

  // ---------------------------------------------------------------------------
  // POST /sites-agent/cancel
  // ---------------------------------------------------------------------------
  app.post("/sites-agent/cancel", async (request, reply) => {
    const { streamId } = request.body as { streamId?: string }
    if (!streamId) return reply.code(400).send({ error: "streamId is required" })

    const entry = streamContexts.get(streamId)
    if (!entry) return reply.code(410).send({ error: "Stream not found or expired" })

    if (entry.state === "active" || entry.state === "pending") {
      entry.abortController.abort()
      entry.state = "done"
      emitEvent(streamId, { type: "error", result: { status: "error", summary: "Canceled by user" } })
      for (const sub of entry.subscribers) {
        try { sub.raw.end() } catch { /* already closed */ }
      }
      entry.subscribers.clear()
    }

    return { ok: true }
  })

  // ---------------------------------------------------------------------------
  // GET /sites-agent/stream?streamId=X — SSE, runs Agent SDK query()
  // ---------------------------------------------------------------------------
  app.get("/sites-agent/stream", async (request, reply) => {
    const { streamId, afterSeq } = request.query as { streamId?: string; afterSeq?: string }
    if (!streamId) return reply.code(400).send({ error: "streamId is required" })

    const entry = streamContexts.get(streamId)
    if (!entry) return reply.code(410).send({ error: "Stream not found or expired" })

    const reqOrigin = (request.headers.origin as string) ?? entry.origin
    reply.raw.setHeader("Content-Type", "text/event-stream")
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform")
    reply.raw.setHeader("Connection", "keep-alive")
    reply.raw.setHeader("X-Accel-Buffering", "no")
    reply.raw.setHeader("Access-Control-Allow-Origin", reqOrigin)
    reply.raw.setHeader("Vary", "Origin")
    reply.raw.write("retry: 60000\n\n")

    // Replay buffered events
    const afterSeqNum = Number(afterSeq) || 0
    for (const event of entry.events) {
      if (event.seq > afterSeqNum) sseWrite(reply, event.payload)
    }

    if (entry.state === "done" || entry.state === "error") {
      reply.raw.end()
      return reply
    }

    entry.subscribers.add(reply)
    request.raw.on("close", () => entry.subscribers.delete(reply))

    if (entry.state === "pending") {
      entry.state = "active"

      const body = entry.body
      const session = body.session ?? "dev"

      const mcpServer = createSitesAgentMcpServer({
        session,
        emitSiteCreated: (config) => {
          entry.siteCreatedConfigs.push(config)
          emitEvent(streamId, { type: "site_created", config })
        },
      })

      const systemPrompt = buildSitesAgentSystemPrompt({ locale: body.locale })

      // Main agent (Opus): orchestration tools only — NO scrape/discover tools
      // Scraping is done by the structure-analyzer subagent (Sonnet, 5× cheaper)
      const orchestratorTools = [
        "Agent",
        "mcp__sites-agent__list_sites",
        "mcp__sites-agent__create_site",
        "mcp__sites-agent__bootstrap_pages",
        "mcp__sites-agent__download_remote_image",
        "mcp__sites-agent__apply_theme",
      ]

      // Structure-analyzer (Sonnet): scraping + analysis tools
      const analyzerTools = [
        "mcp__sites-agent__discover_site_structure",
        "mcp__sites-agent__scrape_url",
        "mcp__sites-agent__extract_design_tokens",
        "mcp__sites-agent__download_remote_image",
        "Read",
      ]

      // All tools combined for allowedTools (SDK needs full list)
      const allTools = [...new Set([...orchestratorTools, ...analyzerTools, "Read", "Write", "Edit", "Bash", "Glob", "Grep", "Skill"])]

      const heartbeatTimer = setInterval(() => {
        if (entry.state !== "active") return
        emitEvent(streamId, { type: "heartbeat", elapsedMs: Date.now() - entry.createdAt })
      }, STREAM_HEARTBEAT_INTERVAL_MS)

      const runLoop = async () => {
        try {
          const result = query({
            prompt: body.message!,
            options: {
              abortController: entry.abortController,
              cwd: process.cwd(),
              agent: "sites-agent",
              agents: {
                "sites-agent": {
                  description: "Site creation and migration orchestrator. Plans migrations, delegates analysis to subagents, then executes the plan.",
                  prompt: systemPrompt,
                  tools: orchestratorTools,
                  skills: ["site-scaffolding", "image-migration"],
                  model: process.env.SITES_AGENT_MODEL ?? "claude-opus-4-6",
                },
                "structure-analyzer": {
                  description: "Analyzes website structure — discovers pages, scrapes HTML/CSS with Playwright, extracts sections/outline/screenshots/design tokens. Returns a comprehensive text summary for the main agent to plan from.",
                  prompt: `You analyze external websites for migration. Your job is to produce a comprehensive analysis summary.

## Workflow
1. Call \`discover_site_structure\` to find all pages
2. Call \`scrape_url\` on the homepage first — this returns:
   - \`pageOutline\`: compact section-by-section breakdown of the entire page
   - \`sections[]\`: detailed extracted content per section
   - \`navigation\`: site name, logo URL, nav items with hierarchy
   - \`designTokens\` + \`themeVariables\`: colors, fonts, radii mapped to CSS vars
   - Screenshot (visual reference)
3. Scrape 3-5 other key pages (not ALL pages — prioritize pages with unique layouts)
4. Download the site logo with \`download_remote_image\` if found in navigation.logoUrl

## Output Format
Write a structured text summary (the main agent sees this, not the raw tool results):

\`\`\`
## Site Analysis: {domain}

### Pages Found
{list pages with slugs}

### Homepage Structure
{list each pageOutline section with type, heading, sub-items, image count}

### Navigation
- Site name: {name}
- Logo: {downloaded path or URL}
- Nav items: {list with labels and hrefs}
- Dropdown groups: {parent → children}

### Design Tokens
- Theme: {light/dark}
- Brand color: {hex}
- Background: {hex}
- Fonts: {heading font}, {body font}
- Full themeVariables: {JSON}

### Key Page Summaries
{for each scraped subpage: slug, section count, notable content}

### Hero Images
{list background image URLs found for hero sections — the main agent needs these for download}
\`\`\``,
                  tools: analyzerTools,
                  skills: ["site-structure-analysis"],
                  model: "claude-sonnet-4-6",
                },
                "block-coder": {
                  description: "Creates custom block types. Tell it: 'Create a {BlockName} block for site {siteId} with fields: {list}'. It writes schema, renderer, styles, and manifest files.",
                  prompt: `You create custom block types for site-specific sections. The caller will tell you the block name, site ID, and fields needed.

Write files to apps/{siteId}/blocks/{kebab-name}/ following the custom-block-creation skill exactly:
1. schema.ts — Zod schema + registerBlock + default props
2. renderer.tsx — React component with data-editable-target attributes
3. styles.css — responsive CSS using design system variables
4. Update apps/{siteId}/blocks/index.ts manifest (create if missing)

After writing files, run: pnpm typecheck
Fix any TypeScript errors before returning.

IMPORTANT: The block must be visually polished — use the site's CSS variables (--brand, --heading, --body, --surface, --border, etc.) and responsive design with clamp() typography and mobile breakpoints.`,
                  tools: ["Write", "Edit", "Read", "Bash", "Glob"],
                  skills: ["custom-block-creation"],
                  model: "claude-sonnet-4-6",
                },
              },
              tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
              allowedTools: allTools,
              settingSources: ["project"],
              mcpServers: { "sites-agent": mcpServer },
              env: { ...process.env, ANTHROPIC_API_KEY: entry.apiKey },
              permissionMode: "bypassPermissions",
              persistSession: false,
            },
          })

          let summaryText = ""
          let toolCallCount = 0

          console.log(`[sites-agent] Stream ${streamId}: agent loop started`)

          for await (const message of result) {
            // Log every SDK message for debugging
            logSdkMessage(streamId, message)

            const events = translateSdkMessage(message)
            for (const event of events) {
              if (event.type === "summary_token") summaryText += event.text
              if (event.type === "tool_use") toolCallCount++
              emitEvent(streamId, event as Record<string, unknown>)
            }

            // Check for final result
            if (message.type === "result") {
              const isSuccess = message.subtype === "success"
              console.log(`[sites-agent] Stream ${streamId}: result subtype=${message.subtype} turns=${isSuccess ? message.num_turns : "?"} cost=$${isSuccess ? message.total_cost_usd?.toFixed(4) : "?"}`)
              if (isSuccess && message.permission_denials?.length > 0) {
                console.log(`[sites-agent] Stream ${streamId}: permission denials:`, message.permission_denials)
              }
              const resultText = isSuccess ? message.result : summaryText
              const { summary: cleanSummary, suggestions } = parseSuggestionsFromSummary(resultText)
              emitEvent(streamId, {
                type: "final",
                result: {
                  status: isSuccess ? "applied" : "error",
                  summary: cleanSummary || (isSuccess ? "Migration completed" : "Migration failed"),
                  suggestions,
                  toolCallCount,
                  sitesCreated: entry.siteCreatedConfigs,
                },
              })
            }
          }

          console.log(`[sites-agent] Stream ${streamId}: loop ended normally, ${toolCallCount} tool calls`)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          const stack = err instanceof Error ? err.stack : undefined
          console.error(`[sites-agent] Stream ${streamId}: ERROR:`, msg)
          if (stack) console.error(`[sites-agent] Stack:`, stack)
          emitEvent(streamId, { type: "error", result: { status: "error", summary: msg } })
        } finally {
          clearInterval(heartbeatTimer)
          entry.state = "done"
          for (const sub of entry.subscribers) {
            try { sub.raw.end() } catch { /* already closed */ }
          }
          entry.subscribers.clear()
        }
      }

      runLoop()
    }

    return reply
  })
}

// ── Translate SDK messages to SSE events ──

type SSEEvent =
  | { type: "status"; message: string }
  | { type: "summary_token"; text: string }
  | { type: "tool_use"; toolName: string }
  | { type: "error"; result: { status: string; summary: string } }

/** Log SDK messages for debugging. */
function logSdkMessage(streamId: string, message: SDKMessage) {
  const prefix = `[sites-agent] ${streamId.slice(0, 8)}`
  const isSubagent = "parent_tool_use_id" in message && message.parent_tool_use_id
  const ctx = isSubagent ? " [sub]" : ""

  switch (message.type) {
    case "assistant": {
      const blocks = message.message.content
      const toolUses = blocks.filter(b => b.type === "tool_use")
      const textBlocks = blocks.filter(b => b.type === "text")
      if (toolUses.length > 0) {
        for (const tu of toolUses) {
          const name = "name" in tu ? tu.name : "?"
          console.log(`${prefix}${ctx} tool_use: ${name}`)
        }
      }
      if (textBlocks.length > 0) {
        const totalChars = textBlocks.reduce((sum, b) => sum + ("text" in b ? (b.text as string).length : 0), 0)
        if (totalChars > 0) console.log(`${prefix}${ctx} text: ${totalChars} chars`)
      }
      break
    }
    case "result":
      console.log(`${prefix} result: ${message.subtype}`)
      break
    case "system":
      if ("subtype" in message) console.log(`${prefix} system: ${message.subtype}`)
      break
    default:
      // Log other message types at debug level
      if ("type" in message) console.log(`${prefix} ${message.type}`)
  }
}

/** Derive a descriptive label from tool name + input. */
function describeToolUse(toolName: string, input?: Record<string, unknown>): string {
  // MCP tools — use static label map
  if (TOOL_LABELS[toolName]) return TOOL_LABELS[toolName]

  // Built-in tools — extract context from input
  const filePath = typeof input?.file_path === "string" ? input.file_path.split("/").pop() : null
  const command = typeof input?.command === "string" ? input.command : null

  switch (toolName) {
    case "Bash": {
      if (!command) return "Running command"
      if (/pnpm\s+install/i.test(command)) return "Installing dependencies"
      if (/typecheck/i.test(command)) return "Running typecheck"
      if (/pnpm\s+test/i.test(command)) return "Running tests"
      if (/mkdir/i.test(command)) return "Creating directory"
      // Show first meaningful word(s) of command
      const short = command.replace(/^(?:cd\s+\S+\s*&&\s*)?/, "").slice(0, 40).trim()
      return `Running: ${short}${command.length > 40 ? "..." : ""}`
    }
    case "Write":
      return filePath ? `Writing ${filePath}` : "Writing file"
    case "Read":
      return filePath ? `Reading ${filePath}` : "Reading file"
    case "Edit":
      return filePath ? `Editing ${filePath}` : "Editing file"
    case "Glob":
      return "Searching files"
    case "Grep":
      return "Searching code"
    default:
      return toolName.replace(/^mcp__sites-agent__/, "")
  }
}

function translateSdkMessage(message: SDKMessage): SSEEvent[] {
  switch (message.type) {
    case "assistant": {
      const events: SSEEvent[] = []
      const isSubagent = !!message.parent_tool_use_id

      for (const block of message.message.content) {
        if (block.type === "text" && "text" in block) {
          const text = block.text as string
          // Only emit text from the main agent (subagent results come via Agent tool)
          if (text.trim() && !isSubagent) {
            events.push({ type: "summary_token", text })
          }
        } else if (block.type === "tool_use" && "name" in block) {
          const toolName = block.name as string
          const input = "input" in block ? (block as unknown as Record<string, unknown>).input as Record<string, unknown> | undefined : undefined

          // Detect subagent invocation via Agent tool
          if (toolName === "Agent" || toolName === "Task") {
            const agentType = (input?.subagent_type ?? input?.description ?? "subagent") as string
            events.push({ type: "status", message: `Delegating to ${agentType}...` })
          } else {
            const prefix = isSubagent ? "[sub] " : ""
            const label = describeToolUse(toolName, input)
            events.push({ type: "status", message: `${prefix}${label}...` })
          }
          events.push({ type: "tool_use", toolName })
        }
      }

      return events
    }

    case "system": {
      if ("subtype" in message && message.subtype === "init") {
        return [{ type: "status", message: "Agent initialized" }]
      }
      return []
    }

    default:
      return []
  }
}
