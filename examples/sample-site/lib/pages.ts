import type { PageDoc, SiteConfig } from "@avocadostudio-ai/shared"
import pagesData from "../content/pages.json"

type RawPage = {
  title: string
  blocks: { id: string; type: string; props: Record<string, unknown> }[]
}

const pages: Record<string, RawPage> = pagesData

function toPageDoc(slug: string, raw: RawPage): PageDoc {
  return {
    id: slug,
    slug,
    title: raw.title,
    updatedAt: new Date().toISOString(),
    blocks: raw.blocks.map((b) => ({ id: b.id, type: b.type, props: b.props })),
  }
}

export async function getSamplePage(slug: string): Promise<PageDoc | null> {
  const raw = pages[slug]
  return raw ? toPageDoc(slug, raw) : null
}

export async function getSampleSlugs(): Promise<string[]> {
  return Object.keys(pages)
}

export async function getSamplePages(): Promise<PageDoc[]> {
  return Object.entries(pages).map(([slug, raw]) => toPageDoc(slug, raw))
}

export async function getSampleSiteConfig(): Promise<SiteConfig> {
  return { name: "Sample Site" }
}
