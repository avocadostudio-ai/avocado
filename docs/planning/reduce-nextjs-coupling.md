# Reducing Next.js Coupling in Current Product State

## Status

Proposed recommendation document for current architecture and onboarding strategy.

## Problem Summary

Today, our fastest onboarding path is tightly shaped around Next.js conventions:

- Next Draft Mode enable/disable flow.
- App Router route handlers and file layout.
- Fixed endpoint assumptions in docs/templates (`/api/draft`, `/api/editor/blocks`, `/api/editor/pages`).

This is good for MVP velocity, but it creates friction for teams on Remix, Nuxt, SvelteKit, Astro, custom Node stacks, or existing CMS frontends.

## Product Recommendation

Use a two-tier integration model:

1. Keep **Next.js Embedded Onboarding** as the default path (fastest for current target users).
2. Add a **Framework-Agnostic Site Adapter Contract** as the stable core.
3. Position an AEM-like provider/SPI as an advanced enterprise mode, not the default onboarding requirement.

This avoids over-engineering for early adopters while still giving a credible path to multi-framework and enterprise integrations.

## Target Audience Fit

### Tier 1: Fast adopters (current core audience)

- Small teams, startups, product engineers.
- Need working editor integration in hours, not weeks.
- Prefer template-based setup and minimal backend work.

Best served by current Next.js onboarding.

### Tier 2: Platform/enterprise teams

- Existing CMS or platform APIs, governance, caching, deployment workflows.
- Require stronger auth, compatibility guarantees, observability, and long-lived contracts.

Best served by a formal provider/SPI surface.

## What Is Actually Next.js-Specific Today

1. Draft Mode cookie/session behavior and API (`/api/draft`, `/api/draft/disable`).
2. App Router route handler style (`app/api/**/route.ts`, `NextResponse`).
3. Template file/folder conventions and imports.
4. Draft-vs-published switching wired through Next request/render pipeline.

## What Is Already Framework-Agnostic

1. Manifest concept and schema (`component type + props schema + editable paths`).
2. Page data model (`PageDoc`, `BlockInstance`).
3. Bootstrap concept (seed editor/orchestrator draft state from published pages).
4. Orchestrator and editor core behavior (operations, planning, session semantics).

## Required Changes to Reduce Coupling

### 1) Introduce a Canonical Site Adapter Contract

Define a framework-neutral capability contract:

- `getManifest`
- `getPages`
- `enablePreview`
- `disablePreview`
- `getPage` (draft/published-aware)

Specify shared request/response and error envelope conventions, independent of route naming.

### 2) Add a Preview Session Protocol

Standardize preview lifecycle regardless of framework:

- activation/deactivation semantics
- required context fields (`session`, `siteId`, optional route context)
- secure redirect constraints
- token/cookie expectations

Next Draft Mode becomes one implementation, not the product contract itself.

### 3) Decouple Editor from Hardcoded Next Endpoints

Editor should use capability discovery/config, not fixed URLs:

- keep endpoint locations in site integration config, or
- support a discovery endpoint returning capability URLs.

### 4) Move Shared Validation/Helpers into an SDK Package

Create a small package (example: `@ai-site-editor/site-adapter-sdk`) for:

- manifest/page schema validation
- preview URL + context parsing helpers
- safe redirect validation
- shared error utilities

Adapters (Next/Remix/etc.) call this SDK.

### 5) Define Adapter Contract Tests

Add a reusable test suite that every adapter must pass:

- manifest validity
- bootstrap success/failure behavior
- preview enable/disable
- draft/published switching
- error envelope compliance

### 6) Keep Provider SPI as Advanced Mode

Keep AEM-inspired SPI, but position it as:

- optional advanced integration
- recommended for enterprise CMS/platform teams
- not required for quickstart onboarding

## Phased Rollout Plan

### Phase 0: Documentation clarity (immediate)

- Split docs into:
  - Core framework-agnostic contract (new)
  - Next.js adapter guide (existing path)
  - Enterprise provider SPI guide (advanced)
- Explicitly state “default vs advanced” path selection criteria.

### Phase 1: Internal abstraction (short term)

- Add adapter capability interfaces inside editor/orchestrator integration boundary.
- Stop assuming fixed Next route names in code paths where feasible.

### Phase 2: SDK + tests (short term)

- Publish internal SDK utilities.
- Add contract tests and run against current Next adapter.

### Phase 3: Second adapter proof (mid term)

- Build one non-Next reference adapter (Remix or Express-based).
- Use findings to remove hidden Next assumptions.

### Phase 4: Enterprise SPI alignment (mid term)

- Map adapter capabilities to provider SPI semantics.
- Add concurrency/versioning and error contract hardening for enterprise mode.

## Risks and Tradeoffs

### Benefits

- Keeps current onboarding speed for existing users.
- Opens product to additional frameworks without rewriting core editor/orchestrator.
- Creates cleaner enterprise narrative (quickstart path + advanced path).

### Costs

- Additional abstraction and testing surface area.
- Temporary dual-path documentation burden.
- Need ongoing compatibility management between adapters and SPI mode.

## Non-Goals (for now)

- Replacing Next.js onboarding as default immediately.
- Forcing all adopters onto enterprise SPI endpoints.
- Building adapters for every framework at once.

## Success Criteria

1. New integration docs clearly separate core contract from Next-specific implementation.
2. Editor can be configured with non-Next capability endpoints without code changes.
3. One non-Next adapter passes shared contract tests.
4. Next.js onboarding remains backward compatible.
5. Enterprise SPI is documented as optional advanced mode with explicit audience fit.
