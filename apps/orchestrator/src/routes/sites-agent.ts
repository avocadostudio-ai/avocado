/**
 * Sites-agent routes — powered by Claude Agent SDK.
 *
 *   POST /sites-agent/start   — accepts request, returns streamId
 *   GET  /sites-agent/stream  — SSE connection, runs agent via SDK query(), streams events
 *   POST /sites-agent/cancel  — abort running agent
 */

import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { homedir } from "node:os"
import type { FastifyInstance, FastifyReply } from "fastify"
import type { RouteContext } from "./route-context.js"
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { createSitesAgentMcpServer } from "../agent/sites-agent-tools.js"
import { buildSitesAgentSystemPrompt } from "../agent/sites-agent-context.js"
import { buildIntegrationSystemPrompt } from "../agent/integration-prompt.js"
import { triageWithHaiku, SITES_AGENT_MODELS } from "../agent/sites-agent-shared.js"
import { sseWrite, parseSuggestionsFromSummary } from "../chat/chat-pipeline-shared.js"
import { pushMigrationTelemetry } from "../telemetry/migration-telemetry.js"
import { runCliAgent, type CliStreamEntry } from "./sites-agent-cli.js"

type SitesAgentRequestBody = {
  session?: string
  message?: string
  locale?: string
  /** Use Claude CLI (subscription-based, $0 cost) instead of Agent SDK (pay-per-token) */
  useCliAgent?: boolean
  /** Agent mode: "migrate" scrapes a URL, "integrate" adds SDK to an existing codebase */
  mode?: "migrate" | "integrate"
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
  currentPhase: PhaseId | null
  emittedPhases: Set<PhaseId>
  imageCount: number
}

// ── Phase tracking ──

export type PhaseId = "cloning" | "analyzing" | "creating" | "custom-blocks" | "images" | "pages" | "installing" | "integrating" | "launching" | "verifying"

export const PHASES: { id: PhaseId; activeLabel: string; doneLabel: string }[] = [
  { id: "analyzing", activeLabel: "Analyzing website", doneLabel: "Website analyzed" },
  { id: "creating", activeLabel: "Creating project", doneLabel: "Project created" },
  { id: "custom-blocks", activeLabel: "Building custom blocks", doneLabel: "Custom blocks built" },
  { id: "images", activeLabel: "Downloading images", doneLabel: "Images downloaded" },
  { id: "pages", activeLabel: "Creating pages", doneLabel: "Pages created" },
]

export const INTEGRATION_PHASES: { id: PhaseId; activeLabel: string; doneLabel: string }[] = [
  { id: "cloning", activeLabel: "Cloning repository", doneLabel: "Repository cloned" },
  { id: "analyzing", activeLabel: "Analyzing codebase", doneLabel: "Codebase analyzed" },
  { id: "installing", activeLabel: "Installing dependencies", doneLabel: "Dependencies installed" },
  { id: "integrating", activeLabel: "Creating integration files", doneLabel: "Integration complete" },
  { id: "launching", activeLabel: "Starting dev server", doneLabel: "Site is live" },
  { id: "pages", activeLabel: "Bootstrapping content", doneLabel: "Content created" },
  { id: "verifying", activeLabel: "Verifying build", doneLabel: "Build verified" },
]

/** Map tool names to the phase they belong to */
export const TOOL_PHASE_MAP: Record<string, PhaseId> = {
  "mcp__sites-agent__discover_site_structure": "analyzing",
  "mcp__sites-agent__scrape_url": "analyzing",
  "mcp__sites-agent__extract_design_tokens": "analyzing",
  "mcp__sites-agent__clone_repo": "cloning",
  "mcp__sites-agent__analyze_codebase": "analyzing",
  "mcp__sites-agent__create_site": "creating",
  "mcp__sites-agent__download_remote_image": "images",
  "mcp__sites-agent__download_remote_images": "images",
  "mcp__sites-agent__bootstrap_pages": "pages",
  "mcp__sites-agent__integrate_site": "integrating",
  "mcp__sites-agent__launch_site": "launching",
  "mcp__sites-agent__register_site": "integrating",
}

/** Tools that should not emit status/step events (SDK bootstrap internals). */
const SILENT_TOOLS = new Set(["ToolSearch", "ListMcpResourcesTool"])

