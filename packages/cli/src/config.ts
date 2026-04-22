import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export type AvcConfig = {
  orchestrator: string
  session: string
  siteId?: string
  publishToken?: string
  siteOrigin?: string
}

export type ConfigOptions = {
  orchestrator?: string
  session?: string
  site?: string
  token?: string
  siteOrigin?: string
  cwd?: string
}

/**
 * Minimal `.env.local` parser — handles comments, blank lines, and quoted
 * values. Does NOT handle escaped quotes or multi-line values; fine for the
 * shape of the files `avocado-register` writes. Exported for testing.
 */
export function parseEnvFile(content: string): Record<string, string> {
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

function readEnvLocal(cwd: string): Record<string, string> {
  const path = join(cwd, ".env.local")
  if (!existsSync(path)) return {}
  try {
    return parseEnvFile(readFileSync(path, "utf-8"))
  } catch {
    return {}
  }
}

/**
 * Resolve config from (in precedence order): CLI flags → process.env →
 * .env.local in cwd → defaults. No global config file yet; add when someone
 * asks.
 */
export function resolveConfig(opts: ConfigOptions = {}): AvcConfig {
  const cwd = opts.cwd ?? process.cwd()
  const env = readEnvLocal(cwd)
  const pickEnv = (key: string): string | undefined =>
    process.env[key] ?? env[key]

  const orchestrator = (
    opts.orchestrator ??
    pickEnv("ORCHESTRATOR_URL") ??
    "http://localhost:4200"
  ).replace(/\/+$/, "")

  const session = opts.session ?? pickEnv("AVC_SESSION") ?? "dev"

  const siteId =
    opts.site ??
    pickEnv("AVC_SITE_ID") ??
    pickEnv("NEXT_PUBLIC_DEFAULT_SITE_ID")

  const publishToken = opts.token ?? pickEnv("PUBLISH_TOKEN")

  const siteOrigin =
    opts.siteOrigin ??
    pickEnv("SITE_ORIGIN") ??
    pickEnv("NEXT_PUBLIC_SITE_ORIGIN")

  return { orchestrator, session, siteId, publishToken, siteOrigin }
}
