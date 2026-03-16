import { BlockErrorBoundary } from "@ai-site-editor/site-sdk"
import { SharedBlockRenderer } from "@ai-site-editor/blocks"
import { SiteHeader } from "./site-header"
import type { NavItem } from "../lib/navigation"
import type { PageDoc } from "../lib/site-contract"

export type SitePageContentProps = {
  page: PageDoc
  navItems: NavItem[]
  siteName: string
  siteLogo: string
  homeHref: string
}

export function SitePageContent({ page, navItems, siteName, siteLogo, homeHref }: SitePageContentProps) {
  return (
    <>
      <SiteHeader siteName={siteName} siteLogo={siteLogo} homeHref={homeHref} navItems={navItems} />
      <main>
        {page.blocks.map((block) => (
          <div key={block.id}>
            <BlockErrorBoundary blockId={block.id} blockType={block.type}>
              <SharedBlockRenderer block={block} />
            </BlockErrorBoundary>
          </div>
        ))}
      </main>
    </>
  )
}
