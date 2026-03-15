import { BlockErrorBoundary, getPreviewWrapperProps, EditorOverlay, TileModeStyles } from "@ai-site-editor/site-sdk"
import { SharedBlockRenderer } from "@ai-site-editor/blocks"
import { SiteHeader, type NavItem } from "./site-header"
import type { PageDoc } from "../lib/site-contract"

export type EditorPageProps = {
  page: PageDoc
  navItems: NavItem[]
  siteName: string
  siteLogo: string
  homeHref: string
  slug: string
  editorOrigin: string
  tileMode: boolean
}

export function EditorPageWrapper({
  page, navItems, siteName, siteLogo, homeHref, slug, editorOrigin, tileMode
}: EditorPageProps) {
  return (
    <>
      {tileMode && <TileModeStyles />}
      <SiteHeader siteName={siteName} siteLogo={siteLogo} homeHref={homeHref} navItems={navItems} />
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
