import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const orchestratorUrl = process.env.ORCHESTRATOR_URL?.trim()
const session = process.env.SITE_PUBLISH_SESSION?.trim() || "dev"

if (!orchestratorUrl) {
  console.log("[sync-published-content] ORCHESTRATOR_URL not set, keeping existing published-content.json")
  process.exit(0)
}

const base = orchestratorUrl.replace(/\/$/, "")
const endpoint = `${base}/publish/content?session=${encodeURIComponent(session)}`
const response = await fetch(endpoint, { cache: "no-store" })

if (!response.ok) {
  throw new Error(`[sync-published-content] fetch failed ${response.status} from ${endpoint}`)
}

const payload = await response.json()
if (!payload || !Array.isArray(payload.pages)) {
  throw new Error("[sync-published-content] invalid payload shape: expected { pages: [...] }")
}

const target = resolve(process.cwd(), "lib/published-content.json")
await writeFile(target, `${JSON.stringify(payload.pages, null, 2)}\n`, "utf8")
console.log(`[sync-published-content] wrote ${payload.pages.length} pages for session=${session}`)
