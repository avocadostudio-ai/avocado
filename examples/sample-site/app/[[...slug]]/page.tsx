import { unstable_noStore as noStore } from "next/cache"
import { draftMode } from "next/headers"
import { BlocksHydrator } from "@ai-site-editor/blocks"
import { buildSlug } from "@ai-site-editor/site-sdk"
import type { BlockInstance } from "@ai-site-editor/site-sdk"
import { resolveEditorContext, fetchEditorPage } from "@ai-site-editor/site-sdk/draft"
import { renderBlocks, EditorOverlay } from "@ai-site-editor/site-sdk/editor"
import pagesData from "../../content/pages.json"

const pages: Record<string, { blocks: BlockInstance[] }> = pagesData

const DEFAULT_SESSION = "dev"
const DEFAULT_SITE_ID = "sample-site"

type PageProps = {
  params: Promise<{ slug?: string[] }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export function generateStaticParams() {
  return Object.keys(pages).map((slug) => ({
    slug: slug === "/" ? undefined : slug.replace(/^\//, "").split("/"),
  }))
}

export default async function Page({ params, searchParams }: PageProps) {
  const resolvedParams = await params
  const resolvedSearch = await searchParams
  const slug = buildSlug(resolvedParams.slug)

  // Resolve editor context (null when not in draft/editor mode)
  const editorCtx = await resolveEditorContext(resolvedSearch, {
    defaultSession: DEFAULT_SESSION,
    defaultSiteId: DEFAULT_SITE_ID,
  })

  const draft = await draftMode()
  const editorMode = draft.isEnabled || !!editorCtx

  let pageBlocks: BlockInstance[]

  if (editorMode) {
    noStore()
    const session = editorCtx?.session ?? DEFAULT_SESSION
    const siteId = editorCtx?.siteId ?? DEFAULT_SITE_ID
    const draftPage = await fetchEditorPage(slug, session, siteId)
    if (draftPage) {
      pageBlocks = draftPage.blocks
    } else {
      const staticPage = pages[slug]
      if (!staticPage) {
        return (
          <main style={{ padding: "4rem", textAlign: "center" }}>
            <h1>Draft unavailable</h1>
            <p>Could not load draft content for <code>{slug}</code>.</p>
          </main>
        )
      }
      pageBlocks = staticPage.blocks
    }
  } else {
    const staticPage = pages[slug]
    if (!staticPage) {
      return (
        <main style={{ padding: "4rem", textAlign: "center" }}>
          <h1>404</h1>
          <p>Page not found.</p>
        </main>
      )
    }
    pageBlocks = staticPage.blocks
  }

  // Editor mode: add selection attributes and overlay
  if (editorMode) {
    const editorOrigin = editorCtx?.editorOrigin ?? ""
    return (
      <>
        <main className="editor-mode">
          {renderBlocks(pageBlocks, { editable: true })}
        </main>
        <EditorOverlay slug={slug} editorOrigin={editorOrigin} />
      </>
    )
  }

  // Static mode: simple render
  return (
    <main>
      {renderBlocks(pageBlocks)}
      <BlocksHydrator />
    </main>
  )
}
