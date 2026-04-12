#!/usr/bin/env node
/**
 * `avocado-register` — register a Next.js site with an Avocado Studio
 * orchestrator without going through the editor UI.
 *
 * Designed to be the final step of the "bring your own coding agent" path:
 * after Codex / Claude Code / Cursor / etc. has wired the @ai-site-editor/site-sdk
 * into the user's Next.js project, this CLI is what makes the site appear in
 * the editor's dashboard.
 *
 * What it does:
 *   1. Parses CLI args.
 *   2. Reads `.env.local` in the target project, looks for an existing
 *      DRAFT_MODE_SECRET. If missing, generates a cryptographically random
 *      secret (32 random bytes, hex-encoded) and writes it to `.env.local`.
 *      Also fills in ORCHESTRATOR_URL and the NEXT_PUBLIC_* vars if absent.
 *   3. POSTs the site config to `<ORCHESTRATOR_URL>/sites/register`.
 *   4. Prints next steps (and any warnings the orchestrator returned about
 *      secret mismatches with the editor's build-time config).
 *
 * Usage:
 *   npx @ai-site-editor/site-sdk register --name "My Site"
 *   npx @ai-site-editor/site-sdk register --id my-site --name "My Site" --port 3000
 *   npx @ai-site-editor/site-sdk register --help
 *
 * Defaults:
 *   --id            kebab-case of --name (or the project's package.json `name`)
 *   --port          parsed from `scripts.dev` in package.json, falls back to 3000
 *   --orchestrator  $ORCHESTRATOR_URL or http://localhost:4200
 *   --session       dev
 *   --cwd           process.cwd()
 */

import { randomBytes } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

type Args = {
  id?: string
  name?: string
  port?: number
  orchestrator?: string
  secret?: string
  session?: string
  cwd?: string
  purpose?: string
  previewUrl?: string
  help?: boolean
}

function parseArgs(argv: string[]): Args {
  const out: Args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case "--id":            out.id = next(); break
      case "--name":          out.name = next(); break
      case "--port":          out.port = Number(next()); break
      case "--orchestrator":
      case "--orchestrator-url": out.orchestrator = next(); break
      case "--secret":        out.secret = next(); break
      case "--session":       out.session = next(); break
      case "--cwd":           out.cwd = next(); break
      case "--purpose":       out.purpose = next(); break
      case "--preview-url":   out.previewUrl = next(); break
      case "-h":
      case "--help":          out.help = true; break
      default:
        if (a.startsWith("--")) {
          process.stderr.write(`Unknown flag: ${a}\n`)
          process.exit(2)
        }
    }
  }
  return out
}

function printHelp() {
  process.stdout.write(`
avocado-register — register a Next.js site with an Avocado Studio orchestrator

USAGE
  npx @ai-site-editor/site-sdk register [options]

REQUIRED
  --name <string>           Human-readable site name (or read from package.json name)

OPTIONAL
  --id <kebab-case>         Site ID (default: kebab-case of name or package.json name)
  --port <number>           Dev server port (default: parsed from package.json scripts.dev, or 3000)
  --orchestrator <url>      Orchestrator URL (default: $ORCHESTRATOR_URL or http://localhost:4200)
  --secret <string>         DRAFT_MODE_SECRET (default: read from .env.local, or generate random)
  --session <string>        Orchestrator session (default: dev)
  --purpose <string>        One-line site description for AI context
  --preview-url <url>       Preview URL (default: http://localhost:<port>)
  --cwd <path>              Project directory (default: current working directory)
  -h, --help                Show this help

EXAMPLES
  # Register the site in the current directory, auto-detect everything
  npx @ai-site-editor/site-sdk register --name "Marketing Site"

  # Register a site with explicit values
  npx @ai-site-editor/site-sdk register \\
    --id marketing-site \\
    --name "Marketing Site" \\
    --port 3000 \\
    --orchestrator http://localhost:4200

NEXT STEPS
  After running this command, refresh the editor at http://localhost:4100
  and the site will appear in the dashboard.
`)
}

function kebabCase(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .toLowerCase()
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

function readPackageJson(cwd: string): { name?: string; scripts?: Record<string, string> } | null {
  const path = join(cwd, "package.json")
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf-8"))
  } catch {
    return null
  }
}

function detectPortFromPackageJson(pkg: { scripts?: Record<string, string> } | null): number | null {
  const dev = pkg?.scripts?.dev
  if (!dev) return null
  // Look for `-p <port>` or `--port <port>` or `--port=<port>`
  const m = dev.match(/(?:-p|--port)[\s=](\d+)/)
  if (m) return Number(m[1])
  return null
}

function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    const k = trimmed.slice(0, eq).trim()
    let v = trimmed.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    out[k] = v
  }
  return out
}

/**
 * Append-only env merge: read the file as raw text, append `KEY=value` lines
 * for any keys not already present, and write back. Preserves the user's
 * original formatting (comments, key order, blank lines, hand-tuned values).
 *
 * The previous round-trip approach (parse → merge → serialize) silently
 * dropped comments and reordered keys, which is real data loss for users
 * with hand-curated `.env.local` files.
 */
