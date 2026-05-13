import type { GeneratedFile, ScaffoldConfig } from "../types.js"

export function strapiTemplates(_config: ScaffoldConfig): GeneratedFile[] {
  return [
    { path: "lib/strapi.client.ts", content: STRAPI_CLIENT },
    { path: "lib/strapi.fetch.ts", content: STRAPI_FETCH },
    { path: "lib/publish.ts", content: STRAPI_PUBLISH },
  ]
}

const STRAPI_CLIENT = `const STRAPI_URL = process.env.STRAPI_URL?.trim().replace(/\\/+$/, "")
if (!STRAPI_URL) throw new Error("STRAPI_URL is required")
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN?.trim()

export { STRAPI_URL }

export async function strapiFetch<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  const url = \`\${STRAPI_URL}/api\${path}\`
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(STRAPI_TOKEN ? { Authorization: \`Bearer \${STRAPI_TOKEN}\` } : {}),
      ...options?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(\`Strapi \${res.status} \${res.statusText}: \${body.slice(0, 200)}\`)
  }
  const text = await res.text()
  if (!text) return undefined as T
  return JSON.parse(text) as T
}
`

const STRAPI_FETCH = `import { strapiFetch, STRAPI_URL } from "./strapi.client"
import { lowerToBlockType } from "@avocadostudio-ai/shared"
import { imageFields } from "./manifest"
import type { PageDoc, SiteConfig, BlockInstance } from "@avocadostudio-ai/shared"

type StrapiResponse<T> = { data: T; meta?: unknown }
type StrapiItem = { id: number; documentId: string; [key: string]: unknown }

function resolveMediaUrl(field: unknown): string {
  if (!field || typeof field !== "object") return ""
  const media = field as { url?: string; formats?: { large?: { url?: string } } }
  const url = media.formats?.large?.url ?? media.url
  if (!url) return ""
  return url.startsWith("http") ? url : \`\${STRAPI_URL}\${url}\`
}

function dzComponentToBlock(entry: Record<string, unknown>, index: number): BlockInstance | null {
  const component = entry.__component as string | undefined
  if (!component?.startsWith("blocks.")) return null
  const rawName = component.replace("blocks.", "")
  const blockType = lowerToBlockType(rawName)
  const imgFields = imageFields.get(blockType) ?? new Set<string>()
  const props: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(entry)) {
    if (key === "id" || key === "__component") continue
    if (value === null || value === undefined) continue
    props[key] = imgFields.has(key) ? resolveMediaUrl(value) : value
  }
  return { id: entry.id ? \`\${entry.id}-\${index}\` : String(index), type: blockType, props }
}

function strapiEntryToPageDoc(entry: StrapiItem): PageDoc | null {
  const slug = entry.slug as string | undefined
  if (!slug) return null
  const rawBlocks = entry.blocks as Array<Record<string, unknown>> | undefined
  const blocks: BlockInstance[] = []
  if (Array.isArray(rawBlocks)) {
    for (let i = 0; i < rawBlocks.length; i++) {
      const block = dzComponentToBlock(rawBlocks[i], i)
      if (block) blocks.push(block)
    }
  }
  return {
    id: (entry.pageId as string) ?? entry.documentId ?? String(entry.id),
    slug, title: (entry.title as string) ?? "", blocks,
    meta: (entry.pageMeta as PageDoc["meta"]) ?? undefined,
    updatedAt: (entry.updatedAt as string) ?? new Date().toISOString(),
  }
}

export async function getStrapiPage(slug: string): Promise<PageDoc | null> {
  try {
    const res = await strapiFetch<StrapiResponse<StrapiItem[]>>(
      \`/pages?filters[slug][$eq]=\${encodeURIComponent(slug)}&populate[blocks][populate]=*\`
    )
    if (!res.data || res.data.length === 0) return null
    return strapiEntryToPageDoc(res.data[0])
  } catch { return null }
}

export async function getStrapiSlugs(): Promise<string[]> {
  try {
    const res = await strapiFetch<StrapiResponse<StrapiItem[]>>("/pages?fields[0]=slug&pagination[pageSize]=100")
    return res.data.map((item) => item.slug as string).filter(Boolean)
  } catch { return [] }
}

export async function getStrapiPages(): Promise<PageDoc[]> {
  try {
    const res = await strapiFetch<StrapiResponse<StrapiItem[]>>(
      "/pages?populate[blocks][populate]=*&pagination[pageSize]=100"
    )
    return res.data.map(strapiEntryToPageDoc).filter((p): p is PageDoc => p !== null)
  } catch { return [] }
}

export async function getStrapiSiteConfig(): Promise<SiteConfig> {
  try {
    const res = await strapiFetch<StrapiResponse<StrapiItem>>("/site-config?populate=*")
    if (!res.data) return {}
    return {
      name: (res.data.name as string) || undefined,
      logo: (res.data.logo as string) || undefined,
      navLabels: (res.data.navLabels as Record<string, string>) || undefined,
    }
  } catch { return {} }
}
`

