# Open-Core Strategy: orchestrator-core + orchestrator-brain

**Status:** Draft — paused for later pickup. Nothing implemented yet.

This document captures a strategy conversation about moving the project from "fully MIT open source" to an **open-core model**: an Apache 2.0 runtime/content engine (`orchestrator-core`) plus a source-available AI orchestration layer (`orchestrator-brain`) offered as a managed service. It records the planned split, positioning, audience, and cleanup work so we can resume without re-deriving the reasoning.

---

## 1. Why move off fully MIT

Today the entire monorepo is MIT and the README explicitly advertises *"Self-hosted, no vendor lock-in, no per-seat pricing."* This is a monetization trap:

- Anyone can fork and run the exact same thing as a competing hosted service.
- Relicensing gets harder the moment external contributors land code in the moat files (`apps/orchestrator/src/chat`, `agent`, `ops`).
- There is no legal structure separating the adoption surface (runtime) from the revenue surface (AI orchestration).

**Sole-author status today is confirmed** — relicensing the closed parts is clean, no CLA dance required.

The proposed model: **open-core + hosted control plane + self-hostable runtime via Docker.** This is a validated playbook (GitLab, Sentry, PostHog, n8n, Supabase, HashiCorp, Temporal, Replicate).

---

## 2. The open/closed split

The seam already exists in the codebase — we just haven't drawn the line yet.

### Open (Apache 2.0) — `orchestrator-core` + runtime packages

| Package / directory | Reason |
|---|---|
| `packages/site-sdk` | Adoption vector. Already shipping to villa-puravida-web via `file:` deps — **must stay Apache 2.0 permanently**. |
| `packages/blocks` | Block renderers + catalogue. The ecosystem depends on this being open. |
| `packages/shared` | Zod schemas, types, slug/id utilities. The contract everyone agrees on. |
| `packages/preview-adapter` | PostMessage bridge. Already open; stays open. |
| `packages/editor-puck` | Puck integration. Primary visual editing surface (see §5). |
| `apps/site` | Next.js runtime renderer. No CMS dependency at request time. |
| `apps/editor` | The Content Studio UI — open, but dumb client without brain. |
| `apps/orchestrator/src/ops/` | Ops engine — atomic applier, all op semantics. See §4 for the detailed split. |
| `apps/orchestrator/src/state/` | `ContentSource` interface + `in-memory-content-source.ts` + session lock/state. |
| `apps/orchestrator/src/publish/` | `PublishTarget` interface + Git/Vercel impl. |
| `apps/orchestrator/src/routes/` subset: `content.ts`, `ops.ts`, `history.ts`, `publishing.ts`, `media.ts` (local uploads only) | The thin HTTP surface. |
| `packages/create-ai-site-editor`, `packages/migration-sdk` (non-AI parts) | Onboarding + migration tooling. |

### Closed (FSL — Functional Source License) — `orchestrator-brain`

| Directory | Reason |
|---|---|
| `apps/orchestrator/src/chat/` — **all of it** | `prompts.ts`, `planner.ts`, `plan-json-schema.ts`, `decomposer.ts`, `anthropic-planner.ts`, `gemini-planner.ts`, `provider-routing.ts`, `anthropic-cache.ts`, `variation-pipeline.ts`, `chat-pipeline*.ts`. This is the real moat — the streaming pipeline, pacing, rollback, deferred images. |
| `apps/orchestrator/src/agent/` | Sites-agent tools, agent loop, integration prompts. |
| `apps/orchestrator/src/nlp/` | Intent detection, plan normalization. (A few pure slug/id helpers move to `shared` — see §4.) |
| `apps/orchestrator/src/image/`, `variation-images.ts` | Unsplash, DALL-E, image variation, alt-text generation. |
| `apps/orchestrator/src/integration/`, `jira/`, `routes/gdrive.ts`, `routes/jira.ts` | External-system integrations. |
| `apps/orchestrator/src/routes/chat.ts`, `agent.ts`, `sites-agent.ts` | AI-mode HTTP routes — brain owns its own streaming routes. |
| Multi-tenant `ContentSource` impls (Postgres, Redis, S3 — none exist today) | Reserved for brain when multi-tenancy ships. |
| `isDeterministicRepairEligible`, `buildDeterministicRepairFeedback` (from `ops-engine.ts`) | Planner retry strategy — brain-specific. |

