# Integration Docs (Start Here)

Use this page as the entry point for connecting the AI Site Editor to your website.

## Who is this for?

- **Site owners** who want to add chat-driven AI editing to an existing website.
- **Frontend developers** integrating the editor into a Next.js (or other framework) project.
- **Platform teams** evaluating the editor for enterprise CMS integration.

## Prerequisites

- A running Next.js site (App Router recommended, Pages Router also supported)
- Node.js >= 20 and pnpm >= 9
- The AI Site Editor monorepo cloned and running locally (see [root README](../../README.md))
- An OpenAI or Anthropic API key (optional — deterministic demo mode works without one)

## Integration tiers

| Tier | Audience | Effort | Doc |
|---|---|---|---|
| **Next.js Embedded** (default) | Startups, product teams on Next.js | ~30 min | [nextjs-mvp-embedded.md](nextjs-mvp-embedded.md) |
| **Framework-Agnostic SPI** | Teams on Remix, Nuxt, SvelteKit, custom stacks | ~1–2 days | [site-provider-spi.md](../../docs/site-provider-spi.md) |
| **Custom tools** | Teams needing PIM, DAM, or other tool integrations | Variable | [tools-mvp.md](tools-mvp.md) |

## Related planning

- [`docs/planning/reduce-nextjs-coupling-plan.md`](../planning/reduce-nextjs-coupling-plan.md) — how we reduce framework coupling while keeping Next.js onboarding as default.
- [`docs/site-provider-spi.md`](../site-provider-spi.md) — advanced provider/SPI mode for enterprise-style integrations.
- [`docs/integration/tools-mvp.md`](tools-mvp.md) — Anthropic-first native tool contract, runtime policy, and adopter onboarding.

## Recommended reading order

1. `docs/integration/nextjs-mvp-embedded.md`
2. `docs/integration/editor-quickstart.md`
3. `docs/integration/nextjs-mvp-adoption-example.md`
4. `docs/integration/templates/nextjs-embedded/README.md`

## MVP integration model

- Source of truth: adopter-owned component registry in code.
- Transport contract: `GET /api/editor/components` manifest JSON generated from that registry.
- Preview bootstrap: Next.js Draft Mode (`/api/draft`, `/api/draft/disable`).
- Fallback behavior: if manifest is missing/invalid, editor runs in degraded mode (no structural edits).

## Required endpoints

- `GET /api/editor/components` — component manifest for structural edits
- `GET /api/editor/bootstrap-pages` — returns `{ pages: PageDoc[] }` of published content; the editor calls this to seed the orchestrator with initial draft content when a session has no pages yet
- `GET /api/draft?secret=...&redirect=...` — enables Next.js draft mode and redirects
- `GET /api/draft/disable?redirect=...` — disables draft mode and redirects

## Required environment variables

- Site:
  - `DRAFT_MODE_SECRET`
- Editor:
  - `VITE_SITE_ORIGIN`
  - `VITE_SITE_DRAFT_SECRET`

## Adoption checklist

1. Add local component registry in site code.
2. Generate manifest from registry and expose `/api/editor/components`.
3. Add draft mode routes and secret validation.
4. Verify CORS for editor origin on `/api/editor/components` in local/dev.
5. Confirm editor header shows `Manifest` (not `Degraded`).

## Quick validation script

Run:

```bash
./docs/integration/scripts/check-manifest.sh http://localhost:3000
```

Expected:
- prints `PASS: version=..., components=...`
