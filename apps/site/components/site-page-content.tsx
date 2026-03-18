import { BlockErrorBoundary, SharedBlockRenderer, BlocksInitClient } from "@ai-site-editor/blocks"
import type { SiteHeaderBlock } from "../lib/navigation"
import type { PageDoc } from "../lib/site-contract"

export type SitePageContentProps = {
  page: PageDoc
  chromeHeader: SiteHeaderBlock
}

export function SitePageContent({ page, chromeHeader }: SitePageContentProps) {
  return (
    <>
      <SharedBlockRenderer block={chromeHeader} />
      <main>
        {page.blocks.map((block) => (
          <div key={block.id}>
            <BlockErrorBoundary blockId={block.id} blockType={block.type}>
              <SharedBlockRenderer block={block} />
            </BlockErrorBoundary>
          </div>
        ))}
      </main>
      <BlocksInitClient />
    </>
  )
}
