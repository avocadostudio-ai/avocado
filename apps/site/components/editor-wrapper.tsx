import { getPreviewWrapperProps, EditorOverlay, TileModeStyles } from "@ai-site-editor/site-sdk/editor"
import { BlockErrorBoundary, SharedBlockRenderer } from "@ai-site-editor/blocks"
import type { SiteHeaderBlock } from "../lib/navigation"
import type { PageDoc } from "../lib/site-contract"

export type EditorPageProps = {
  page: PageDoc
  chromeHeader: SiteHeaderBlock
  slug: string
  editorOrigin: string
  tileMode: boolean
}

export function EditorPageWrapper({
  page, chromeHeader, slug, editorOrigin, tileMode
}: EditorPageProps) {
  return (
    <>
      {tileMode && <TileModeStyles />}
      <SharedBlockRenderer block={chromeHeader} />
      <main className="editor-mode">
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
