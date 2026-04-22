#!/usr/bin/env node
// Dev-only bin wrapper. The published binary points at dist/index.js
// (set in publishConfig); this wrapper only exists so the in-monorepo
// experience (`pnpm exec avc`, `pnpm link`) runs the TS source directly.
// Spawning tsx from the package-local install keeps this working without
// requiring a build step on every edit and without assuming tsx is
// resolvable from the caller's CWD.
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const entry = resolve(here, "../src/index.ts")
const tsxBin = resolve(here, "../node_modules/.bin/tsx")

if (!existsSync(tsxBin)) {
  process.stderr.write(
    "avc (dev): tsx is not installed in packages/cli/node_modules.\n" +
      "Run `pnpm install` at the monorepo root, or `pnpm --filter @ai-site-editor/cli build` and use dist/index.js.\n",
  )
  process.exit(1)
}

const child = spawn(tsxBin, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
})

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