/** Human-readable labels for tool names shown in SSE status events. */
export const TOOL_LABELS: Record<string, string> = {
  // MCP tools (prefixed by SDK)
  "mcp__sites-agent__list_sites": "Checking existing sites",
  "mcp__sites-agent__discover_site_structure": "Discovering site pages",
  "mcp__sites-agent__create_site": "Scaffolding site project",
  "mcp__sites-agent__scrape_url": "Analyzing website",
  "mcp__sites-agent__extract_design_tokens": "Extracting design tokens",
  "mcp__sites-agent__bootstrap_pages": "Creating pages with blocks",
  "mcp__sites-agent__download_remote_image": "Downloading image",
  "mcp__sites-agent__download_remote_images": "Downloading images",
  "mcp__sites-agent__apply_theme": "Applying theme",
  "mcp__sites-agent__clone_repo": "Cloning repository",
  "mcp__sites-agent__analyze_codebase": "Analyzing codebase",
  "mcp__sites-agent__integrate_site": "Integrating site",
  "mcp__sites-agent__launch_site": "Starting site",
  "mcp__sites-agent__register_site": "Registering site",
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

    const body = request.body as SitesAgentRequestBody

    // CLI mode uses the user's Claude subscription — no API key needed
    const resolved = body.useCliAgent ? { apiKey: "" } : resolveServerApiKey()
    if (!resolved) return reply.code(503).send({ error: "No Anthropic API key configured. Set ANTHROPIC_API_KEY (required for Agent SDK)." })
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
      currentPhase: null,
      emittedPhases: new Set(),
      imageCount: 0,
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
      console.log(`[sites-agent] Stream ${streamId}: INIT mode=${body.mode ?? "migrate"} cli=${!!body.useCliAgent} message="${body.message?.slice(0, 100)}"`)

      // ── Haiku triage — classify intent, extract params, short-circuit questions ──
      let triage: Awaited<ReturnType<typeof triageWithHaiku>> | null = null
      if (!body.useCliAgent && entry.apiKey) {
        try {
          triage = await triageWithHaiku(body.message!, entry.apiKey)

          // Short-circuit: answer simple questions without spawning the agent
          if (triage.intent === "question" && triage.answer) {
            emitEvent(streamId, { type: "summary_token", text: triage.answer })
            emitEvent(streamId, {
              type: "final",
              result: {
                status: "applied",
                summary: triage.answer,
                suggestions: [],
                toolCallCount: 0,
                sitesCreated: [],
                usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalCostUsd: 0, numTurns: 0, triageOnly: true },
              },
            })
            entry.state = "done"
            for (const sub of entry.subscribers) {
              try { sub.raw.end() } catch { /* already closed */ }
            }
            entry.subscribers.clear()
            return reply
          }

          // Override mode from triage (more accurate than client-side regex)
          if (triage.intent === "integrate") body.mode = "integrate"
          else if (triage.intent === "create" || triage.intent === "migrate") body.mode = "migrate"
        } catch (err: unknown) {
          console.log(`[sites-agent] Triage failed, continuing without: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      const mcpServer = createSitesAgentMcpServer({
        session,
        emitSiteCreated: (config) => {
          entry.siteCreatedConfigs.push(config)
          emitEvent(streamId, { type: "site_created", config })
        },
        emitPhaseOutcome: (outcome) => {
          const { tool, data } = outcome
          if (tool === "discover_site_structure") {
            emitEvent(streamId, { type: "phase_outcome", phase: "analyzing", outcome: `Found ${data.totalPages} pages on ${data.origin}` })
          } else if (tool === "create_site") {
            emitEvent(streamId, { type: "phase_outcome", phase: "creating", outcome: `Created ${data.name} — port ${data.port}` })
          } else if (tool === "download_remote_image") {
            entry.imageCount++
            emitEvent(streamId, { type: "phase_outcome", phase: "images", outcome: `${entry.imageCount} image${entry.imageCount > 1 ? "s" : ""} downloaded` })
          } else if (tool === "download_remote_images") {
            entry.imageCount += (data.succeeded as number) ?? (data.total as number) ?? 0
            emitEvent(streamId, { type: "phase_outcome", phase: "images", outcome: `${entry.imageCount} image${entry.imageCount > 1 ? "s" : ""} downloaded` })
            // Batch download is the last image tool — mark images phase done so UI
            // doesn't spin while agent moves on to block-coder / bootstrap_pages
            emitEvent(streamId, { type: "phase_done", phase: "images" })
            // Pre-start the next phase immediately to avoid a long dead gap while
            // the LLM composes the bootstrap_pages tool call (can take 30-60s)
            if (!entry.emittedPhases.has("pages")) {
              entry.emittedPhases.add("pages")
              entry.currentPhase = "pages"
              const pagesPhase = activePhases.find(p => p.id === "pages")
              if (pagesPhase) {
                emitEvent(streamId, { type: "phase", phase: "pages", activeLabel: pagesPhase.activeLabel, doneLabel: pagesPhase.doneLabel })
              }
            }
          } else if (tool === "bootstrap_pages") {
            emitEvent(streamId, { type: "phase_outcome", phase: "pages", outcome: `${data.pagesCreated} pages, ${data.totalBlocks} blocks` })
          } else if (tool === "analyze_codebase") {
            emitEvent(streamId, { type: "phase_outcome", phase: "analyzing", outcome: `${data.framework} — ${data.routes} routes` })
          } else if (tool === "integrate_site") {
            emitEvent(streamId, { type: "phase_outcome", phase: "integrating", outcome: `${data.name} — ${data.filesCreated} files created, port ${data.port}` })
          } else if (tool === "register_site") {
            emitEvent(streamId, { type: "phase_outcome", phase: "integrating", outcome: `${data.name} — port ${data.port}` })
          }
        },
      })

      const isIntegrate = body.mode === "integrate"
      const systemPrompt = isIntegrate
        ? buildIntegrationSystemPrompt({ locale: body.locale })
        : buildSitesAgentSystemPrompt({ locale: body.locale })

      // Phase config depends on mode
      const activePhases = isIntegrate ? INTEGRATION_PHASES : PHASES

      // Main agent tools depend on mode
      const orchestratorTools = isIntegrate
        ? [
            "mcp__sites-agent__clone_repo",
            "mcp__sites-agent__analyze_codebase",
            "mcp__sites-agent__integrate_site",
            "mcp__sites-agent__launch_site",
            "mcp__sites-agent__register_site",
            "mcp__sites-agent__list_sites",
            "mcp__sites-agent__bootstrap_pages",
            "mcp__sites-agent__apply_theme",
            "Read", "Write", "Edit", "Bash", "Glob", "Grep",
          ]
        : [
            "Agent",
            "mcp__sites-agent__list_sites",
            "mcp__sites-agent__create_site",
            "mcp__sites-agent__bootstrap_pages",
            "mcp__sites-agent__download_remote_image",
            "mcp__sites-agent__download_remote_images",
            "mcp__sites-agent__apply_theme",
          ]

      // Structure-analyzer (Sonnet): analysis tools only — migrate mode only
      const analyzerTools = isIntegrate ? [] : [
        "mcp__sites-agent__discover_site_structure",
        "mcp__sites-agent__generate_page_specs",
        "mcp__sites-agent__extract_design_tokens",
        "mcp__sites-agent__download_remote_image",
        "Read",
      ]

      // All tools combined for allowedTools (SDK needs full list)
      // In migrate mode, block-coder subagent needs file tools but main agent should NOT have them
      // — otherwise it bypasses our MCP tools (e.g. scaffolding with Write/Bash instead of create_site)
      const blockCoderTools = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
      const allTools = [...new Set([...orchestratorTools, ...analyzerTools, ...blockCoderTools])]

      const heartbeatTimer = setInterval(() => {
        if (entry.state !== "active") return
        emitEvent(streamId, { type: "heartbeat", elapsedMs: Date.now() - entry.createdAt })
      }, STREAM_HEARTBEAT_INTERVAL_MS)

      const runLoop = async () => {
        // CLI mode: spawn claude CLI with user's subscription ($0 cost)
        if (body.useCliAgent) {
          try {
            await runCliAgent(body, entry as CliStreamEntry, streamId, emitEvent)
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            emitEvent(streamId, { type: "error", result: { status: "error", summary: msg } })
          } finally {
            clearInterval(heartbeatTimer)
            entry.state = "done"
            for (const sub of entry.subscribers) {
              try { sub.raw.end() } catch { /* already closed */ }
            }
            entry.subscribers.clear()
          }
          return
        }

        // SDK mode: use Agent SDK query() with API key (pay-per-token)
        try {
          const maxBudgetUsd = Number(process.env.SITES_AGENT_MAX_BUDGET_USD || "2")

          // Build agents config — integrate mode uses a single agent, migrate mode uses subagents
          const mainAgentDesc = isIntegrate
            ? "Site integration agent. Analyzes an existing codebase and adds AI Site Editor SDK integration."
            : "Site creation and migration orchestrator. Plans migrations, delegates analysis to subagents, then executes the plan."

          // Enrich prompt with triage results so the agent doesn't re-discover intent
          let enrichedPrompt = body.message!
          if (triage && triage.intent !== "question") {
            const parts: string[] = [body.message!]
            if (triage.url) parts.push(`\n[Triage: URL=${triage.url}]`)
            if (triage.siteName) parts.push(`[Triage: siteName=${triage.siteName}]`)
            if (triage.scope) parts.push(`[Triage: scope=${triage.scope}]`)
            if (triage.intent) parts.push(`[Triage: intent=${triage.intent}]`)
            enrichedPrompt = parts.join("")
          }

          const result = query({
            prompt: enrichedPrompt,
            options: {
              abortController: entry.abortController,
              maxBudgetUsd,
              cwd: process.cwd(),
              agent: "sites-agent",
              agents: {
                "sites-agent": {
                  description: mainAgentDesc,
                  prompt: systemPrompt,
                  tools: orchestratorTools,
                  skills: isIntegrate ? ["site-integration"] : ["site-scaffolding", "image-migration"],
                  model: SITES_AGENT_MODELS.balanced,
                },
                // Subagents only used in migrate mode
                ...(!isIntegrate ? { "structure-analyzer": {
                  description: "Analyzes website structure — discovers pages, scrapes HTML/CSS with Playwright, extracts sections/outline/screenshots/design tokens. Returns a comprehensive text summary for the main agent to plan from.",
                  prompt: `You analyze external websites for migration. Your job is to produce a comprehensive analysis summary.

## Workflow
1. Call \`discover_site_structure\` to find all pages
2. Call \`generate_page_specs\` on the homepage first — this returns detailed **section specs** with:
   - \`specs[]\`: per-section block-type-agnostic specs with exact computed CSS styles, DOM structure, content, and design notes
   - \`designTokens\` + \`themeVariables\`: colors, fonts, radii mapped to CSS vars
   - \`nav\`: site name, logo URL, nav items with hierarchy
3. Use \`generate_page_specs\` on 3-5 other key pages (not ALL — prioritize unique layouts)
4. Download the site logo with \`download_remote_image\` if found in nav.logoUrl

## Output Format
Write a structured text summary (the main agent sees this, not the raw tool results):

\`\`\`
## Site Analysis: {domain}

### Pages Found
{list pages with slugs}

### Homepage Section Specs
For each section spec, include:
- Index, suggestedBlockType, confidence
- structure.pattern (e.g. "3-column grid of 4 items")
- structure.interactionModel (static/accordion/tabs/carousel)
- structure.repeatCount + repeatSignature (if > 0)
- Key styles: container background, heading font/size/color, CTA color
- Content summary: headings, image count, link count
- designNotes summary

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
{for each scraped subpage: section spec summaries}

### Hero Images
{list background image URLs found for hero sections}
\`\`\``,
                  tools: analyzerTools,
                  skills: ["site-structure-analysis"],
                  model: SITES_AGENT_MODELS.balanced,
                },
                "block-coder": {
                  description: "Creates custom block types. Tell it: 'Create a {BlockName} block for site {siteId} with fields: {list}'. It writes schema, renderer, styles, and manifest files.",
                  prompt: `You create custom block types for site-specific sections. The caller will tell you the block name, site ID, and fields needed.

ALL files are REQUIRED — if any is missing, the block will silently fail to render:

1. \`apps/{siteId}/blocks/{kebab-name}/schema.ts\` — Zod schema + registerBlock() + default props export
2. \`apps/{siteId}/blocks/{kebab-name}/renderer.tsx\` — React component with "use client" directive and data-editable-target attributes
3. \`apps/{siteId}/blocks/{kebab-name}/styles.css\` — responsive CSS using design system variables (optional if using inline styles)
4. \`apps/{siteId}/blocks/register.ts\` — update with ALL THREE lines per block:
   \`\`\`typescript
   import "./kebab-name/schema.ts"                              // side-effect: registers the block
   import { BlockName } from "./kebab-name/renderer.tsx"        // MUST include .tsx extension
   registerCustomRenderer("BlockName", BlockName)
   \`\`\`

CRITICAL import rules:
- ALWAYS use file extensions: \`.ts\` for schema, \`.tsx\` for renderer
- Without extensions, Node.js module resolution fails SILENTLY — the block simply won't render

After writing ALL files, run this verification sequence — do NOT return until all pass:

1. \`pnpm typecheck\` — must pass with zero errors. If it fails, read the errors, fix the code, and re-run.
2. \`rm -rf apps/{siteId}/.next && pnpm --filter @ai-site-editor/{siteId} build\` — clear cache and build. Must pass. This catches runtime import resolution failures that typecheck misses (e.g. missing .tsx extensions).
3. Verify register.ts correctness:
   - \`grep "schema.ts" apps/{siteId}/blocks/register.ts\` — must find the schema import
   - \`grep "renderer.tsx" apps/{siteId}/blocks/register.ts\` — must find the renderer import WITH .tsx
   - \`grep "registerCustomRenderer" apps/{siteId}/blocks/register.ts\` — must find the registration call
4. Verify schema.ts correctness:
   - \`grep "registerBlock" apps/{siteId}/blocks/{kebab-name}/schema.ts\` — must find registerBlock call

If ANY step fails, diagnose and fix before returning. A block that passes typecheck but fails build will silently not render.

IMPORTANT — MANDATORY rules for every custom block:

1. **CSS variables ONLY** — NEVER hardcode hex colors. Use the site's CSS variables: \`var(--brand)\`, \`var(--heading)\`, \`var(--body)\`, \`var(--card-bg)\`, \`var(--border)\`, \`var(--bg-0)\`, \`var(--surface)\`, \`var(--body-secondary)\`. This ensures the block adapts when the user changes the theme. Hardcoded colors like \`#1f2124\` or \`#e74721\` are FORBIDDEN.
2. **registerBlock() is REQUIRED** in schema.ts — without it the block won't appear in the editor's block catalog and the editor UI won't know what fields are editable. See the example below.
3. **auto-fit grid** — use \`grid-template-columns: repeat(auto-fit, minmax(Xpx, 1fr))\` instead of \`repeat(N, 1fr)\` so the layout adapts to any number of items.
4. **clamp() for ALL large font sizes** — not just headings. Any font-size > 24px must use clamp().
5. **Responsive design** with mobile breakpoints at 600px and tablet at 1024px.

DO NOT use Read, Glob, or Grep to explore existing blocks. DO NOT read files from packages/blocks/ or packages/shared/ — everything you need is in the example below. Write your files directly based on the example pattern. Only use Read to check your OWN generated files if typecheck or build fails.

## Complete Working Example

### schema.ts
\`\`\`typescript
import { z } from "zod"
import { registerBlock } from "@ai-site-editor/shared"

registerBlock("PricingTable", {
  schema: z.object({
    title: z.string().optional(),
    subtitle: z.string().optional(),
    tiers: z.array(z.object({
      duration: z.string().min(1),
      label: z.string().min(1),
      price: z.string().min(1),
      features: z.string().min(1),
    })).min(1),
    footnote: z.string().optional(),
  }),
  meta: {
    displayName: "Pricing Table",
    description: "Side-by-side pricing tiers.",
    category: "conversion",
    fields: {
      title: { kind: "text", label: "Title" },
      subtitle: { kind: "text", label: "Subtitle" },
      footnote: { kind: "text", label: "Footnote", multiline: true },
    },
    listFields: {
      tiers: {
        label: "Tiers",
        itemFields: {
          duration: { kind: "text", label: "Duration" },
          label: { kind: "text", label: "Label" },
          price: { kind: "text", label: "Price" },
          features: { kind: "text", label: "Features (newline-separated)", multiline: true },
        },
      },
    },
  },
})
\`\`\`

### renderer.tsx
\`\`\`tsx
import type { JSX } from "react"

export function PricingTable(props: Record<string, unknown>) {
  const title = String(props.title ?? "")
  const tiers = Array.isArray(props.tiers) ? props.tiers : []
  const footnote = String(props.footnote ?? "")

  return (
    <section className="pricing-table-section">
      <div className="section__inner">
        {title && <h2 data-editable-target="title" data-editable-label="title">{title}</h2>}
        <div className="pricing-table__grid">
          {tiers.map((item, idx) => {
            const tier = (item ?? {}) as Record<string, unknown>
            const features = String(tier.features ?? "").split("\\n").filter(Boolean)
            return (
              <div key={idx} className="pricing-table__tier" data-editable-target={\`tiers[\${idx}]\`} data-editable-label={\`tiers[\${idx}]\`}>
                <div className="pricing-table__duration" data-editable-target={\`tiers[\${idx}].duration\`} data-editable-label={\`tiers[\${idx}].duration\`}>{String(tier.duration ?? "")}</div>
                <div className="pricing-table__label" data-editable-target={\`tiers[\${idx}].label\`} data-editable-label={\`tiers[\${idx}].label\`}>{String(tier.label ?? "")}</div>
                <div className="pricing-table__price" data-editable-target={\`tiers[\${idx}].price\`} data-editable-label={\`tiers[\${idx}].price\`}>{String(tier.price ?? "")}</div>
                <ul className="pricing-table__features">{features.map((f, i) => <li key={i}>{f}</li>)}</ul>
              </div>
            )
          })}
        </div>
        {footnote && <p className="pricing-table__footnote" data-editable-target="footnote" data-editable-label="footnote">{footnote}</p>}
      </div>
    </section>
  )
}
\`\`\`

### styles.css
\`\`\`css
.pricing-table-section { padding: 48px 20px; text-align: center; }
.pricing-table-section h2 { font-size: clamp(1.75rem, 3vw, 2.5rem); font-weight: 800; text-transform: uppercase; margin-bottom: 8px; color: var(--heading); }
.pricing-table__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; max-width: 960px; margin: 0 auto; }
.pricing-table__tier { background: var(--card-bg); border: 1px solid var(--border); padding: 28px 20px; display: flex; flex-direction: column; align-items: center; gap: 8px; }
.pricing-table__duration { font-size: clamp(3rem, 6vw, 5rem); font-weight: 800; line-height: 1; color: var(--heading); }
.pricing-table__label { font-size: 0.8125rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--brand); }
.pricing-table__price { font-size: 1.25rem; font-weight: 700; color: var(--heading); margin-bottom: 8px; }
.pricing-table__features { list-style: none; padding: 0; margin: 0; text-align: left; font-size: 0.875rem; color: var(--body); line-height: 1.6; }
.pricing-table__footnote { margin-top: 24px; font-size: 0.9375rem; color: var(--body); max-width: 700px; margin: 24px auto 0; }
@media (max-width: 600px) { .pricing-table__grid { grid-template-columns: 1fr 1fr; } }
\`\`\`

### register.ts (append these lines)
\`\`\`typescript
import "./pricing-table/schema.ts"
import { PricingTable } from "./pricing-table/renderer.tsx"
registerCustomRenderer("PricingTable", PricingTable)
\`\`\`

Key patterns to follow:
- Use \`import { registerBlock } from "@ai-site-editor/shared"\` (NOT \`f\` helper)
- Field metadata as inline objects: \`{ kind: "text", label: "..." }\`
- List items with newline-separated strings for multi-value fields
- BEM class names: \`.block-name__element\`
- CSS variables: --heading, --body, --brand, --card-bg, --border, --body-secondary
- \`data-editable-target\` and \`data-editable-label\` on every editable element
- \`clamp()\` for responsive typography`,
                  tools: ["Write", "Edit", "Bash"],
                  skills: ["custom-block-creation"],
                  model: SITES_AGENT_MODELS.balanced,
                } } : {}),
              },
              // In integrate mode, main agent needs file tools directly.
              // In migrate mode, only subagents (block-coder) need file tools —
              // main agent should use MCP tools (create_site, bootstrap_pages, etc.)
              tools: isIntegrate ? ["Read", "Write", "Edit", "Bash", "Glob", "Grep"] : [],
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
          const toolsUsed: string[] = []
          const toolDetails: Array<{ tool: string; agent: "main" | "sub" }> = []
          const startedAt = Date.now()

          // Diminishing returns detection — track tool call velocity between phase changes
          const STALL_THRESHOLD_MS = 120_000
          const STALL_TOOL_THRESHOLD = 15
          let stallToolCalls = 0
          let lastPhaseChangeAt = startedAt
          let stallWarningEmitted = false

          console.log(`[sites-agent] Stream ${streamId}: agent loop started`)

          for await (const message of result) {
            // Log every SDK message for debugging
            logSdkMessage(streamId, message)

            const events = translateSdkMessage(message)
            for (const event of events) {
              if (event.type === "summary_token") summaryText += event.text
              if (event.type === "tool_use") {
                toolCallCount++
                stallToolCalls++
                const toolName = (event as { toolName?: string }).toolName ?? "unknown"
                const isSubagent = "parent_tool_use_id" in message && !!message.parent_tool_use_id
                toolsUsed.push(toolName)
                toolDetails.push({ tool: toolName, agent: isSubagent ? "sub" : "main" })

                // Detect phase transitions (skip already-emitted phases to avoid duplicates)
                let detectedPhase: PhaseId | null = TOOL_PHASE_MAP[toolName] ?? null

                // Detect block-coder subagent invocation
                const agentType = (event as { agentType?: string }).agentType
                if (agentType && /block-coder/i.test(agentType)) detectedPhase = "custom-blocks"

                if (detectedPhase && !entry.emittedPhases.has(detectedPhase)) {
                  entry.currentPhase = detectedPhase
                  entry.emittedPhases.add(detectedPhase)
                  stallToolCalls = 0
                  lastPhaseChangeAt = Date.now()
                  stallWarningEmitted = false
                  const phaseInfo = activePhases.find(p => p.id === detectedPhase)!
                  if (!phaseInfo) continue // phase not in current mode
                  emitEvent(streamId, { type: "phase", phase: detectedPhase, activeLabel: phaseInfo.activeLabel, doneLabel: phaseInfo.doneLabel })
                }

                // Diminishing returns warning — many tool calls without phase progress
                if (!stallWarningEmitted && stallToolCalls >= STALL_TOOL_THRESHOLD && Date.now() - lastPhaseChangeAt >= STALL_THRESHOLD_MS) {
                  stallWarningEmitted = true
                  const elapsedMin = ((Date.now() - lastPhaseChangeAt) / 60_000).toFixed(1)
                  console.warn(`[sites-agent] Stream ${streamId}: STALL DETECTED — ${stallToolCalls} tool calls without phase progress in ${elapsedMin}m`)
                  emitEvent(streamId, { type: "warning", code: "stall_detected", message: `Agent has made ${stallToolCalls} tool calls without phase progress in ${elapsedMin}m` })
                }
              }
              emitEvent(streamId, event as Record<string, unknown>)
            }

            // Check for final result
            if (message.type === "result") {
              const isSuccess = message.subtype === "success"
              const usage = message.usage
              console.log(`[sites-agent] Stream ${streamId}: result subtype=${message.subtype} turns=${isSuccess ? message.num_turns : "?"} cost=$${message.total_cost_usd?.toFixed(4) ?? "?"}`)
              console.log(`[sites-agent] Stream ${streamId}: USAGE in=${usage.input_tokens} out=${usage.output_tokens} cache_read=${usage.cache_read_input_tokens} cache_create=${usage.cache_creation_input_tokens}`)
              if (isSuccess && message.permission_denials?.length > 0) {
                console.log(`[sites-agent] Stream ${streamId}: permission denials:`, message.permission_denials)
              }
              const resultText = isSuccess ? message.result : summaryText
              const { summary: cleanSummary, suggestions } = parseSuggestionsFromSummary(cleanAgentSummary(resultText))
              const modelBreakdown = message.modelUsage
                ? Object.fromEntries(
                    Object.entries(message.modelUsage).map(([model, u]) => [
                      model, { inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.costUSD },
                    ])
                  )
                : undefined
              const budgetHit = message.subtype === "error_max_budget_usd"
              emitEvent(streamId, {
                type: "final",
                result: {
                  status: isSuccess ? "applied" : "error",
                  summary: budgetHit
                    ? `Migration stopped — cost ceiling of $${maxBudgetUsd} reached. ${cleanSummary || ""}`
                    : cleanSummary || (isSuccess ? "Migration completed" : "Migration failed"),
                  suggestions,
                  toolCallCount,
                  sitesCreated: entry.siteCreatedConfigs,
                  usage: {
                    inputTokens: usage.input_tokens,
                    outputTokens: usage.output_tokens,
                    cacheReadInputTokens: usage.cache_read_input_tokens,
                    cacheCreationInputTokens: usage.cache_creation_input_tokens,
                    totalCostUsd: message.total_cost_usd,
                    numTurns: message.num_turns,
                    modelBreakdown,
                  },
                },
              })

              // Persist telemetry
              pushMigrationTelemetry({
                timestamp: new Date().toISOString(),
                streamId,
                status: isSuccess ? "success" : "error",
                durationMs: Date.now() - startedAt,
                numTurns: message.num_turns ?? 0,
                toolCallCount,
                toolsUsed,
                toolDetails,
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
                cacheReadInputTokens: usage.cache_read_input_tokens,
                cacheCreationInputTokens: usage.cache_creation_input_tokens,
                totalCostUsd: message.total_cost_usd ?? 0,
                modelBreakdown,
                sitesCreated: entry.siteCreatedConfigs.map((c: Record<string, unknown>) => String(c.id ?? "")),
                userMessage: body.message?.slice(0, 200),
                debugDir: resolve(homedir(), ".data/migration-debug"),
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
  | { type: "tool_use"; toolName: string; agentType?: string }
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
          const input = "input" in tu ? tu.input as Record<string, unknown> : undefined
          // Log tool name + key parameters for debugging
          const paramSummary = input ? summarizeToolInput(name, input) : ""
          console.log(`${prefix}${ctx} tool_use: ${name}${paramSummary}`)
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

/** Extract key parameters from tool input for concise logging. */
function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "mcp__sites-agent__create_site":
      return ` (name=${input.name}, siteId=${input.siteId ?? "auto"}, port=${input.port ?? "auto"})`
    case "mcp__sites-agent__bootstrap_pages": {
      const pages = Array.isArray(input.pages) ? input.pages : []
      const totalBlocks = pages.reduce((sum: number, p: Record<string, unknown>) => sum + (Array.isArray(p.blocks) ? p.blocks.length : 0), 0)
      const slugs = pages.map((p: Record<string, unknown>) => p.slug).join(", ")
      return ` (siteId=${input.siteId}, pages=${pages.length} [${slugs}], blocks=${totalBlocks})`
    }
    case "mcp__sites-agent__scrape_url":
      return ` (url=${input.url})`
    case "mcp__sites-agent__discover_site_structure":
      return ` (url=${input.url})`
    case "mcp__sites-agent__download_remote_image":
      return ` (siteId=${input.siteId}, url=${String(input.url ?? "").slice(0, 80)})`
    case "mcp__sites-agent__download_remote_images": {
      const imgs = Array.isArray(input.images) ? input.images : []
      return ` (siteId=${input.siteId}, count=${imgs.length})`
    }
    case "mcp__sites-agent__apply_theme": {
      const vars = input.variables && typeof input.variables === "object" ? Object.keys(input.variables) : []
      return ` (siteId=${input.siteId}, vars=${vars.length})`
    }
    case "mcp__sites-agent__generate_page_specs":
      return ` (url=${input.url})`
    case "mcp__sites-agent__list_sites":
      return ""
    case "Agent": {
      const prompt = typeof input.prompt === "string" ? input.prompt.slice(0, 80) : ""
      return ` (${prompt}${prompt.length >= 80 ? "..." : ""})`
    }
    default:
      return ""
  }
}

/** Strip agent thinking/narration from the final summary, keeping only the structured output. */
function cleanAgentSummary(text: string): string {
  // Fix headings missing preceding newlines (e.g. "integrate.## Integration Complete")
  let cleaned = text.replace(/([^\n])(#{1,6}\s)/g, "$1\n\n$2")

  // If there's a structured heading, take from there (skip agent narration before it)
  const headingMatch = cleaned.match(/\n*(## .+)/)
  if (headingMatch?.index !== undefined) {
    cleaned = cleaned.slice(headingMatch.index).trim()
  }

  // Strip remaining agent narration and internal noise lines
  cleaned = cleaned
    .split("\n")
    .filter(line => !/^(?:Now I|Let me|Good[,.]|I'll |I have|Great[,.]|I need to|OK[,.])/i.test(line.trim()))
    .filter(line => !/Background (?:fetch|task) .* completed/i.test(line))
    .join("\n")

  return cleaned.trim()
}

/** Show last 2 path segments for readable context (e.g. "pricing-table/schema.ts") */
function shortPath(fullPath: string): string {
  const parts = fullPath.split("/").filter(Boolean)
  return parts.length > 1 ? parts.slice(-2).join("/") : parts[parts.length - 1] ?? fullPath
}

/** Derive a descriptive label from tool name + input. */
export function describeToolUse(toolName: string, input?: Record<string, unknown>): string {
  // MCP tools — use static label map
  if (TOOL_LABELS[toolName]) return TOOL_LABELS[toolName]

  // Built-in tools — extract context from input
  const filePath = typeof input?.file_path === "string" ? shortPath(input.file_path) : null
  const command = typeof input?.command === "string" ? input.command : null

  switch (toolName) {
    case "Bash": {
      if (!command) return "Running command"
      if (/pnpm\s+install/i.test(command)) return "Installing dependencies"
      if (/typecheck/i.test(command)) return "Type-checking"
      if (/pnpm\s+test/i.test(command)) return "Running tests"
      if (/mkdir/i.test(command)) return "Creating directory"
      const buildMatch = command.match(/pnpm\s+(?:--filter\s+\S*?\/(\S+)\s+)?build/)
      if (buildMatch) return buildMatch[1] ? `Building ${buildMatch[1]}` : "Building"
      if (/rm\s+-rf.*\.next/i.test(command)) return "Clearing build cache"
      if (/grep\s+.*register/i.test(command)) return "Verifying block registration"
      if (/grep\s/i.test(command)) return "Verifying files"
      // Strip project root prefix, cd preamble, then truncate
      const cleaned = command
        .replace(/^(?:cd\s+\S+\s*&&\s*)?/, "")
        .replace(/\/Users\/\w+\/Projects\/[^/]+\/?/g, "")
        .slice(0, 60)
        .trim()
      return `${cleaned}${command.length > 60 ? "..." : ""}`
    }
    case "Write":
      return filePath ? `Writing ${filePath}` : "Writing file"
    case "Read":
      return filePath ? `Reading ${filePath}` : "Reading file"
    case "Edit":
      return filePath ? `Editing ${filePath}` : "Editing file"
    case "Glob":
      return "Searching files"
    case "Grep": {
      const pattern = typeof input?.pattern === "string" ? input.pattern : null
      return pattern ? `Searching for "${pattern.slice(0, 30)}"` : "Searching code"
    }
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
            events.push({ type: "tool_use", toolName, agentType })
          } else if (!SILENT_TOOLS.has(toolName)) {
            const prefix = isSubagent ? "[sub] " : ""
            const label = describeToolUse(toolName, input)
            events.push({ type: "status", message: `${prefix}${label}...` })
            events.push({ type: "tool_use", toolName })
          }
        }
      }

      return events
    }

    case "system": {
      // system:init is internal — don't surface to UI (pulsing dot is enough)
      return []
    }

    default:
      return []
  }
}
