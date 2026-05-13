import { renderBlocks, EditorOverlay } from "@ai-site-editor/site-sdk/editor"
import { SharedBlockRenderer } from "@avocadostudio-ai/blocks"
import type { SiteHeaderBlock } from "@ai-site-editor/site-sdk/navigation"
import type { PageDoc } from "../lib/site-contract"

export type EditorPageProps = {
  page: PageDoc
  chromeHeader: SiteHeaderBlock
  slug: string
  editorOrigin: string
}

export function EditorPageWrapper({
  page, chromeHeader, slug, editorOrigin
}: EditorPageProps) {
  return (
    <>
      <SharedBlockRenderer block={chromeHeader} />
      <main className="editor-mode">
        {renderBlocks(page.blocks, { editable: true })}
      </main>
      <EditorOverlay slug={slug} editorOrigin={editorOrigin} />
    </>
  )
}
