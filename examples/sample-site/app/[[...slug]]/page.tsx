import { unstable_noStore as noStore } from "next/cache"
import { buildSlug } from "@ai-site-editor/site-sdk"
import { resolveDraftContext, isTileMode } from "@ai-site-editor/site-sdk/draft"
import { fetchDraftPage } from "@ai-site-editor/site-sdk/draft"
import { getPreviewWrapperProps, EditorOverlay, TileModeStyles } from "@ai-site-editor/site-sdk/editor"
import { BlockErrorBoundary, SharedBlockRenderer } from "@ai-site-editor/blocks"

type PageProps = {
  params: Promise<{ slug?: string[] }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function Page({ params, searchParams }: PageProps) {
  const slug = buildSlug((await params).slug)
  const sp = await searchParams
  const ctx = await resolveDraftContext(sp)

  if (!ctx) {
    return (
      <main style={{ padding: "4rem", textAlign: "center" }}>
        <h1>Sample Site</h1>
        <p>
          This site is editor-only. Open the editor at{" "}
          <code>http://localhost:4100</code> and point it at{" "}
          <code>http://localhost:3002</code> to get started.
        </p>
      </main>
    )
  }

  noStore()
  const { session, siteId, editorOrigin } = ctx
  const page = await fetchDraftPage(slug, session, siteId)

  if (!page) {
    // In editor mode show a helpful message instead of 404
    return (
      <main style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", gap: "20px", padding: "24px", textAlign: "center" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 600 }}>Draft unavailable</h1>
        <p style={{ maxWidth: "28rem", color: "var(--body-secondary)" }}>
          Could not load draft content from orchestrator for <code>{slug}</code>.
          <br />
          Make sure the orchestrator is running and try refreshing.
        </p>
        <EditorOverlay slug={slug} editorOrigin={editorOrigin} />
      </main>
    )
  }

  const tileMode = isTileMode(sp)

  return (
    <>
      {tileMode && <TileModeStyles />}
      <main>
        {page.blocks.map((block) => (
          <div key={block.id} {...getPreviewWrapperProps(true, block.id, block.type)}>
            <BlockErrorBoundary blockId={block.id} blockType={block.type}>
              <SharedBlockRenderer block={block} />
            </BlockErrorBoundary>
          </div>
        ))}
      </main>
      {!tileMode && <EditorOverlay slug={slug} editorOrigin={editorOrigin} />}
    </>
  )
}
