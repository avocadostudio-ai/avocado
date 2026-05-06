# Contributing to Avocado Studio

Thanks for your interest in contributing! Avocado Studio is an open-source project and we welcome pull requests of all kinds — bug fixes, new block types, documentation improvements, and feature additions.

## Development Setup

**Prerequisites:** Node.js 22+ and [corepack](https://nodejs.org/api/corepack.html) enabled.

```bash
# 1. Fork and clone the repository
git clone https://github.com/<your-username>/avocado.git
cd avocado

# 2. Enable corepack (provides pnpm at the pinned version)
corepack enable

# 3. Install dependencies
pnpm install

# 4. Set up environment (copies .env.example, prompts for API key)
pnpm dev:setup

# 5. Start all services
pnpm dev:start
```

The Content Studio opens at `http://localhost:4100`, the site at `http://localhost:3000`, and the orchestrator API at `http://localhost:4200`.


See [docs/operations/dev-server-runbook.md](docs/operations/dev-server-runbook.md) for advanced dev server management.

## Project Structure

```
apps/
  orchestrator/    Fastify API — sessions, AI planning, operations engine, publishing
  editor/          Vite + React — AI Content Studio UI, chat, model picker, iframe preview bridge
  site/            Next.js — renders pages from BlockInstance data
packages/
  shared/          Zod schemas (PageDoc, BlockInstance, Operation, EditPlan), block registry
  blocks/          20 built-in block renderers (Hero, CTA, FAQ, Gallery, etc.)
  preview-adapter/ PreviewBridge component, postMessage protocol, CSS overlay
  site-sdk/        SDK for integrating any Next.js site
```

## Making Changes

1. **Branch from `main`** — create a descriptive branch name (`feat/carousel-autoplay`, `fix/undo-crash`)
2. **Write your code** — follow the coding standards below
3. **Run checks before committing:**
   ```bash
   pnpm typecheck      # TypeScript type checking across all workspaces
   pnpm test:unit      # Fast unit tests (~2s)
   pnpm build          # Full build across all workspaces
   ```
4. **Submit a pull request** — describe what changed and why

## Pull Request Guidelines

- One feature or fix per PR
- Include test coverage for new functionality
- Ensure `pnpm typecheck` and `pnpm test:unit` pass
- Write a clear description of _what_ changed and _why_

## Coding Standards

- **TypeScript throughout** — avoid `any` unless absolutely necessary
- **Zod schemas** for all data boundaries (block props, API payloads, operations)
- **Tests** use Node's built-in test runner (`node:test`) with `tsx`. Test files live alongside source as `*.test.ts`
- **i18n** — new user-facing strings in the editor need entries in `apps/editor/src/i18n/en.ts`. TypeScript will flag any missing translation keys at compile time

## Adding a New Block Type

1. Create a directory in `packages/blocks/src/blocks/<your-block>/`
2. Add the block name to `rendererBlockTypes` in `packages/blocks/src/blocks/block-types.ts`
3. Create a renderer component and export it from the block's `index.ts`
4. Define the block's Zod schema in `packages/shared/`
5. Run `pnpm typecheck` to verify everything wires up correctly

See existing blocks (e.g., `packages/blocks/src/blocks/hero/`) for the expected structure.

## Testing

```bash
pnpm test              # All tests across monorepo
pnpm test:unit         # Fast unit tests only (~2s)
pnpm test:e2e          # E2E tests (requires API keys, ~30s)

# Orchestrator-specific test categories
pnpm --filter @ai-site-editor/orchestrator test:chat
pnpm --filter @ai-site-editor/orchestrator test:ops
pnpm --filter @ai-site-editor/orchestrator test:nlp
```

## AI Coding Agents

If you're an AI coding agent working on this codebase:

- See [CLAUDE.md](CLAUDE.md) for Claude Code-specific guidance
- See [docs/integration/ai-coding-agents.md](docs/integration/ai-coding-agents.md) for general agent integration guides

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
