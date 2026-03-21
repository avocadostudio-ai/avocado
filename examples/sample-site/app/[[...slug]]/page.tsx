import { SharedBlockRenderer, BlockErrorBoundary, BlocksInitClient } from "@ai-site-editor/blocks"
import pagesData from "../../content/pages.json"

type Block = { id: string; type: string; props: Record<string, unknown> }
type PageData = { title: string; blocks: Block[] }

const pages: Record<string, PageData> = pagesData

function buildSlug(segments?: string[]): string {
  return segments ? `/${segments.join("/")}` : "/"
}

export function generateStaticParams() {
  return Object.keys(pages).map((slug) => ({
    slug: slug === "/" ? undefined : slug.replace(/^\//, "").split("/"),
  }))
}

export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const slug = buildSlug((await params).slug)
  const page = pages[slug]

  if (!page) {
    return (
      <main style={{ padding: "4rem", textAlign: "center" }}>
        <h1>404</h1>
        <p>Page not found.</p>
      </main>
    )
  }

  return (
    <main>
      {page.blocks.map((block) => (
        <div key={block.id} id={block.id}>
          <BlockErrorBoundary blockId={block.id} blockType={block.type}>
            <SharedBlockRenderer block={block} />
          </BlockErrorBoundary>
        </div>
      ))}
      <BlocksInitClient />
    </main>
  )
}
