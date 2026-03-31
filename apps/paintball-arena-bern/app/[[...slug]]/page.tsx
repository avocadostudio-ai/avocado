import { createSitePage } from "@ai-site-editor/site-sdk/page"
import { resolve } from "node:path"
import { readFile } from "node:fs/promises"
import { readFileSync, existsSync } from "node:fs"
import type { PageDoc } from "@ai-site-editor/shared"

// Import custom blocks manifest — registers schemas + renderers (file created by block-coder)
import "../../blocks/register"

const PAGES_PATH = resolve(process.cwd(), "content/pages.json")
const CONFIG_PATH = resolve(process.cwd(), "content/site-config.json")

async function loadPages(): Promise<PageDoc[]> {
  try {
    const raw = await readFile(PAGES_PATH, "utf-8")
    return JSON.parse(raw) as PageDoc[]
  } catch { return [] }
}

async function loadSiteConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf-8"))
  } catch { return {} }
}

// Load footer at module init (sync) so it can be passed to createSitePage
const _siteConfig = existsSync(CONFIG_PATH)
  ? (() => { try { return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) } catch { return {} } })()
  : {}

const { Page, generateStaticParams } = createSitePage({
  siteId: "paintball-arena-bern",
  getPage: async (slug) => {
    const pages = await loadPages()
    return pages.find((p) => p.slug === slug) ?? null
  },
  getSlugs: async () => {
    const pages = await loadPages()
    return pages.map((p) => p.slug)
  },
  getSiteConfig: loadSiteConfig,
  footer: _siteConfig.footer ?? undefined,
})

export default Page
export { generateStaticParams }
