"use client"

import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { useCallback } from "react"
import { renderBlocks } from "@ai-site-editor/site-sdk/editor"
import { SharedBlockRenderer } from "@ai-site-editor/blocks"
import { ImmersiveWidget, type WidgetConfig, type SiteContext } from "@ai-site-editor/immersive-widget"
import "@ai-site-editor/immersive-widget/styles.css"
import "@ai-site-editor/preview-adapter/styles.css"
import type { SiteHeaderBlock } from "@ai-site-editor/site-sdk/navigation"
import type { BlockManifest } from "@ai-site-editor/shared"
import type { PageDoc } from "../lib/site-contract"

export type ImmersivePageProps = {
  page: PageDoc
  chromeHeader: SiteHeaderBlock
  slug: string
  config: WidgetConfig
  siteContext?: SiteContext
  /** Query string to append to navigation links (preserves immersive mode) */
  editorQuery?: string
  /** Block manifest — drives the widget's block picker options. */
  manifest?: BlockManifest | null
  /** MVP gate: restrict block picker to text-first blocks and route text selection to inline field prompt. */
  textOnly?: boolean
}

export function ImmersivePageWrapper({
  page, chromeHeader, slug, config, siteContext, editorQuery, manifest, textOnly
}: ImmersivePageProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const refresh = useCallback(() => router.refresh(), [router])

  // Preserve immersive query params when navigating
  const navigate = useCallback((href: string) => {
    const url = new URL(href, window.location.origin)
    // Carry over immersive mode params
    if (!url.searchParams.has("immersive")) url.searchParams.set("immersive", "1")
    if (!url.searchParams.has("__editor")) url.searchParams.set("__editor", "1")
    if (!url.searchParams.has("siteId")) url.searchParams.set("siteId", config.siteId)
    if (!url.searchParams.has("session")) url.searchParams.set("session", config.session)
    router.push(url.pathname + url.search)
  }, [router, config])

  return (
    <>
      <SharedBlockRenderer block={chromeHeader} />
      <main className="editor-mode">
        {renderBlocks(page.blocks, { editable: true })}
      </main>
      <ImmersiveWidget
        config={config}
        slug={slug}
        pathname={pathname}
        refresh={refresh}
        navigate={navigate}
        siteContext={siteContext}
        manifest={manifest}
        textOnly={textOnly}
      />
    </>
  )
}
