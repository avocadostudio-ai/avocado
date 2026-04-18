# Semver Discipline & Package Stability Tiers (Deferred)

## Context

All packages in this monorepo are currently at `0.0.1` or `0.0.2`. There's no public signal about which packages are stable, which are experimental, which are internal-only. For a closed-source project this is fine — the only consumer is us. For OSS, it's a problem:

- A contributor opens a PR against `@ai-site-editor/editor-puck` (which is marked `private: true` but has no README explaining that). We have to write a rejection message from scratch.
- An integrator builds on top of `@ai-site-editor/migration-sdk` expecting API stability. We change the signature in the next release. They're upset.
- Nobody knows whether a `shared` schema tweak is a breaking change worth a major bump, because we don't have a major version yet.

This doc is the plan for defining stability tiers and semver conventions. It's pre-launch work, but not day-one blocking — we can ship OSS with all packages at `0.x` as long as the README is honest ("this project is pre-1.0; APIs may change"). The formal tier system can land in the first post-launch cleanup.

---

## Proposed stability tiers

Three tiers, each marked explicitly in `package.json` and in a root `STABILITY.md`.

### Tier 1 — Stable (approaching v1.0)

The public contract. Breaking changes require a major version bump and a migration guide.

- `@ai-site-editor/shared` — Zod schemas, types, operation contract
- `@ai-site-editor/blocks` — block renderers + catalogue
- `@ai-site-editor/preview-adapter` — postMessage bridge
- `@ai-site-editor/site-sdk` — Next.js integration SDK

Signal: version `1.0.0-rc.x` → `1.0.0` once we commit. Until then, `0.x.y` with a STABILITY.md note that we're intentionally holding.

### Tier 2 — Experimental (pre-1.0, API may change)

Works today, but we might rename, restructure, or deprecate without major-bump warning. Use at your own risk.

- `@ai-site-editor/editor-puck`
- `@ai-site-editor/immersive-widget`
- `@ai-site-editor/migration-sdk`
- `@ai-site-editor/create-ai-site-editor`

Signal: `private: true` stays, OR version stays at `0.x.y` with a big README warning at the top.

### Tier 3 — Internal

Not intended for external consumption at all. Part of the monorepo for convenience.

- Anything in `apps/` that isn't the `site-sdk` or a declared product entry point.

Signal: `private: true` in `package.json`, never published.

---

## Mechanics

### `STABILITY.md` at repo root

Lists every package, its tier, and what "stable" means for that tier. Linked from the main README.

### JSDoc markers on public APIs

- `@experimental` — "this will probably change, don't build on it yet"
- `@deprecated` — "use X instead; will be removed in version Y"
- `@internal` — "exported for mono-repo convenience, not part of the public contract"

Already partially in use in `site-urls.ts` and `errors.ts`. Extend consistently across all Tier-1 packages.

### Changelog discipline

`CHANGELOG.md` per package, hand-written. No auto-generation from commits (too noisy). Every release lists: added, changed, deprecated, removed, fixed. Keep-a-changelog format.

### Pre-1.0 policy (until we cut 1.0)

- `0.x.y` → `0.(x+1).0` for any breaking change in a Tier-1 package, with the break called out at the top of the changelog.
- Patch bumps for pure bug fixes / internal refactors.
- This is honest about instability while giving a migration signal.

### 1.0 criteria (when to cut it)

- Three months without breaking changes to Tier-1 packages.
- Published API documented in `docs-site/`.
- At least one external production integration (not villa-puravida) using `site-sdk`.
- No `@experimental` markers on exports marked as Tier 1.

---

## What to decide before landing

- Publish registry: npm public vs GitHub Packages. Currently `publishConfig.registry` points at `npm.pkg.github.com` in some packages. For OSS discoverability, npm public is standard. Decide per package (e.g. `site-sdk` on public npm, internal helpers on GH Packages).
- Whether to use a single version across the monorepo (Lerna-style fixed) or per-package versions (Lerna-style independent). Recommendation: per-package — `shared` moves slower than `blocks`, and forcing lockstep would noise up the changelog.
- Whether to ship a `packages/*/STABILITY.md` per package or one root file. Root file is easier to keep consistent; per-package makes it more discoverable from npm.

## Effort

~0.5–1 day to write `STABILITY.md`, add `@experimental`/`@deprecated` markers, add a README "Stability" section to each package, update `publishConfig.registry` consistently.

## Trigger to do this

Before the first public announcement. Can be tightened later (e.g. cut 1.0), but the tier definitions and README warnings should exist the day the repo is made public. Otherwise contributors make assumptions we can't walk back.