### Licensing recommendation

- **Open parts: Apache 2.0** (not MIT — we want the patent grant).
- **Closed parts: FSL (Functional Source License)** — source-available, forbids competing hosted service, auto-converts to Apache 2.0 after 2 years. Simpler and less spooky to enterprise than SSPL/AGPL. BSL 1.1 is the alternative with a 4-year window.

### Scope reality check

~95% of the code stays Apache 2.0. Only ~5% (chat, agent, parts of nlp, image, integrations) becomes FSL. This is much easier to message than we first thought: *"the runtime and content engine are Apache 2.0; the AI planning pipeline is source-available."*

---

## 3. What `orchestrator-core` lets you DO

Think of core as **"the Content Studio without the chat box"** — plus a typed API.

### In the Content Studio UI (no AI, no API keys)

**Visual editing — Puck Mode is the primary surface**
- Drag-and-drop page building on the rendered preview
- Typed blocks + typed fields auto-derived from Zod/manifest schemas
- Add, remove, move, nest, duplicate blocks
- Inline text editing, field inspector for props
- List-block authoring (FAQ rows, testimonials, gallery items) — add/remove/reorder
- Local image upload

**Page management**
- Create, rename, duplicate, delete pages
- Reorder pages in nav
- Edit page meta (title, description, OG tags)

**Site-wide**
- Edit site config (name, logo, nav labels, nav groups)
- Full undo/redo
- Operation history
- Draft preview
- One-click publish via Git + Vercel hook (or any custom `PublishTarget` impl)

### Via HTTP API (headless / scripted)

- `POST /sites/:id/ops` — apply any of the typed op types
- `GET /sites/:id/pages` — read page state
- `POST /sites/:id/publish` — trigger publish
- `GET /blocks/schemas` — introspect available blocks + their schemas
- `GET /history` — operation history + undo/redo

### Via BYO planner

- Configure `PLANNER_URL=https://...` (or register an in-process `Planner` implementation)
- Chat Mode becomes functional again, powered by **your** LLM and **your** prompts
- Core validates returned ops and applies them
- Same editor UX — plan preview, approval, undo — works unchanged
- **This is the "no lock-in" proof**: point `PLANNER_URL` at your own service and keep the same editor UI

### Dev loop for custom blocks

- Write a React component + Zod schema
- Register in the block catalogue
- Core immediately renders, validates, exposes in picker, auto-generates edit form
- Test end-to-end without AI
- Brain picks up the new block automatically via schema introspection

### What's blocked without brain

- Natural-language chat editing
- AI-generated multi-step plans from one prompt
- Streaming UX (ops appearing as the LLM types)
- Image generation (DALL-E), Unsplash search, Google Drive picker
- AI-assisted migrations
- Variation pipeline
- Sites Agent (autonomous multi-step site building)
- Intent routing / tiered model selection
- Multi-tenant sessions, team features
- Jira / external tool integrations

---

## 4. `ops-engine.ts` split — simpler than first thought

Initial hypothesis was that `apps/orchestrator/src/ops/ops-engine.ts` (932 lines) needed internal surgery — 200-300 lines to core, the rest to brain.

**That was wrong.** After reading it, the file is already a pure transactional applier. The "sophisticated streaming pipeline" I was worried about lives in `chat/chat-pipeline.ts`, not here. `ops-engine.ts` is ~95% core material.

### Goes to `orchestrator-core`

