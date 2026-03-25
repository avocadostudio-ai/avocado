/**
 * Inline block type picker that appears near the + button.
 * Uses /ops to add blocks at the correct position.
 */

import { useState, useRef, useEffect } from "react"

export type AddBlockContext = {
  slug: string
  afterBlockId?: string
  beforeBlockId?: string
  /** The + button element — used to position the picker */
  anchorElement: HTMLElement
}

type InlineBlockPickerProps = {
  context: AddBlockContext
  onAdd: (blockType: string) => void
  onClose: () => void
}

const BLOCK_TYPES = [
  { type: "Hero", label: "Hero" },
  { type: "FeatureGrid", label: "Features" },
  { type: "Testimonials", label: "Testimonials" },
  { type: "FAQAccordion", label: "FAQ" },
  { type: "CTA", label: "CTA" },
  { type: "CardGrid", label: "Cards" },
  { type: "RichText", label: "Rich Text" },
]

export function InlineBlockPicker({ context, onAdd, onClose }: InlineBlockPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    const updatePosition = () => {
      const rect = context.anchorElement.getBoundingClientRect()
      setPosition({
        top: rect.bottom + window.scrollY + 8,
        left: rect.left + window.scrollX + rect.width / 2,
      })
    }
    updatePosition()
    window.addEventListener("scroll", updatePosition, { passive: true })
    window.addEventListener("resize", updatePosition, { passive: true })
    return () => {
      window.removeEventListener("scroll", updatePosition)
      window.removeEventListener("resize", updatePosition)
    }
  }, [context.anchorElement])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose() }
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [onClose])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const timer = setTimeout(() => document.addEventListener("mousedown", handler, true), 100)
    return () => { clearTimeout(timer); document.removeEventListener("mousedown", handler, true) }
  }, [onClose])

  if (!position) return null

  return (
    <div
      ref={containerRef}
      className="iw-block-picker"
      data-editor-widget-ignore=""
      style={{
        position: "absolute",
        top: `${position.top}px`,
        left: `${position.left}px`,
        transform: "translateX(-50%)",
        zIndex: 2147483647,
      }}
    >
      {BLOCK_TYPES.map((bt) => (
        <button
          key={bt.type}
          type="button"
          className="iw-block-picker-item"
          onClick={() => onAdd(bt.type)}
        >
          {bt.label}
        </button>
      ))}
    </div>
  )
}
