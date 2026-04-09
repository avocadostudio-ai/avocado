# Site Agent Modes

Last updated: 2026-04-03

The site agent supports three modes, determined by Haiku triage of the user's message. Each mode gets an intent-adaptive system prompt that includes only the relevant workflow sections and guidelines, reducing input tokens and TTFT.

## Mode Overview

| Mode | Trigger | Model | System Prompt Sections |
|------|---------|-------|----------------------|
| **create** | "Create a new site", "Build me a portfolio" | Sonnet (balanced) | Block catalog, theme presets, create workflow, GDrive guidelines |
| **migrate** | "Migrate https://example.com", "Clone this site" | Sonnet (balanced) | Block catalog, migration phases 1-5, approval gate, custom block guidelines, text preservation |
| **integrate** | "Add the editor to my Next.js project" | Sonnet (balanced) | Separate integration prompt (clone, analyze, integrate) |
| **question** | "What block types are available?" | Haiku (fast) | Short-circuited — no agent invocation, Haiku answers directly |

## Triage

Every incoming message is first classified by Haiku (`triageWithHaiku` in `sites-agent-shared.ts`). The triage returns:

```typescript
type TriageResult = {
  intent: "create" | "migrate" | "integrate" | "question"
  url?: string        // extracted URL for migrate mode
  answer?: string     // direct answer for question intent
}
```

- **question** intent is short-circuited: Haiku's answer is returned directly as an SSE `final` event. No agent is spawned.
- **create/migrate/integrate** intents spawn the full agent with mode-specific system prompts and tool sets.

## Create Mode

**Goal:** Build a new site from scratch based on user requirements.

**Workflow:**
1. Gather requirements (name, purpose, tone)
2. Pick a theme preset from the curated catalog (8 presets with harmonious palettes)
3. Optionally browse Google Drive for user photos (`browse_gdrive_images`)
4. `create_site` — scaffold Next.js project
5. `bootstrap_pages` — populate pages with blocks and theme overrides
6. Final summary

**Prompt includes:**
- Theme presets catalog (~2,200 tokens) — needed for palette selection
- GDrive image browsing guidelines
- Create workflow steps

**Prompt excludes:**
- Migration phases (discovery, approval gate, block decisions)
- Text preservation rules
- Custom block verification steps
- Nav/logo extraction guidelines

**Tools:** `create_site`, `bootstrap_pages`, `apply_theme`, `browse_gdrive_images`, `download_remote_image(s)`, `list_sites`

## Migrate Mode

**Goal:** Analyze an existing website and recreate it using the block system.

**Workflow:**
1. **Discovery** — delegate to `structure-analyzer` subagent (scrape, screenshot, extract design tokens)
2. **Approval gate** — present migration plan via `AskUserQuestion`, wait for user approval
3. **Block decisions** — map sections to built-in blocks or spawn `block-coder` for custom blocks
4. **Execute** — `create_site` → block-coder → `download_remote_images` → `bootstrap_pages`
5. **Summary** — final markdown report

**Prompt includes:**
- Full 5-phase migration workflow
- Section-to-block mapping reference table
- Custom block triggers (pricing, events, team, timeline)
- Text preservation rules (verbatim copy, no paraphrasing)
- Custom block verification checklist
- Nav/logo/SEO extraction guidelines

**Prompt excludes:**
- Theme presets catalog (migrate extracts design tokens from the source site)
- GDrive image guidelines
- Create workflow

**Tools:** All create tools + `AskUserQuestion`, subagents (`structure-analyzer`, `block-coder`), `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`

## Integrate Mode

**Goal:** Add the site editor SDK to an existing Next.js codebase.

Uses a completely separate system prompt (`buildIntegrationSystemPrompt`).

**Workflow:**
1. `clone_repo` — clone user's repository
2. `analyze_codebase` — detect framework, routes, dependencies
3. `integrate_site` — install SDK, add provider, configure routes
4. `register_site` — register with orchestrator
5. `bootstrap_pages` — optionally populate initial content

**Tools:** `clone_repo`, `analyze_codebase`, `integrate_site`, `register_site`, `bootstrap_pages`, `apply_theme`, `list_sites`, `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`

## Token Savings

Intent-adaptive prompts reduce input tokens by excluding irrelevant sections:

| Mode | Excluded Content | Approx. Savings |
|------|-----------------|-----------------|
| **migrate** | Theme presets catalog | ~2,200 tokens |
| **create** | Migration phases, custom block guidelines, text preservation | ~925 tokens |
| **question** | Everything — no agent spawned | ~4,500 tokens |

## Model Tiers

```typescript
const SITES_AGENT_MODELS = {
  fast: "claude-haiku-4-5-20251001",    // triage, question short-circuit
  balanced: "claude-sonnet-4-6",         // main agent (create, migrate, integrate)
  powerful: "claude-opus-4-6",           // block-coder subagent
}
```

Override via environment variables: `SITES_AGENT_MODEL_FAST`, `SITES_AGENT_MODEL_BALANCED`, `SITES_AGENT_MODEL_POWERFUL`.

## Key Files

| File | Role |
|------|------|
| `apps/orchestrator/src/agent/sites-agent-shared.ts` | Triage, model tiers, theme presets |
| `apps/orchestrator/src/agent/sites-agent-context.ts` | Create/migrate system prompt (intent-adaptive) |
| `apps/orchestrator/src/agent/integration-prompt.ts` | Integrate system prompt |
| `apps/orchestrator/src/agent/sites-agent-tools.ts` | MCP tool definitions |
| `apps/orchestrator/src/routes/sites-agent.ts` | Route handler, SSE streaming, approval bridge |
| `apps/editor/src/hooks/useSitesAgent.ts` | Client-side hook, mode detection, SSE client |
| `apps/editor/src/components/SitesAgentChat.tsx` | Chat UI, approval card, phase tracker |