| Function | Line | Why core |
|---|---|---|
| `validateOperations` | 383 | Zod contract validation — the standard every planner produces against. |
| `applyOpsAtomically` + `_applyOpsAtomicallyUnsafe` | 398, 407 | Atomic apply loop — lock, stage, mutate, write-back. Pure data transformation. |
| Per-op switch (add_block, remove_block, move_block, create_page, duplicate_page, rename_page, update_props, update_page_meta, update_site_config, update_item, add_item, etc.) | 444–864 | Op semantics are the shared contract. Closing them would fork the ecosystem. |
| `_validateWithManifestIfPresent`, `_requireManifestComponent`, `_allowedPatchKeysFromManifest`, `_withValidatedBlockProps` | 310–368 | Custom block validation — essential for the ecosystem story. |
| `_resolveBlockIndex` (fuzzy fallback: strip_copy_suffix, type_prefix) | 239 | Defensive repair heuristic. Useful to any planner. |
| Route link rewriting (`remapRouteReference`, `rewriteRouteLinksInValue`, `rewriteLinksToRenamedPage`) | 52–127 | Pure utility for `rename_page`. |
| `isStructuralOperation`, `pickFocusBlockId`, `pickUpdatedSlug` | 206, 898, 919 | Predicates + editor-UX helpers. Open editor needs these. |
| `formatValidationError`, `classifyGuardrailError`, `isNoEffectiveChangeError`, `toErrorDetail` | 129–174 | Error taxonomy. Shared vocabulary. |

### Goes to `orchestrator-brain` (~20 lines out of 932)

| Function | Line | Why brain |
|---|---|---|
| `isDeterministicRepairEligible` | 178 | Encodes which errors a planner should retry on — planner strategy. |
| `buildDeterministicRepairFeedback` | 182 | Builds feedback strings fed back into the LLM retry loop. |

These two move to `chat/planner-repair.ts` (or similar) next to where the retry loop lives.

### Refactor prerequisite

`ops-engine.ts` imports from `../nlp/`:

```ts
import { normalizeRouteCandidate } from "../nlp/intent-helpers.js"
import { pageIdFromSlug, pageTitleFromSlug } from "../nlp/plan-normalizer.js"
```

Core can't depend on `nlp/` (which becomes brain). These three pure helpers need to move to `packages/shared/src/route-utils.ts`. Trivial move, no logic change.

---

## 5. Puck Mode — the primary visual editor

### Decision

**Puck Mode is the only visual block editor in core.** No home-grown Zod-form editor for block props. This kills the internal duplication and gives us a real WYSIWYG experience for free.

### Three editing surfaces, one content model

| Surface | Who it's for | Packaged with |
|---|---|---|
| **Puck Mode** | Designers, marketers, non-technical authors | core (Apache 2.0) |
| **HTTP Ops API** | CI/CD, scripts, migrations, BYO tooling | core (Apache 2.0) |
| **Chat Mode** | Anyone editing via natural language | brain (FSL + managed) |

**All three produce the same `Operation[]` against the same block schemas.** That symmetry is the architectural moat — most CMSes have one editing surface; headless ones have one API. Avocado has three, coequal.

### What stays as Zod-generated forms

Forms survive ONLY for non-block content:
- Page meta (title, description, OG tags)
- Site config (name, logo, nav labels, nav groups)
- Anything else that isn't a block and doesn't fit Puck's model

These are ~5 small forms, not an editor.

---

## 6. Differentiation from Puck itself

### The worry

If we ship Puck as core's visual editor, why would anyone use core instead of just dropping Puck into their own Next.js app? This needs an obvious answer, because skeptical devs will ask it.

### The Monaco / VS Code analogy

**Puck is to core what Monaco is to VS Code.** Monaco is a code editor component — brilliant, focused, used by millions. VS Code is an IDE that embeds Monaco and adds everything around it. Nobody confuses them. Nobody asks "why use VS Code when Monaco exists?"

Same structure:
- **Puck** is a visual page-building *library*
- **Avocado Core** is a content *platform* that embeds Puck as its visual editing surface