const STRAPI_PUBLISH = `import type { OnPublishFn } from "@ai-site-editor/site-sdk/routes"
import { createImageResolver } from "@ai-site-editor/site-sdk/routes"
import { strapiFetch, STRAPI_URL } from "./strapi.client"
import { imageFields } from "./manifest"

function isStrapiUrl(url: string): boolean {
  try { return new URL(url).origin === new URL(STRAPI_URL).origin } catch { return false }
}

async function findStrapiMediaByUrl(imageUrl: string): Promise<number | null> {
  try {
    const urlPath = new URL(imageUrl).pathname
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (process.env.STRAPI_API_TOKEN) headers.Authorization = \`Bearer \${process.env.STRAPI_API_TOKEN}\`
    const res = await fetch(
      \`\${STRAPI_URL}/api/upload/files?filters[url][$eq]=\${encodeURIComponent(urlPath)}\`,
      { headers }
    )
    if (!res.ok) return null
    const data = (await res.json()) as Array<{ id: number }>
    return data[0]?.id ?? null
  } catch { return null }
}

async function uploadToStrapiMedia(blob: Blob, fileName: string): Promise<number | null> {
  const form = new FormData()
  form.append("files", blob, fileName)
  const res = await fetch(\`\${STRAPI_URL}/api/upload\`, {
    method: "POST",
    headers: { ...(process.env.STRAPI_API_TOKEN ? { Authorization: \`Bearer \${process.env.STRAPI_API_TOKEN}\` } : {}) },
    body: form,
  })
  if (!res.ok) return null
  const uploaded = (await res.json()) as Array<{ id: number }>
  return uploaded[0]?.id ?? null
}

export function createStrapiPublishHandler(): OnPublishFn {
  return async (pages, config, context) => {
    const imageResolver = createImageResolver<number>(
      async (bytes, fileName) => uploadToStrapiMedia(new Blob([bytes]), fileName),
      context?.assets,
    )
    const errors: string[] = []

    async function resolveMediaId(imageUrl: string): Promise<number | null> {
      if (!imageUrl.startsWith("http") && imageUrl.startsWith("/")) {
        return findStrapiMediaByUrl(\`\${STRAPI_URL}\${imageUrl}\`)
      }
      if (isStrapiUrl(imageUrl)) return findStrapiMediaByUrl(imageUrl)
      return imageResolver.resolve(imageUrl)
    }

    for (const page of pages) {
      try {
        const existing = await strapiFetch<{ data: Array<{ documentId: string; blocks?: Array<Record<string, unknown>> }> }>(
          \`/pages?filters[slug][$eq]=\${encodeURIComponent(page.slug)}&populate[blocks][populate]=*\`
        )
        const existingBlocks = existing.data[0]?.blocks as Array<Record<string, unknown>> | undefined

        const dzBlocks = await Promise.all(page.blocks.map(async (block, blockIndex) => {
          const imgFields = imageFields.get(block.type) ?? new Set<string>()
          const data: Record<string, unknown> = { __component: \`blocks.\${block.type.toLowerCase()}\` }
          for (const [key, value] of Object.entries(block.props)) {
            if (key === "headingLevel") continue
            if (imgFields.has(key) && typeof value === "string" && value) {
              const mediaId = await resolveMediaId(value)
              if (mediaId) { data[key] = mediaId }
              else {
                const em = existingBlocks?.[blockIndex]?.[key]
                const emId = em && typeof em === "object" && !Array.isArray(em)
                  ? (em as Record<string, unknown>).id as number | undefined : undefined
                if (emId) data[key] = emId
              }
            } else { data[key] = value }
          }
          return data
        }))

        const pageData = {
          slug: page.slug, title: page.title, pageId: page.id, blocks: dzBlocks,
          ...(page.meta ? { pageMeta: page.meta } : {}),
        }

        if (existing.data.length > 0) {
          await strapiFetch(\`/pages/\${existing.data[0].documentId}\`, { method: "PUT", body: JSON.stringify({ data: pageData }) })
        } else {
          await strapiFetch("/pages", { method: "POST", body: JSON.stringify({ data: pageData }) })
        }
      } catch (err) {
        errors.push(\`\${page.slug}: \${err instanceof Error ? err.message : String(err)}\`)
      }
    }

    if (config.name || config.logo || config.navLabels) {
      try {
        await strapiFetch("/site-config", {
          method: "PUT",
          body: JSON.stringify({ data: { name: config.name ?? "", logo: config.logo ?? "", navLabels: config.navLabels ?? {} } }),
        })
      } catch {
        try {
          await strapiFetch("/site-config", {
            method: "POST",
            body: JSON.stringify({ data: { name: config.name ?? "", logo: config.logo ?? "", navLabels: config.navLabels ?? {} } }),
          })
        } catch { /* optional */ }
      }
    }

    if (errors.length > 0) return { ok: false, error: \`Failed: \${errors.join("; ")}\` }
    return { ok: true }
  }
}
`
