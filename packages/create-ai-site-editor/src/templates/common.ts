import type { ScaffoldConfig } from "../types.js"
import { CMS_CONFIGS } from "../cms-config.js"

export function editorApiRoute(config: ScaffoldConfig): string {
  const c = CMS_CONFIGS[config.cms]
  return `import { createEditorApiHandler } from "@ai-site-editor/site-sdk/routes"
${c.publishImport}
${c.getPagesImport ? c.getPagesImport + "\n" : ""}
export const { GET, POST, OPTIONS } = createEditorApiHandler({
  getPages: ${c.getPages},
  publishSecret: process.env.PUBLISH_TOKEN?.trim() || undefined,
  onPublish: ${c.onPublish},
})
`
}

export function revalidateRoute(config: ScaffoldConfig): string | null {
  const c = CMS_CONFIGS[config.cms]
  if (!c.revalidate) return null
  const r = c.revalidate
  const headerLine = r.secretHeader
    ? `  secretHeader: ${r.secretHeader},\n`
    : ""

  return `import { createRevalidateHandler } from "@ai-site-editor/site-sdk/routes"
${r.getPagesImport}

export const POST = createRevalidateHandler({
  secretEnvVar: "${r.secretEnvVar}",
${headerLine}  extractSlug: ${r.extractSlug},
  getPages: ${r.getPagesFn},
  siteId: "${config.siteId}",
})
`
}

export function manifestFile(config: ScaffoldConfig): string {
  if (config.blocksMode === "custom") {
    return `import type { BlockManifest } from "@ai-site-editor/shared"
import { getManifestImageFields } from "@ai-site-editor/site-sdk/routes"

const manifest: BlockManifest = {
  version: 1,
  blocks: [
    // {
    //   type: "Hero",
    //   displayName: "Hero Section",
    //   propsSchema: {
    //     type: "object",
    //     properties: {
    //       heading: { type: "string" },
    //       imageUrl: { type: "string" },
    //     },
    //     required: ["heading"],
    //   },
    //   defaultProps: { heading: "Welcome" },
    // },
  ],
}

export function getManifest() { return manifest }
export const { imageFields, listImageFields, listFieldNames } = getManifestImageFields(manifest)
`
  }

  return `import { buildBlockManifest } from "@ai-site-editor/site-sdk/editor-manifest"
import { getManifestImageFields } from "@ai-site-editor/site-sdk/routes"

export const { imageFields, listImageFields, listFieldNames } = getManifestImageFields(buildBlockManifest())
`
}

function adjustImportDepth(pageImport: string, mode: "static" | "preview"): string {
  // CMS config encodes import paths for the static layout (`app/[[...slug]]/page.tsx`).
  // Preview pages live one directory deeper (`app/preview-draft/[[...slug]]/page.tsx`),
  // so prefix one extra `../` on every relative import.
  if (mode === "static") return pageImport
  return pageImport.replace(/from "\.\.\//g, `from "../../`)
}

function pageFileNone(config: ScaffoldConfig, mode: "static" | "preview"): string {
  const c = CMS_CONFIGS[config.cms]
  const pageImport = adjustImportDepth(c.pageImport, mode)
  const factoryReturn = mode === "static" ? "{ Page, generateStaticParams }" : "{ Page }"
  const dynamicLine = mode === "preview" ? `\nexport const dynamic = "force-dynamic"\n` : ""
  const exports = mode === "static" ? "\nexport default Page\nexport { generateStaticParams }\n" : "\nexport default Page\n"

  return `import { createSitePage } from "@ai-site-editor/site-sdk/page"
${pageImport}

const PAGES_PATH = resolve(process.cwd(), "content/pages.json")

async function loadPages(): Promise<PageDoc[]> {
  try {
    const raw = await readFile(PAGES_PATH, "utf-8")
    return JSON.parse(raw) as PageDoc[]
  } catch { return [] }
}
${dynamicLine}
const ${factoryReturn} = createSitePage({
  mode: "${mode}",
  siteId: "${config.siteId}",
  getPage: async (slug) => {
    const pages = await loadPages()
    return pages.find((p) => p.slug === slug) ?? null
  },
  getSlugs: async () => {
    const pages = await loadPages()
    return pages.map((p) => p.slug)
  },
})${exports}`
}

function pageFileCms(config: ScaffoldConfig, mode: "static" | "preview"): string {
  const c = CMS_CONFIGS[config.cms]
  const pageImport = adjustImportDepth(c.pageImport, mode)
  const factoryReturn = mode === "static" ? "{ Page, generateStaticParams }" : "{ Page }"
  const dynamicLine = mode === "preview" ? `\nexport const dynamic = "force-dynamic"\n` : ""
  const exports = mode === "static" ? "\nexport default Page\nexport { generateStaticParams }\n" : "\nexport default Page\n"

  return `import { createSitePage } from "@ai-site-editor/site-sdk/page"
${pageImport}
${dynamicLine}
const ${factoryReturn} = createSitePage({
  mode: "${mode}",
  siteId: "${config.siteId}",
  getPage: ${c.getPage},
  getSlugs: ${c.getSlugs},
  ${c.getSiteConfig ? `getSiteConfig: ${c.getSiteConfig},` : ""}
})${exports}`
}

export function pageFile(config: ScaffoldConfig, mode: "static" | "preview" = "static"): string {
  return config.cms === "none" ? pageFileNone(config, mode) : pageFileCms(config, mode)
}

export function middlewareFile(): string {
  return `import { createEditorMiddleware } from "@ai-site-editor/site-sdk/middleware"

export const { middleware, config } = createEditorMiddleware()
`
}

export function envExample(config: ScaffoldConfig): string {
  const c = CMS_CONFIGS[config.cms]
  const common = `# AI Site Editor
ORCHESTRATOR_URL=http://localhost:4200
DRAFT_MODE_SECRET=dev-secret
# PUBLISH_TOKEN=          # Optional: protects the publish endpoint
`
  return c.envVars ? `${c.envVars}\n\n${common}` : common
}
