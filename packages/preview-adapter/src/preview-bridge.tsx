"use client"

import { usePathname, useRouter } from "next/navigation"
import { PreviewBridgeCore } from "./preview-bridge-core"

export function PreviewBridge({ slug, editorOrigin }: { slug: string; editorOrigin: string }) {
  if (!editorOrigin) return null
  return <PreviewBridgeNextInner slug={slug} editorOrigin={editorOrigin} />
}

function PreviewBridgeNextInner({ slug, editorOrigin }: { slug: string; editorOrigin: string }) {
  const router = useRouter()
  const pathname = usePathname()
  return (
    <PreviewBridgeCore
      slug={slug}
      editorOrigin={editorOrigin}
      navigate={(href) => router.push(href)}
      refresh={() => router.refresh()}
      pathname={pathname}
    />
  )
}