### What core adds on top of Puck

| Capability | Puck alone | Avocado Core |
|---|---|---|
| Visual page building | Yes | Yes (via Puck) |
| Block library included | No — BYO | Yes — 20 production blocks in `packages/blocks` |
| Multi-page / multi-route site | No — single page | Yes — pages, nav, SEO, site config |
| Typed Operation log | No — opaque JSON mutation | Yes — `Operation[]` validated, replayable, undoable |
| HTTP Ops API | No — front-end only | Yes — scriptable, CI/CD-ready |
| Content source abstraction | No | Yes — `ContentSource` interface |
| Draft / preview pipeline | No | Yes |
| Publish target abstraction | No | Yes — `PublishTarget` + Git/Vercel |
| Next.js runtime rendering | No — you build it | Yes — via `site-sdk`, zero CMS dependency at request time |
| Schema ↔ renderer guarantee | No — config and components drift | Yes — one Zod schema drives both Puck fields AND runtime rendering |
| AI editing surface | No | Yes — Chat Mode (with brain) on same Operation contract |
| Custom block dev loop | Partial — config side only | Yes — end-to-end: schema, render, preview, AI-ready |

**If a dev tried to recreate core from Puck alone, they'd be building a CMS.** That's exactly the framing.

### Messaging posture

- **Name Puck prominently.** *"Core embeds Puck — the best open-source typed React page builder — and adds the CMS, block library, publishing, and AI layer around it."* Hiding the dependency looks shifty; naming it looks confident.
- **Docs include a "Puck vs Avocado Core" section** — not as rivals but as "what Puck gives you / what core adds on top." Think Vercel's framing of their relationship to Next.js.
- **Contribute back** to Puck. If our integration surfaces bugs or missing features, upstream them. Turn Measured into allies, not competitors.
- **Pin a Puck version + test against upgrades.** We're now downstream of someone else's roadmap. A Puck breaking change is a core incident.
- **Never fork quietly.** If we ever need to fork Puck, do it openly and stay in sync.

Puck is a **trust signal**, not a liability. Mature dev teams read "we chose the best existing tool and built a platform around it" as a sign of taste.

---

## 7. Positioning

### Architectural layers (what we're positioning around)

Core has five clean layers, each with a pluggable interface:

| Layer | Interface / location |
|---|---|
| Content model | Zod schemas in `packages/shared` |
| Renderers | `packages/blocks` (React) |
| Authoring surfaces | Produce `Operation[]` against the content model |
| Content source (edit-time state) | `ContentSource` interface |
| Publish target | `PublishTarget` interface |

### Tagline (locked)

> **"One typed content model. Three editing surfaces. Your infrastructure."**

### Sub-header

> **"Typed blocks. Puck-native visual editing. Git-native publishing. Your Next.js app, unchanged."**

### Hero paragraph (draft)

> Avocado Core is a new kind of headless CMS: one where your content model IS your component library, and your CMS runs alongside (not inside) your Next.js app.
>
> Traditional headless CMSes (Sanity, Contentful, Strapi, Payload) give you generic fields and leave rendering to you — you write the schema in one place and the React components in another, and spend the rest of your life keeping them in sync. Avocado Core collapses that gap. Blocks are typed React components with Zod schemas, visual-editor metadata, and publish-ready rendering — shipped as one unit in `packages/blocks`, or authored as your own in any repo that imports `@ai-site-editor/site-sdk`.
>
> On top of that single content model, Core gives you three interchangeable editing surfaces — Puck Mode (drag-and-drop visual), Ops API (typed HTTP for CI/CD and scripts), and Chat Mode (natural-language editing via the AI layer). All three produce the same typed operations against the same block schemas.
>
> Publishing is git-native: every change becomes a reviewable commit via a pluggable `PublishTarget` interface (Git + Vercel ships built-in). Deployment is yours — self-hosted, Apache 2.0, zero per-seat pricing.
>
> **Avocado Core is the CMS part of Avocado Studio.** When you're ready for AI-native editing, Avocado Brain snaps in as a managed service or a licensed runtime. Not before then.

