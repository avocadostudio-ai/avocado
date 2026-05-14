# Editor E2E Tests

Playwright tests for the editor preview-bridge and selector flow.

## Prerequisites

The full dev stack must be running (orchestrator :4200, editor :4100, site :3000):

```bash
pnpm dev:start         # via devctl (recommended)
# or
pnpm dev               # all three in parallel
```

## Running

From the repo root:

```bash
pnpm test:e2e:editor
```

Or from this directory:

```bash
pnpm --filter @ai-site-editor/editor test:e2e
```

Override the editor URL if running against a remote stack:

```bash
EDITOR_URL=https://my-editor.example pnpm test:e2e:editor
```

First run installs the Chromium browser binary used by Playwright:

```bash
pnpm exec playwright install chromium
```

## What's covered

- **`editor-selector.spec.ts`** — block selection through the preview iframe:
  - First click on a block highlights it (and only it).
  - Re-clicking the same block on a non-editable area toggles selection OFF.
    This guards the d35f2b4 deselect branch, which silently dropped out of the
    Next.js dev bundle when `.next` cached a stale `preview-adapter` build.
  - Clicking a different block moves selection.
  - Clicking empty canvas clears the selection.
