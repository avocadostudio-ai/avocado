"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

/**
 * Intercepts clicks on internal <a> tags anywhere in the document and routes
 * them through next/navigation's router.push — turning full-document reloads
 * (which flash white for a frame between unload and first paint, especially
 * noticeable inside the editor iframe) into client-side transitions.
 *
 * Why a global listener instead of an injectable <Link> component?
 *  - SiteHeader, Footer, CTA, RichText, etc. all render anchors from the
 *    shared @ai-site-editor/blocks package. A single interceptor covers all
 *    of them without threading a provider through every block.
 *  - No cross-package "use client" + context plumbing, so no risk of duplicate
 *    module instances breaking the provider/consumer wiring under pnpm +
 *    next.config's `resolve.symlinks: false`.
 *
 * Only hijacks clicks that a browser would otherwise turn into same-tab
 * same-origin navigation — modifier keys, middle-click, target=_blank,
 * download, rel=external, hash-on-same-page, and cross-origin links all fall
 * through to default handling.
 */
export function RouterLinkInterceptor() {
  const router = useRouter()

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.defaultPrevented) return
      if (event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

      const target = event.target as Element | null
      const anchor = target?.closest?.("a")
      if (!anchor) return
      if (anchor.target && anchor.target !== "_self") return
      if (anchor.hasAttribute("download")) return
      const rel = anchor.getAttribute("rel")
      if (rel && /\bexternal\b/i.test(rel)) return

      const hrefAttr = anchor.getAttribute("href")
      if (!hrefAttr) return
      // Leave protocol/mailto/tel and bare hashes to the browser.
      if (/^(?:[a-z][a-z0-9+\-.]*:|mailto:|tel:|#)/i.test(hrefAttr)) return

      let url: URL
      try {
        url = new URL(hrefAttr, window.location.href)
      } catch {
        return
      }
      if (url.origin !== window.location.origin) return

      event.preventDefault()
      router.push(url.pathname + url.search + url.hash)
    }

    document.addEventListener("click", onClick)
    return () => document.removeEventListener("click", onClick)
  }, [router])

  return null
}