### Taglines that were rejected and why

- **"Your React components are your content schema. Your git repo is your database. Your Next.js app is your CMS."** — Punchy but architecturally imprecise. Components ≠ schemas (schemas are framework-agnostic). Git is the publish target, not the runtime store. Next.js is the renderer, not the CMS. A sharp dev will catch the imprecision and lose trust.

---

## 8. Audience

Narrowed from 7 personas to 2 primary + 1 secondary.

### Primary — everything is built for these two

**1. Next.js developer teams at product startups / scaleups (10–200 people)**
- Default today to Sanity (loved but schema↔render gap is painful) or Contentful (hate the pricing).
- Pain: *"I defined the field in Sanity Studio, wrote the React component, changed the field, and my renderer is broken and nobody noticed for two sprints."*
- What Core sells: typed blocks where schema and renderer can't drift, visual editing via Puck, self-host, own your git. **AI is a later upgrade, not the pitch.**
- Discovery: GitHub, dev blogs, "self-hosted Sanity alternative" searches, colleague recommendation.

**2. Next.js agencies building client sites (2–30 people)**
- Today they use WordPress (because clients can edit it) or Webflow (visual) and hate both. Or Sanity, accepting that clients will never learn Sanity Studio.
- Pain: *"I need a visual editor my client can actually use, on a modern stack I actually want to maintain."*
- What Core sells: Puck Mode for client handoff, git-native publishing for dev workflow, Next.js-native for speed + SEO. **AI is a future upsell** for client retainers.
- Discovery: Twitter/X dev community, agency Slack groups, case studies.

### Secondary — uses core but doesn't decide for it

**3. CI/CD / marketing-ops engineers** — They inherit the CMS and write scripts against the Ops API. Become internal champions because the typed HTTP API is dramatically nicer than Contentful's Management API or Sanity's mutations. Write docs + code samples for them.

### NOT the audience (say it in docs)

- Enterprise content teams with hundreds of editors + RBAC → Contentful Enterprise
- Blog-first authors → Substack, Ghost, WordPress.com
- E-commerce catalog management → Shopify, Medusa
- Non-Next.js frameworks (today — Remix/Astro later maybe)
- Designers who want Framer/Webflow for animation/interaction

### The core → brain funnel (the whole strategy)

The audience for brain is a **strict superset** of the audience for core. Same people, same repos, same blocks — just turned on the AI layer.

```
Persona 1 (startup dev team)             Persona 2 (agency)
        │                                      │
        ▼                                      ▼
  Discovers Core on GitHub           Builds 2-3 client sites on Core
  ("finally a typed Sanity")         ("Puck + git is perfect for handoff")
        │                                      │
        ▼                                      ▼
  Ships production site             Client asks for "AI editing"
  in their repo                     or dev wants faster iteration
        │                                      │
        └────────────────┬─────────────────────┘
                         ▼
                  Plugs in Brain
             (cloud first, self-host later)
                         │
                         ▼
               Pays for hosted AI tier
               OR licenses FSL runtime
```

**One product pitch (core) + one upgrade pitch (add brain).** Not two separate marketing stories.

---

## 9. The `Planner` seam

Core exposes a single interface in `orchestrator-core/src/planner/planner.ts`:

```ts
export interface Planner {
  plan(input: PlanRequest): Promise<PlanResponse>
}

export type PlanRequest = {
  message: string
  sessionId: string
  pageDoc: PageDoc
  siteConfig: SiteConfig
  blockManifest?: BlockManifest
  locale?: string
}

export type PlanResponse = {
  ops: Operation[]
  summary?: string
  skipped?: SkippedOperation[]
}
```

