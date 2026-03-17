import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const orchestratorUrl = process.env.ORCHESTRATOR_URL?.trim()
const session = process.env.SITE_PUBLISH_SESSION?.trim() || "dev"
const siteId = process.env.SITE_PUBLISH_SITE_ID?.trim() || ""

if (!orchestratorUrl) {
  console.log("[sync-published-content] ORCHESTRATOR_URL not set, keeping existing published-content.json")
  process.exit(0)
}

if (!siteId) {
  throw new Error("[sync-published-content] SITE_PUBLISH_SITE_ID is required when ORCHESTRATOR_URL is set")
}

const base = orchestratorUrl.replace(/\/$/, "")
const endpoint = `${base}/publish/content?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(siteId)}`
const response = await fetch(endpoint, { cache: "no-store" })

if (!response.ok) {
  throw new Error(`[sync-published-content] fetch failed ${response.status} from ${endpoint}`)
}

const payload = await response.json()
if (!payload || !Array.isArray(payload.pages)) {
  throw new Error("[sync-published-content] invalid payload shape: expected { pages: [...] }")
}

if (payload.pages.length === 0) {
  console.log("[sync-published-content] orchestrator returned 0 pages, keeping existing file")
  process.exit(0)
}

const output = { pages: payload.pages, siteConfig: payload.siteConfig ?? {} }
const target = resolve(process.cwd(), "lib/published-content.json")
await writeFile(target, `${JSON.stringify(output, null, 2)}\n`, "utf8")
console.log(`[sync-published-content] wrote ${payload.pages.length} pages for session=${session} siteId=${siteId}`)
