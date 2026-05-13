# Avocado Studio

**AI-powered content operations for websites.** Manage site content through natural language — the system plans, validates, and applies structured edits with live preview, undo/redo, and one-click publishing.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

<p align="center">
  <video src="https://github.com/avocadostudio-ai/avocado/releases/download/assets-demo-v2.2/Demo_v2.2.mp4" controls muted playsinline width="900"></video>
</p>

## Why Avocado Studio?

Teams spend too much time on routine content updates — tweaking copy, adding sections, rearranging blocks. Avocado Studio turns these into simple conversations. Type what you want, review the plan, approve the changes.

Built for **developers** and **agencies** integrating AI editing into client sites, and **site owners** who want to manage content without touching code. Self-hosted, no vendor lock-in, no per-seat pricing.

**Try it locally in 30 seconds** (Node 22+, one LLM API key):

```bash
git clone https://github.com/avocadostudio-ai/avocado.git && cd avocado
./start
```

Opens the Content Studio at `http://localhost:4100`. Full prerequisites, environment variables, and CMS examples are in [Quick Start](#quick-start) below.

## Key Features

### Works with any LLM

- **Anthropic, OpenAI, and Google Gemini** — pick the planner per request, per environment, or per model tier. No vendor lock-in; the same prompts and operations run unchanged across providers. Anthropic Claude (Haiku / Sonnet / Opus) is the most battle-tested.
- **Tiered model routing** — fast models for intent detection, balanced for routine edits, reasoning models for restructuring. Override per provider via `OPENAI_MODEL_*` / `ANTHROPIC_MODEL_*` env vars.
- **Extended thinking** auto-enabled on Anthropic for complex prompts. SSE-streamed `thinking_token` events let the Content Studio render a collapsible "Thinking…" block.
- **Streaming end-to-end** — operations stream back as the LLM produces them, validate against Zod schemas, and apply incrementally. Users see progress at ~800 ms intervals, not a single final dump.
- **MCP server bundled** — drive Avocado Studio from Claude Desktop, Claude Code, Cursor, or any [Model Context Protocol](https://modelcontextprotocol.io/) host. 40 tools cover pages, blocks, media, publishing, history, and the planner itself. Both stdio and streamable-HTTP transports. See [`apps/mcp-server/`](apps/mcp-server/).

### Works with your website stack

- **Next.js 15+** via the [Site SDK](packages/site-sdk/) — drop in a few API routes and your existing site becomes editable. App Router and React Server Components compatible.
- **Any CMS** — JSON files, Contentful, Sanity, and Strapi adapters out of the box (see [`examples/`](examples/)). Implement one interface to wire up your own.
- **Custom React blocks** — register your components alongside the 20 built-ins. The AI planner reads their Zod schemas and edits them like any built-in block.
- **Pluggable publishing** — Git-based snapshots and Vercel deploy hooks ship by default. Implement the `PublishTarget` interface for any other deploy workflow (Netlify, S3, push-to-CMS, etc.).
- **Self-hosted, Apache 2.0-licensed** — run on Render, Vercel, Docker, or your own infra. No per-seat pricing. Optional demo mode for locked-down public playgrounds.
- **Durable sessions** — SQLite-backed state with WAL, transactional writes, capped undo/redo + version log, and rolling backups. No data loss on restart.

### AI Content Studio

- **Visual AI workspace** — split-pane UI with your live site on the left, chat on the right. Describe changes in natural language; watch them apply in real time.
- **Plan review + approval** — every change is presented as a reviewable plan before it's applied. Nothing ships without your sign-off.
- **Undo / redo** — full operation history. Roll back any change instantly.
- **Streaming UX** — progressive op application as the AI generates the plan; no loading spinner followed by a wall of changes.
- **AI image handling** — generate with Gemini or DALL-E, search Unsplash, or browse Google Drive — all from inside the studio.
- **i18n** — Content Studio UI and AI responses support multiple languages (English + German today; adding a locale is a few-line change).

### Blocks & Type Safety

- **20 built-in block types** — Hero banners, CTAs, FAQ accordions, Testimonials, Feature grids, Image galleries, Stats counters, Carousels, Data tables, Tabbed content, Video embeds, and more. Each block ships with a typed schema, responsive rendering, and AI-ready field metadata so the planner knows exactly what it can edit.
- **Zod-validated operations** — every edit is type-checked at runtime. Malformed edits are rejected before they touch your content.
- **Atomic op application** — multi-op plans apply or roll back as a unit. No half-applied state.

## Quick Start

**Prerequisites:** Node.js 22+.

```bash
git clone https://github.com/avocadostudio-ai/avocado.git && cd avocado
./start
```

That's it. `./start` verifies Node, enables corepack, installs deps, prompts for an API key, boots the dev stack, and opens the editor in your browser. Re-running `./start` anytime is safe — it skips steps that are already done.

<details>
<summary><strong>Prefer manual steps?</strong></summary>

```bash
corepack enable          # provides pnpm at the pinned version
pnpm install             # install dependencies
pnpm dev:setup           # copy .env.example → .env, prompt for API key
pnpm dev:start           # start all 3 services (backgrounded)
```

</details>

| Service          | URL                    | Description                                        |
|------------------|------------------------|----------------------------------------------------|
| Site             | http://localhost:3000   | Your website with live preview                     |
| Content Studio   | http://localhost:4100   | AI-powered visual workspace for editing content    |
| Orchestrator     | http://localhost:4200   | Backend API that plans and executes edits          |

Open the **Content Studio** at `http://localhost:4100` to start editing your site through chat.

### What's next: bring in your own site

The site you see at `:3000` is a **demo** — sample content so you can try the editor immediately. When you're ready to use Avocado Studio on a real site, pick one of two paths:

**🤖 Agentic — let our AI do it.** Use the in-editor **Onboarding agent**. Describe your site, paste a public URL, or point at a GitHub repo; it migrates / integrates / scaffolds end-to-end. Fastest path (~5–15 min). → [Onboarding agent docs](https://docs.avocadostudio.dev/sites/site-agent). Or just click the **"✨ Onboard with AI agent"** button on the demo banner inside the editor.

**🔧 Manual — code it yourself.** Wire `@ai-site-editor/site-sdk` into your existing Next.js 15 project by hand (~30 min) or hand the work to your own coding agent (Codex / Claude Code / Cursor). → [Manual integration](https://docs.avocadostudio.dev/sites/manual) · [Bring your own coding agent](https://docs.avocadostudio.dev/sites/coding-agent).

### Environment

`pnpm dev:setup` copies `.env.example` to `.env` and walks you through the required + common-optional keys. You need **at least one** LLM provider:

- `ANTHROPIC_API_KEY` — for Claude models (recommended, best-tested)
- `OPENAI_API_KEY` — for OpenAI models (also powers `gpt-image-2` / `gpt-image-1` image generation)

The script then prompts for these **optional** asset-manager integrations (press Enter to skip any):

- **Image generation** — `GOOGLE_GENAI_API_KEY` for Gemini, or a second-opinion `OPENAI_API_KEY` if you picked Anthropic as the planner (Anthropic does not generate images). Gemini is also required for the conversational image-editing chat.
- **Unsplash stock photos** — `UNSPLASH_ACCESS_KEY` enables the editor's Unsplash asset-picker tab.
- **Google Drive** — `GOOGLE_DRIVE_FOLDER_ID` + `GOOGLE_API_KEY` (or `GOOGLE_SERVICE_ACCOUNT_KEY_JSON` for private folders) enables the Drive asset-picker tab.

**CMS asset libraries** (not prompted by the setup script):

- **Contentful** — set `CONTENTFUL_SPACE_ID` + `CONTENTFUL_DELIVERY_TOKEN` in `.env` to expose a Contentful asset tab in the editor.
- **Sanity / Strapi** — configured per-site via the editor's Site Config drawer (no env vars).

<details>
<summary><strong>Dev server management commands</strong></summary>

```bash
pnpm dev:start    # Start all 3 services (backgrounded)
pnpm dev:stop     # Stop all services
pnpm dev:restart  # Restart all services
pnpm dev:status   # Check if running
pnpm dev:logs     # Tail combined logs
pnpm dev:doctor   # Diagnose port/process issues
```

Or run in the foreground: `pnpm dev`

</details>

## Architecture

pnpm monorepo with 3 apps and 3 packages:

```
apps/
  orchestrator/    Fastify API (:4200) — sessions, AI planning, ops engine, publishing
  editor/          Vite + React (:4100) — AI Content Studio UI, chat, model picker, iframe bridge
  site/            Next.js (:3000) — renders pages from BlockInstance data
packages/
  shared/          Zod schemas (PageDoc, BlockInstance, Operation, EditPlan), block registry
  blocks/          Block renderers (Hero, FeatureGrid, Testimonials, FAQ, CTA, and 15 more)
  preview-adapter/ PreviewBridge component, postMessage protocol, CSS overlay system
```

## Examples

| Example | CMS | Path |
|---------|-----|------|
| Sample Site | JSON files | `examples/sample-site/` |
| Contentful | Contentful CMS | `examples/contentful-site/` |
| Sanity | Sanity + Studio | `examples/sanity-site/` |
| Strapi | Strapi (self-hosted) | `examples/strapi-site/` |

## Documentation

The full documentation site is in [`docs-site/`](docs-site/) (built with [Mintlify](https://mintlify.com)). Run `mintlify dev` from that directory to preview locally.

| Topic | Link |
|-------|------|
| Core concepts | [docs-site/concepts.mdx](docs-site/concepts.mdx) |
| How it works | [docs-site/how-it-works.mdx](docs-site/how-it-works.mdx) |
| Architecture | [docs-site/architecture.mdx](docs-site/architecture.mdx) |
| Integrate into your website | [docs/integration/](docs/integration/README.md) |
| Custom blocks | [docs/integration/custom-blocks.md](docs/integration/custom-blocks.md) |
| Site SDK reference | [packages/site-sdk/](packages/site-sdk/README.md) |
| Deploy the orchestrator with Docker | [docs/operations/docker-deployment.md](docs/operations/docker-deployment.md) |
| Deploy to Vercel | [docs/operations/vercel-deployment.md](docs/operations/vercel-deployment.md) |
| Deploy to Netlify | [docs/operations/netlify-deployment.md](docs/operations/netlify-deployment.md) |
| Dev server runbook | [docs/operations/dev-server-runbook.md](docs/operations/dev-server-runbook.md) |

## Development

```bash
pnpm typecheck    # TypeScript type checking across all workspaces
pnpm test         # Run all tests
pnpm test:unit    # Fast unit tests only (~2s)
pnpm test:e2e     # E2E tests (requires API keys, ~30s)
pnpm build        # Build all workspaces
```

See [CLAUDE.md](CLAUDE.md) for the full command reference and environment variable documentation.

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, coding standards, and PR guidelines.

## License

[Apache 2.0](LICENSE)
