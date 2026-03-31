import { useEffect, type ReactNode } from "react"
import { PUCK_PREVIEW_CSS } from "./constants"

export function PuckPreviewIframeOverride({
  document: frameDocument,
  children,
}: {
  document?: Document
  children?: ReactNode
}) {
  useEffect(() => {
    if (!frameDocument) return

    const applyScrollStyles = () => {
      const htmlEl = frameDocument.documentElement
      const bodyEl = frameDocument.body
      const entryEl = frameDocument.getElementById("frame-root")
        ?? frameDocument.querySelector<HTMLElement>("[data-puck-entry]")

      htmlEl.style.setProperty("margin", "0", "important")
      htmlEl.style.setProperty("padding", "0", "important")
      htmlEl.style.setProperty("height", "100%", "important")
      htmlEl.style.setProperty("min-height", "100%", "important")
      htmlEl.style.setProperty("overflow", "hidden", "important")

      if (bodyEl) {
        bodyEl.style.setProperty("margin", "0", "important")
        bodyEl.style.setProperty("padding", "0", "important")
        bodyEl.style.setProperty("height", "100%", "important")
        bodyEl.style.setProperty("min-height", "100%", "important")
        bodyEl.style.setProperty("overflow", "hidden", "important")
      }

      if (entryEl) {
        entryEl.style.setProperty("height", "100%", "important")
        entryEl.style.setProperty("min-height", "100%", "important")
        entryEl.style.setProperty("overflow-y", "auto", "important")
        entryEl.style.setProperty("overflow-x", "hidden", "important")
        entryEl.style.setProperty("overscroll-behavior", "contain", "important")
        entryEl.style.setProperty("-webkit-overflow-scrolling", "touch", "important")
      }
    }

    applyScrollStyles()
    const observer = new MutationObserver(() => applyScrollStyles())
    observer.observe(frameDocument.documentElement, {
      childList: true,
      subtree: true,
    })
    return () => observer.disconnect()
  }, [frameDocument])

  return (
    <>
      <style>{PUCK_PREVIEW_CSS}</style>
      {children}
    </>
  )
}
