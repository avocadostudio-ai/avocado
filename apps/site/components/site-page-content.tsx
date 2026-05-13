import { SharedBlockRenderer, BlocksHydrator } from "@avocadostudio-ai/blocks"
import { renderBlocks } from "@ai-site-editor/site-sdk"
import type { SiteHeaderBlock } from "@ai-site-editor/site-sdk/navigation"
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
        {renderBlocks(page.blocks)}
      </main>
      <BlocksHydrator />
    </>
  )
}