- Core ships one built-in impl: `HttpPlanner` that POSTs to `PLANNER_URL`.
- If no planner is configured, `POST /chat` returns `501 Not Implemented` with a link to docs ("install brain, or configure your own planner").
- Brain implements this same interface with the full streaming pipeline behind it.
- **Streaming is a brain feature, not a core feature.** Core's `/chat` is synchronous `plan → apply → respond`. Brain's `/chat` is `plan-stream → apply-stream → SSE`. Different routes, different files, clean split.

### Formalization decision

Ship a **loose** contract first (Phase 2): `PLANNER_URL` env var, JSON-in/JSON-out. Defer the formal `Planner` interface + certified-planner program until actual third-party planners emerge.

---

## 10. Package boundary (the mental model)

```
@ai-site-editor/shared              (Apache 2.0) — types, Zod schemas, slug/id utils
@ai-site-editor/blocks              (Apache 2.0) — block renderers + catalogue
@ai-site-editor/preview-adapter     (Apache 2.0) — postMessage bridge
@ai-site-editor/site-sdk            (Apache 2.0) — Next.js integration helpers
@ai-site-editor/editor-puck         (Apache 2.0) — Puck integration
@ai-site-editor/orchestrator-core   (Apache 2.0)
  ├── ops/          — ops-engine (minus 2 feedback helpers)
  ├── state/        — session-state, session-lock, in-memory-content-source
  ├── publish/      — PublishTarget interface + git-vercel impl
  ├── routes/       — content, ops, history, publishing, media (local only)
  └── planner/      — Planner interface + HTTP pass-through to PLANNER_URL
@ai-site-editor/orchestrator-brain  (FSL)
  ├── chat/         — planner, prompts, pipeline, pacing, rollback, streaming
  ├── agent/        — agent loop, sites-agent tools, integration prompts
  ├── nlp/          — intent detection, plan normalizer (minus moved utils)
  ├── image/        — Unsplash, DALL-E, variations
  ├── integrations/ — jira, gdrive
  ├── routes/       — chat.ts, agent.ts, sites-agent.ts
  ├── state-mt/     — multi-tenant ContentSource impls (Postgres, S3)
  └── planner-repair (isDeterministicRepairEligible, buildDeterministicRepairFeedback)
```

---

## 11. Editor duplication audit

`apps/editor` currently ships **two parallel editing routes**, both lazy-loaded from `App.tsx`.

| Route | Entry point | Visual editing | Status |
|---|---|---|---|
| `/` (classic) | `App.tsx` → `PropertyPanel.tsx` (997 lines) | Home-grown field inspector with tabs `chat / properties / history` | **The duplication** |
| `/editor/puck` | `PuckPrototypeRoute.tsx` (82-line host shim) → `editor-puck` → `createPuckConfig.tsx` + `PuckDispatchBridge` | Full Puck visual editor | The good one |

Both routes share: `ChatComposerCore`, `ImagePickerModal`, `VersionHistoryPanel`, `useChatEngine`, `usePublish`. The only thing that differs is block-level editing — and that's precisely where Puck beats the home-grown panel.

### The specific duplication

**`apps/editor/src/components/PropertyPanel.tsx` — 997 lines — is the file that should die.** It:
- Imports `deriveFieldMetaFromSchema` from `@ai-site-editor/shared` and hand-renders text, richtext, image, and list-field editors from Zod schemas
- Wires per-field debounced commits via `useDebouncedCommit`
- Renders AI-assist quick actions (the wand button) per field via `fieldAiQuickActions`
- Also handles page-level stuff: nav labels, SEO meta (title, description, ogImage)

Puck Mode already covers **all the block-level rendering** in `editor-puck/src/components/puck/createPuckConfig.tsx`, derived from the same schemas — strictly better.

### What PropertyPanel does that Puck doesn't (migrate, don't delete)

