/**
 * Top-left "← Back" pill that returns the user to the main editor.
 * Auto-hides when the chat panel is open or when the user scrolls down,
 * to stay out of the way while the page is being read.
 */

import { useEffect, useState } from "react"

type Props = {
  editorOrigin: string
  session: string
  siteId: string
  slug: string
  hidden?: boolean
}

export function BackToEditorPill({ editorOrigin, session, siteId, slug, hidden }: Props) {
  const [scrolledHidden, setScrolledHidden] = useState(false)

  useEffect(() => {
    let last = typeof window !== "undefined" ? window.scrollY : 0
    let ticking = false
    const onScroll = () => {
      if (ticking) return
      ticking = true
      requestAnimationFrame(() => {
        const y = window.scrollY
        if (y < 40) setScrolledHidden(false)
        else if (y > last + 4) setScrolledHidden(true)
        else if (y < last - 4) setScrolledHidden(false)
        last = y
        ticking = false
      })
    }
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  const href = (() => {
    const p = new URLSearchParams({ session, siteId, slug })
    return `${editorOrigin}?${p.toString()}`
  })()

  const isHidden = hidden || scrolledHidden

  return (
    <a
      href={href}
      className={`iw-back-pill${isHidden ? " iw-back-pill--hidden" : ""}`}
      aria-label="Back to editor"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 12H5" />
        <path d="m12 19-7-7 7-7" />
      </svg>
      <span>Back</span>
    </a>
  )
}
