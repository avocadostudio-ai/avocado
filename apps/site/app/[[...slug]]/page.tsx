import { BlockRenderer } from "../../components/block-renderer"
import { PreviewBridge } from "@ai-site-editor/preview-adapter"
import type { PageDoc } from "@ai-site-editor/shared"

type PageProps = {
  params: Promise<{ slug?: string[] }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

function buildSlug(parts?: string[]) {
  if (!parts || parts.length === 0) return "/"
  return `/${parts.join("/")}`
}

async function fetchPage(slug: string, session: string): Promise<PageDoc | null> {
  const baseUrl = process.env.ORCHESTRATOR_URL ?? "http://localhost:4200"
  const res = await fetch(`${baseUrl}/draft/pages?session=${encodeURIComponent(session)}&slug=${encodeURIComponent(slug)}`, {
    cache: "no-store"
  })

  if (!res.ok) return null
  return (await res.json()) as PageDoc
}

export default async function SitePage({ params, searchParams }: PageProps) {
  const resolvedParams = await params
  const resolvedSearch = await searchParams
  const slug = buildSlug(resolvedParams.slug)

  const editorMode = resolvedSearch.__editor === "1"
  const session = typeof resolvedSearch.session === "string" ? resolvedSearch.session : "dev"
  const editorOrigin = typeof resolvedSearch.editorOrigin === "string" ? resolvedSearch.editorOrigin : "http://localhost:4100"

  const page = await fetchPage(slug, session)

  if (!page) {
    return (
      <main>
        <h1>Page not found</h1>
        <p>No content exists for {slug}.</p>
      </main>
    )
  }

  return (
    <>
      <main className={editorMode ? "editor-mode" : undefined}>
        {page.blocks.map((block) => (
          <BlockRenderer key={block.id} block={block} editorMode={editorMode} />
        ))}
      </main>
      {editorMode ? <PreviewBridge slug={slug} editorOrigin={editorOrigin} /> : null}
    </>
  )
}