| Feature | Where it should go |
|---|---|
| Per-field AI assist buttons (wand next to text fields, opens a rewrite prompt) | Custom Puck field wrapper — same pattern as existing `PuckImageFieldControl.tsx`. Create `PuckAiAssistTextControl.tsx` that decorates Puck's text input with the wand button + calls into `useChatEngine`. |
| Field highlight / scroll-on-chat (when chat says "updated hero subtitle" the panel scrolls + flashes that specific field) | Needs a new bridge: extend `setGlobalSelection` in `PuckHostApi` to carry field path, and have Puck programmatically open the right block + scroll its inspector to that field. **Not trivial** — Puck's inspector doesn't expose field-level scroll targets today. |
| Page nav label editing (not a block concept) | New `PageSettingsDrawer.tsx` or Puck root-config panel. ~50 lines. |
| Page SEO meta editing (title, description, ogImage) | Same drawer. |

### Cleanup plan

**Delete (~1,100 lines)**
- `apps/editor/src/components/PropertyPanel.tsx` (997 lines)
- `apps/editor/src/hooks/useBlockProps.ts` (verify only PropertyPanel imports it, then delete)
- The `properties` tab wiring in `App.tsx` (~80 lines around line 1479)
- The `panel-tab` button for `properties` in the tab bar (line 1598)

**Migrate (~150 lines of new glue code)**
- `PuckAiAssistTextControl.tsx` — new custom Puck field wrapper for the wand button
- `PageSettingsDrawer.tsx` — nav labels + SEO meta editing
- Field-path bridge — extend `PuckHostApi.setGlobalSelection` to carry `activeEditablePath` + add `scrollToField` helper in Puck runtime

**Keep as-is**
- `ChatSurface.tsx` / `ChatComposerCore`
- `VersionHistoryPanel.tsx`
- `ImagePickerModal.tsx`
- `SiteConfigDrawer.tsx`

**Unify routes (follow-up)**
Once PropertyPanel is gone, the classic `/` route has no reason to exist. Collapse both routes into one: `PuckPrototypeRoute` becomes the default, `App.tsx` classic route is retired, `main.tsx` renders Puck host directly. Chat sidebar and history panel slide in over Puck as persistent side panels.

### Effort estimate

| Phase | What | Size |
|---|---|---|
| Phase 1 — delete PropertyPanel | Remove PropertyPanel + `properties` tab + `useBlockProps`, verify nothing else imports them | 0.5 day |
| Phase 2 — migrate AI-assist | Build `PuckAiAssistTextControl.tsx`, wire into `createPuckConfig.tsx` | 0.5–1 day |
| Phase 3 — page settings drawer | Build `PageSettingsDrawer.tsx` for nav labels + SEO meta | 0.5 day |
| Phase 4 — field-path bridge | Extend selection protocol so chat updates scroll Puck inspector to the right field | 1–2 days |
| Phase 5 (follow-up) — unify routes | Retire classic App.tsx route, make Puck the default entry point | 0.5–1 day |

**Total: ~3–5 days** to fully eliminate the internal duplication.

### Risk flags

1. **Puck inspector field-path scroll is the unknown.** Phases 1–3 are mechanical; Phase 4 depends on what Puck's component API lets you reach into. If Puck doesn't expose programmatic field scroll, either contribute upstream, fork, or accept graceful degradation ("chat says updated subtitle → block selected, but user scrolls manually"). **Worth a 1-hour spike before committing to the full sequence.**
2. **PropertyPanel may be referenced from tests or storybook.** Quick grep showed only `App.tsx` imports it. Clean.
3. **Field AI assist depends on `fieldAiQuickActions` lib** — migrate alongside the UI wrapper; don't leave it orphaned.

---

## 12. Phased rollout plan

**Phase 1 — Draw the line (1–2 weeks, do first)**
1. Decide the split. Write `LICENSING.md` at repo root.
2. Rewrite `README.md` to drop *"no vendor lock-in"* and replace with *"open-core: runtime is Apache 2.0, orchestration is source-available (FSL) and offered as a managed service."*
3. Split `apps/orchestrator` into `orchestrator-core` (open, thin apply/publish) and `orchestrator-brain` (closed, FSL) inside the same monorepo. No repo split yet.
4. Move `prompts.ts`, `planner.ts`, `decomposer.ts`, `agent-loop.ts`, and the 2 feedback helpers from `ops-engine.ts` under `orchestrator-brain/`. Add FSL headers.
5. Move `normalizeRouteCandidate`, `pageIdFromSlug`, `pageTitleFromSlug` from `nlp/` to `packages/shared/src/route-utils.ts`.

