/**
 * export-openapi.ts
 *
 * Imports the orchestrator's Fastify app, waits for all route plugins to
 * register, then dumps the @fastify/swagger-generated OpenAPI 3.0 spec to
 * `docs-site/api-reference/orchestrator.openapi.json` for Mintlify to consume.
 *
 * Run:
 *   pnpm --filter @ai-site-editor/orchestrator export-openapi
 *
 * Most orchestrator routes don't have Fastify schemas attached, so the spec is
 * a skeleton. See the `orchestrator_openapi_improvements` memory for the
 * deferred plan to upgrade with real Zod schemas via fastify-type-provider-zod.
 */

// NODE_ENV=test must be set BEFORE this script imports anything, otherwise
// the orchestrator's index.ts will try to call startServer() and bind to port
// 4200. The package.json `export-openapi` script sets it at the shell level
// (`NODE_ENV=test tsx ...`) — setting it inside this script would be too late
// because ESM imports are hoisted above any preceding statements.
if (process.env.NODE_ENV !== "test") {
  process.stderr.write(
    `\nexport-openapi must be run with NODE_ENV=test set in the environment.\n` +
    `Use:  pnpm --filter @ai-site-editor/orchestrator export-openapi\n\n`
  )
  process.exit(1)
}

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { app } from "../index.js"
import { monorepoRoot } from "../agent/sites-agent-shared.js"

const OUTPUT_PATH = join(monorepoRoot(), "docs-site/api-reference/orchestrator.openapi.json")

async function main() {
  await app.ready()
  const spec = app.swagger()

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true })
  writeFileSync(OUTPUT_PATH, JSON.stringify(spec, null, 2) + "\n", "utf-8")

  const operationCount = Object.values(spec.paths ?? {}).reduce((acc: number, methods: unknown) => {
    if (typeof methods !== "object" || methods === null) return acc
    return acc + Object.keys(methods).length
  }, 0)

  process.stdout.write(`\nExported OpenAPI spec to:\n  ${OUTPUT_PATH}\n`)
  process.stdout.write(`  Operations: ${operationCount}\n`)
  process.stdout.write(`  Tags:       ${(spec.tags ?? []).map((t: { name: string }) => t.name).join(", ")}\n\n`)

  // Force exit — the imported app holds open timers/handles.
  process.exit(0)
}

main().catch((err) => {
  process.stderr.write(`\nFailed to export OpenAPI spec: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
