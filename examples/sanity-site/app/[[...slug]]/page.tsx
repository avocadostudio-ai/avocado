import { unstable_noStore as noStore } from "next/cache"
import { draftMode } from "next/headers"
import { BlocksHydrator, SharedBlockRenderer } from "@ai-site-editor/blocks"
import { buildSlug } from "@ai-site-editor/site-sdk"
import type { BlockInstance } from "@ai-site-editor/site-sdk"
import { resolveEditorContext, fetchEditorPage } from "@ai-site-editor/site-sdk/draft"
import { renderBlocks, EditorOverlay } from "@ai-site-editor/site-sdk/editor"
import { buildNavItems, buildSiteHeaderBlock } from "@ai-site-editor/site-sdk/navigation"
import { getSanityPage, getSanitySlugs, getSanitySiteConfig } from "../../lib/sanity.fetch"

const DEFAULT_SESSION = "dev"
const DEFAULT_SITE_ID = "sanity-site"

type PageProps = {
  params: Promise<{ slug?: string[] }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export async function generateStaticParams() {
  const slugs = await getSanitySlugs()
  return slugs.map((slug) => ({
    slug: slug === "/" ? undefined : slug.replace(/^\//, "").split("/"),
  }))
}

const defaultFooter: BlockInstance = {
  id: "chrome_footer",
  type: "Footer",
  props: {
    copyright: `© ${new Date().getFullYear()} Sanity Site. All rights reserved.`,
    columns: [
      { title: "Product", links: "Home|/" },
      { title: "Resources", links: "Sanity|https://www.sanity.io" },
    ],
  },
}

export default async function Page({ params, searchParams }: PageProps) {
  const resolvedParams = await params
  const resolvedSearch = await searchParams
  const slug = buildSlug(resolvedParams.slug)

  const editorCtx = await resolveEditorContext(resolvedSearch, {
    defaultSession: DEFAULT_SESSION,
    defaultSiteId: DEFAULT_SITE_ID,
  })

  const draft = await draftMode()
  const editorMode = draft.isEnabled || !!editorCtx

  const session = editorCtx?.session ?? DEFAULT_SESSION
  const siteId = editorCtx?.siteId ?? DEFAULT_SITE_ID

  if (editorMode) noStore()

  const [pageResult, navSlugs, siteConfig] = await Promise.all([
    editorMode
      ? fetchEditorPage(slug, session, siteId).then((p) => p ?? getSanityPage(slug))
      : getSanityPage(slug),
    getSanitySlugs(),
    getSanitySiteConfig(),
  ])

  const { navItems, siteName, siteLogo } = buildNavItems({
    navSlugs,
    currentSlug: slug,
    siteConfig,
    siteId: DEFAULT_SITE_ID,
    editorQuery: "",
    defaultLogo: "/logo.svg",
  })
  const chromeHeader = buildSiteHeaderBlock({ navItems, siteName, siteLogo, activePath: slug })

  if (!pageResult) {
    return (
      <>
        <SharedBlockRenderer block={chromeHeader} />
        <main style={{ padding: "4rem", textAlign: "center" }}>
          <h1>{editorMode ? "Draft unavailable" : "404"}</h1>
          <p>{editorMode ? `Could not load draft content for ${slug}.` : "Page not found."}</p>
        </main>
        <SharedBlockRenderer block={defaultFooter} />
      </>
    )
  }

  const pageBlocks = pageResult.blocks

  if (editorMode) {
    const editorOrigin = editorCtx?.editorOrigin ?? ""
    return (
      <>
        <SharedBlockRenderer block={chromeHeader} />
        <main className="editor-mode">
          {renderBlocks(pageBlocks, { editable: true })}
        </main>
        <SharedBlockRenderer block={defaultFooter} />
        <EditorOverlay slug={slug} editorOrigin={editorOrigin} />
      </>
    )
  }

  return (
    <>
      <SharedBlockRenderer block={chromeHeader} />
      <main>
        {renderBlocks(pageBlocks)}
        <BlocksHydrator />
      </main>
      <SharedBlockRenderer block={defaultFooter} />
    </>
  )
}
