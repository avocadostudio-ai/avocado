"use client"

import { useCallback } from "react"
import { usePathname, useRouter } from "next/navigation"
import { PreviewBridgeCore } from "./preview-bridge-core"

export function PreviewBridge({ slug, editorOrigin }: { slug: string; editorOrigin: string }) {
  // Skip when not embedded in an iframe (page opened directly in browser)
  if (!editorOrigin || window.parent === window) return null
  return <PreviewBridgeNextInner slug={slug} editorOrigin={editorOrigin} />
}

function PreviewBridgeNextInner({ slug, editorOrigin }: { slug: string; editorOrigin: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const navigate = useCallback((href: string) => router.push(href), [router])
  const refresh = useCallback(() => router.refresh(), [router])
  return (
    <PreviewBridgeCore
      slug={slug}
      editorOrigin={editorOrigin}
      navigate={navigate}
      refresh={refresh}
      pathname={pathname}
    />
  )
}
