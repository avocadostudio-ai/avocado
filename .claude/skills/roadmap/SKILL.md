---
name: roadmap
description: Regenerate the strategic product roadmap for Avocado Studio at /Users/yury/Projects/avocado-planning/planning/roadmap.md. Scans competitor notes, planner-issue log, user memory, current product state (README), and existing idea docs; produces a structured missing-features doc with an opinionated Top-3 prioritization. Use when the user asks for a roadmap refresh, before a planning / prioritization cycle, after a manual testing session that revealed new gaps, or when competitor landscape shifts.
---

# /roadmap — strategic roadmap regenerator

Owns one file: `/Users/yury/Projects/avocado-planning/planning/roadmap.md`.

That file is the **product-strategist view**: gaps that cap growth, credibility, or scale. It is not a task list. Engineering refactors belong in `planning/backlog.md`; editor-polish items belong in `planning/post-mvp-improvements.md`; launch logistics belong in `planning/hn-launch.md` / `planning/public-launch-channels.md`. Do not duplicate scope across these files.

## Required output structure

Keep this stable across runs so `git diff planning/roadmap.md` is meaningful.

1. **Header** — `**Last updated:** <today>` + regeneration note + scope sentence
2. **Top 3 priorities (opinionated)** — an argument, not a summary. Each is a gap that would meaningfully change the product's ceiling
3. **Numbered gap sections**, in this canonical order (add/remove only when a category genuinely empties or a new one earns its place):
   1. Cold start / onboarding
   2. Collaboration & versioning
   3. Content fidelity (structural)
   4. Editor UX completeness
   5. Planner quality on the hard class
   6. Enterprise / operational readiness
   7. SDK gaps for integrators
   8. MCP ergonomics
4. **Source map** — the paths the roadmap draws from, so the next run knows where to look
5. **Revision history** — dated bullets at the bottom, newest first. Each run appends one line summarizing what changed since the previous run

Every gap row or bullet contains: **what's missing**, **evidence** (where the gap shows up — trace, manual-test session, CMS integration, etc.), and a **Ref** (path into `memory/`, `ideas/*.md`, or `apps/**/*.ts`). No claim without a citation.

## Run steps

1. **Ensure planning repo is present and up-to-date:**
   ```
   ls /Users/yury/Projects/avocado-planning || (cd /Users/yury/Projects && gh repo clone yu7321/avocado-planning)
   git -C /Users/yury/Projects/avocado-planning pull --rebase
   ```
2. **Gather inputs in parallel** (use separate Read / Bash calls in one message):
   - `~/.claude/projects/-Users-yury-Projects-ai-site-editor/memory/MEMORY.md` — start here; it's the index
   - Every memory file that looks roadmap-relevant — competitor analysis, planner quality, CMS learnings, migration gaps, SDK learnings, deferred ideas, UX refactors, agent ergonomics
   - `/Users/yury/Projects/ai-site-editor/README.md` — "Key Features" section tells you what already ships (anything claimed here is not "missing" unless you have contrary evidence)
   - `ls /Users/yury/Projects/avocado-planning/ideas/` and `ls /Users/yury/Projects/avocado-planning/planning/` — to cross-reference and avoid duplication
   - `git -C /Users/yury/Projects/ai-site-editor log --since="30 days ago" --oneline` — recently-shipped features worth removing from prior roadmap
   - Optional: `apps/orchestrator/src/routes/`, `apps/orchestrator/src/publish/targets/`, `packages/blocks/src/blocks/` if you need to verify a claim
3. **Verify before restating** — memory can be stale. If a claim names a function, flag, or file, confirm it still exists. Prefer dated phrasing ("as of <date>") over bare present-tense claims.
4. **Draft the file** — use the last revision's structure, update content, append to revision history.
5. **Show the user** — run `git -C /Users/yury/Projects/avocado-planning diff planning/roadmap.md` and summarize what changed (added category, new top-3, removed shipped items, etc.).
6. **Ask once** before commit/push: _"Commit and push to yu7321/avocado-planning?"_ — only proceed on explicit yes. Use the standard HEREDOC commit message with the trailer.

## Anti-drift rules

- **No uncited claims.** Every gap has a Ref.
- **Don't restate what ships.** If README's "Key Features" says it's there, omit — unless memory says the implementation is partial (common; e.g. snapshots exist in SQLite but no UI surface).
- **Don't bleed into adjacent files.** Engineering refactors → `backlog.md`. Editor polish → `post-mvp-improvements.md`. Launch timing/channels → `hn-launch.md` / `public-launch-channels.md`.
- **Top 3 stays ruthless.** If two items tie for third, pick one; mention the other inside its category.
- **Revision history is honest.** "No material change" is an acceptable entry when the regeneration surfaces nothing new — don't manufacture movement to seem productive.
- **Style:** short rows, evidence-first, sentences not paragraphs, no marketing voice, no emoji unless the user asks.

## First run (bootstrap)

Already done on 2026-04-23 — that run established the canonical category order and the initial Top-3. Subsequent runs should treat that file as the template, not rewrite it from scratch.
