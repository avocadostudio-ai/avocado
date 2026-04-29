# Avocado Studio

**AI-powered content operations for websites.** Manage site content through natural language — the system plans, validates, and applies structured edits with live preview, undo/redo, and one-click publishing.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

<!-- TODO: Add screenshot or GIF of the split-pane Content Studio UI -->

## Why Avocado Studio?

Teams spend too much time on routine content updates — tweaking copy, adding sections, rearranging blocks. Avocado Studio turns these into simple conversations. Type what you want, review the plan, approve the changes.

Built for **developers** and **agencies** integrating AI editing into client sites, and **site owners** who want to manage content without touching code. Self-hosted, no vendor lock-in, no per-seat pricing.

## Key Features

### AI Content Studio

- **Visual AI workspace** — Split-pane UI with your live site on the left and a chat interface on the right. Describe changes in natural language, see them applied in real time
- **Plan review + approval** — Every change is presented as a reviewable plan before it's applied. Nothing ships without your sign-off
- **Undo/redo** — Full operation history. Roll back any change instantly
- **Streaming UX** — Progressive updates as the AI generates the plan, not a loading spinner followed by a wall of changes
- **AI image handling** — Generate images with DALL-E, search Unsplash, or browse Google Drive — all from within the content studio

### Multi-Model AI

- **Anthropic, OpenAI, Google Gemini** — Choose your AI provider per request. Switch models without changing code. While all three providers are supported, the system is most battle-tested with Anthropic models (Haiku, Sonnet, and Opus)
- **Tiered model selection** — Fast models for simple edits, reasoning models for complex restructuring

### Blocks & Type Safety

- **20 built-in block types** — Production-ready content blocks that cover the most common website patterns: Hero banners, CTAs, FAQ accordions, Testimonials, Feature grids, Image galleries, Stats counters, Carousels, Data tables, Tabbed content, Video embeds, and more. Each block has a typed schema, responsive rendering, and AI-ready field metadata so the planner knows exactly what it can edit
- **Custom blocks** — Register your own React components alongside built-in blocks. The AI planner automatically picks up their schemas and can operate on them like any built-in block
- **Zod-validated operations** — Every edit operation is type-checked at runtime. Malformed edits are rejected before they touch your content

### Integration & Deployment

- **Site SDK** — Add AI editing to any Next.js 15+ site with a few API routes
- **CMS integrations** — Working examples for Sanity, Strapi, and Contentful
- **Publishing pipeline** — Pluggable publish targets. Ships with Git + Vercel deploy hook support out of the box; implement the `PublishTarget` interface to connect your own deployment workflow
- **i18n** — Multi-language Content Studio UI and AI responses (currently English and German; extensible)
- **Self-hosted** — Run the entire stack on your own infrastructure

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

### Environment

`pnpm dev:setup` copies `.env.example` to `.env` and walks you through the required + common-optional keys. You need **at least one** LLM provider:

- `ANTHROPIC_API_KEY` — for Claude models (recommended, best-tested)
- `OPENAI_API_KEY` — for OpenAI models (also powers `gpt-image-1` image generation)

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

[MIT](LICENSE)