function mergeEnvFile(
  envPath: string,
  existing: Record<string, string>,
  additions: Record<string, string>
): string[] {
  const added: string[] = []
  const newLines: string[] = []
  for (const [k, v] of Object.entries(additions)) {
    if (existing[k] === undefined) {
      newLines.push(`${k}=${v}`)
      added.push(k)
    }
  }
  if (newLines.length === 0) return added

  let original = ""
  if (existsSync(envPath)) {
    original = readFileSync(envPath, "utf-8")
    if (original.length > 0 && !original.endsWith("\n")) original += "\n"
  }
  writeFileSync(envPath, original + newLines.join("\n") + "\n", "utf-8")
  return added
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { printHelp(); return }

  const cwd = resolve(args.cwd ?? process.cwd())
  const pkg = readPackageJson(cwd)

  // Resolve name
  const name = args.name ?? (pkg?.name ? humanize(pkg.name) : null)
  if (!name) {
    process.stderr.write("Error: --name is required (or run from a directory with a package.json that has a `name` field).\n")
    process.exit(1)
  }

  // Resolve siteId
  const siteId = args.id ?? kebabCase(pkg?.name ?? name)
  if (!siteId) {
    process.stderr.write("Error: could not derive a site ID from --id, --name, or package.json. Pass --id explicitly.\n")
    process.exit(1)
  }

  // Resolve port
  const port = args.port ?? detectPortFromPackageJson(pkg) ?? 3000

  // Resolve orchestrator URL
  const orchestrator = (args.orchestrator ?? process.env.ORCHESTRATOR_URL ?? "http://localhost:4200").replace(/\/+$/, "")

  // Resolve / generate the draft secret
  const envPath = join(cwd, ".env.local")
  const existingEnv = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, "utf-8")) : {}
  let secret = args.secret ?? existingEnv.DRAFT_MODE_SECRET
  let secretGenerated = false
  if (!secret) {
    secret = randomBytes(32).toString("hex")
    secretGenerated = true
  }

  // Append-only merge — only add keys that aren't already present, preserving
  // the user's existing file formatting and comments.
  const added = mergeEnvFile(envPath, existingEnv, {
    ORCHESTRATOR_URL: orchestrator,
    DRAFT_MODE_SECRET: secret,
    NEXT_PUBLIC_DEFAULT_SITE_ID: siteId,
    NEXT_PUBLIC_SITE_NAME: name,
    NEXT_PUBLIC_EDITOR_ORIGIN: "http://localhost:4100",
  })

  // POST to the orchestrator with a 10s timeout — without it, a hung
  // orchestrator (mid-handler stall, not just connection-refused) would freeze
  // the CLI indefinitely with no feedback.
  const previewUrl = args.previewUrl ?? `http://localhost:${port}`
  const ac = new AbortController()
  const timeoutId = setTimeout(() => ac.abort(), 10_000)
  let response: Response
  try {
    response = await fetch(`${orchestrator}/sites/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteId,
        name,
        port,
        previewUrl,
        purpose: args.purpose,
        secret,
        session: args.session ?? "dev",
      }),
      signal: ac.signal,
    })
  } catch (err) {
    const aborted = (err as Error).name === "AbortError"
    process.stderr.write(`\nError: could not reach the orchestrator at ${orchestrator}\n`)
    process.stderr.write(`  ${aborted ? "Request timed out after 10 seconds." : (err as Error).message}\n`)
    process.stderr.write(`\nMake sure the orchestrator is running:\n  pnpm dev:orchestrator\n`)
    process.exit(1)
  } finally {
    clearTimeout(timeoutId)
  }

  if (!response.ok) {
    const text = await response.text()
    process.stderr.write(`\nOrchestrator responded ${response.status}:\n  ${text}\n`)
    process.exit(1)
  }

  const result = (await response.json()) as { warnings?: string[] }

  // Friendly output
  process.stdout.write(`\nRegistered "${name}" with the orchestrator.\n`)
  process.stdout.write(`  Site ID:      ${siteId}\n`)
  process.stdout.write(`  Preview URL:  ${previewUrl}\n`)
  process.stdout.write(`  Orchestrator: ${orchestrator}\n`)
  if (secretGenerated) {
    process.stdout.write(`  Secret:       generated (${secret.slice(0, 8)}…)\n`)
  } else {
    process.stdout.write(`  Secret:       reused from .env.local\n`)
  }
  if (added.length > 0) {
    process.stdout.write(`\n.env.local updated. Added: ${added.join(", ")}\n`)
  } else {
    process.stdout.write(`\n.env.local unchanged (all keys already present).\n`)
  }

  if (Array.isArray(result.warnings) && result.warnings.length > 0) {
    process.stdout.write(`\nWarnings:\n`)
    for (const w of result.warnings) {
      process.stdout.write(`  - ${w}\n`)
    }
  }

  process.stdout.write(`\nNext steps:\n`)
  process.stdout.write(`  1. Start your site:    pnpm dev   (in this directory)\n`)
  process.stdout.write(`  2. Open the editor:    http://localhost:4100\n`)
  process.stdout.write(`  3. The site should appear in the dashboard. If not, refresh the page.\n\n`)
}

function humanize(s: string): string {
  return s
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

main().catch((err) => {
  process.stderr.write(`\nUnexpected error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
