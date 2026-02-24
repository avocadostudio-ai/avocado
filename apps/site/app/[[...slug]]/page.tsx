import { BlockRenderer } from "../../components/block-renderer"
import { EditorPreviewBridge } from "../../components/editor-harness"
import { fetchDraftPage } from "../../lib/content-api"

type PageProps = {
  params: Promise<{ slug?: string[] }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

const DEFAULT_SESSION = "dev"
const DEFAULT_EDITOR_ORIGIN = "http://localhost:4100"

function buildSlug(parts?: string[]) {
  if (!parts || parts.length === 0) return "/"
  return `/${parts.join("/")}`
}

function getSingleValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

export default async function SitePage({ params, searchParams }: PageProps) {
  const resolvedParams = await params
  const resolvedSearch = await searchParams
  const slug = buildSlug(resolvedParams.slug)

  const editorMode = resolvedSearch.__editor === "1"
  const session = getSingleValue(resolvedSearch.session) ?? DEFAULT_SESSION
  const editorOrigin = getSingleValue(resolvedSearch.editorOrigin) ?? DEFAULT_EDITOR_ORIGIN

  const page = await fetchDraftPage(slug, session)

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
      {editorMode ? <EditorPreviewBridge slug={slug} editorOrigin={editorOrigin} /> : null}
    </>
  )
}