**Phase 2 — Make self-host honest (2–3 weeks)**
6. Define the HTTP seam: `POST /plan` (message → ops), `POST /apply` (ops → new PageDoc). Core implements `/apply`; brain implements `/plan`.
7. Publish `orchestrator-core` Docker image (Apache 2.0). Works without a brain.
8. Publish `orchestrator-brain` Docker image (FSL) with license-key check on startup. Free dev tier, paid production.
9. Update `docker-compose.yml` to make the split visible.
10. Run editor duplication cleanup (Phases 1–3 of §11 — ~2 days).

**Phase 3 — Position the SaaS (ongoing)**
11. Rename hosted offering. "Avocado Studio Cloud" = brain + multi-tenant session state + integrations + team features. Frame brain as *"AI control plane for content operations"* — not as a missing piece.
12. Keep these features cloud-only: multi-model routing, multi-tenant sessions, session-review/observability dashboards, Jira integration, Google Drive image picker, usage telemetry.

### Effort: Phase 1

**~2–3 days of mechanical work.** No algorithm changes, no behavior changes. Just file moves + import updates + one new `Planner` interface + `LICENSING.md` + README rewrite.

---

## 13. Pitfalls to avoid

1. **"Fake open source" backlash.** Don't let the open version be broken or useless standalone. Core must be *actually usable* — the whole "editor works with no API key via Puck Mode + manual edits" story depends on this.
2. **Docker ≠ air-gapped.** Be explicit in docs: brain calls Anthropic/OpenAI/Gemini. *"Self-hosted runtime, hosted inference"* — say it out loud so enterprise security reviews don't bounce us.
3. **Prompt files are small and copyable.** Even source-available, `prompts.ts` is maybe 1k lines someone could rewrite in a weekend. The real moat isn't the text — it's the pipeline (decomposer → streaming apply → deterministic rollback → variation pipeline → image deferral). Close the **pipeline**, not just the strings.
4. **`site-sdk` is already shipping to villa-puravida-web via `file:` deps.** Must stay Apache 2.0 permanently — we'd break our own customer otherwise.
5. **Version drift.** Self-hosted Docker users won't update and will blame us for broken behavior. Need strict versioning + compatibility guarantees + upgrade path from day one.
6. **Accidental commoditization.** If too much logic leaks into the open repo, competitors replicate faster than expected. Audit the line periodically.

---

## 14. Open questions to resolve before starting

- [ ] Run a **1-hour spike** on Puck's inspector API: can we programmatically scroll to a specific field path? Outcome decides whether Phase 4 of the editor cleanup is in or out.
- [ ] Confirm `useBlockProps` hook is only referenced by `PropertyPanel.tsx` (quick grep before deletion).
- [ ] Decide FSL vs BSL 1.1 for the closed parts. FSL is simpler and has a 2-year conversion window; BSL is more established (HashiCorp, Sentry) with a 4-year window. Leaning FSL.
- [ ] Decide whether the brain repo lives in-monorepo forever or eventually splits to a private repo. Recommendation: keep in-monorepo until there's an external contributor in the open parts who shouldn't see brain.
- [ ] Draft `LICENSING.md` + README rewrite (paused — pick up here).

---

## 15. When we resume

**Start with:** the Puck inspector field-path spike (1 hour). It's the only unknown blocking the cleanup scope.

**Then:** draft `LICENSING.md` + README rewrite together. The split is mechanical once the story is written down.

**Finally:** execute Phase 1 of the rollout plan. ~2–3 days of file moves. Ship before any public launch push.
