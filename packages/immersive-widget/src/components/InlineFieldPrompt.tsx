/**
 * Inline prompt that appears below a clicked text element.
 * Shows suggestion pills + free-text input for field-level AI edits.
 * Replaces the chat panel for field-level operations.
 */

import { useState, useRef, useEffect } from "react"

export type FieldContext = {
  blockId: string
  blockType: string
  editablePath: string
  /** The DOM element being edited — used to position the prompt */
  element: HTMLElement
}

type InlineFieldPromptProps = {
  field: FieldContext
  isLoading: boolean
  onSubmit: (message: string) => void
  onClose: () => void
}

const SUGGESTIONS = [
  { label: "Rewrite", prompt: "Rewrite this text with a fresh perspective" },
  { label: "Shorter", prompt: "Make this text more concise" },
  { label: "More engaging", prompt: "Make this text more engaging and compelling" },
  { label: "Professional", prompt: "Rewrite in a more professional tone" },
  { label: "Casual", prompt: "Rewrite in a more casual, friendly tone" },
]

export function InlineFieldPrompt({ field, isLoading, onSubmit, onClose }: InlineFieldPromptProps) {
  const [input, setInput] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null)

  // Position below the target element
  useEffect(() => {
    const updatePosition = () => {
      const rect = field.element.getBoundingClientRect()
      setPosition({
        top: rect.bottom + window.scrollY + 8,
        left: rect.left + window.scrollX,
        width: Math.max(rect.width, 320),
      })
    }
    updatePosition()
    window.addEventListener("scroll", updatePosition, { passive: true })
    window.addEventListener("resize", updatePosition, { passive: true })
    return () => {
      window.removeEventListener("scroll", updatePosition)
      window.removeEventListener("resize", updatePosition)
    }
  }, [field.element])

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [onClose])

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        // Don't close if clicking on the target element itself
        if (field.element.contains(e.target as Node)) return
        onClose()
      }
    }
    // Delay to avoid the same click that opened it from closing it
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handler, true)
    }, 100)
    return () => {
      clearTimeout(timer)
      document.removeEventListener("mousedown", handler, true)
    }
  }, [onClose, field.element])

  const handleSubmit = (text: string) => {
    const msg = text.trim()
    if (!msg || isLoading) return
    onSubmit(msg)
  }

  if (!position) return null

  const fieldLabel = field.editablePath
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .trim()

  return (
    <div
      ref={containerRef}
      className="iw-field-prompt"
      data-editor-widget-ignore=""
      style={{
        position: "absolute",
        top: `${position.top}px`,
        left: `${position.left}px`,
        width: `${Math.min(position.width, 480)}px`,
        zIndex: 2147483647,
      }}
    >
      <div className="iw-field-prompt-header">
        <span className="iw-field-prompt-label">{fieldLabel}</span>
        <span className="iw-field-prompt-block">{field.blockType}</span>
        {isLoading && <span className="iw-field-prompt-loading" />}
        <button type="button" className="iw-field-prompt-close" onClick={onClose} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m7 7 10 10" /><path d="M17 7 7 17" />
          </svg>
        </button>
      </div>

      <div className="iw-field-prompt-input-row">
        <input
          ref={inputRef}
          type="text"
          className="iw-field-prompt-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(input) }}
          placeholder={`Edit ${fieldLabel.toLowerCase()}...`}
          disabled={isLoading}
        />
        <button
          type="button"
          className="iw-field-prompt-send"
          onClick={() => handleSubmit(input)}
          disabled={!input.trim() || isLoading}
          aria-label="Send"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m5 12 7-7 7 7" /><path d="M12 19V5" />
          </svg>
        </button>
      </div>

      <div className="iw-field-prompt-suggestions">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.label}
            type="button"
            className="iw-field-prompt-pill"
            onClick={() => handleSubmit(s.prompt)}
            disabled={isLoading}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  )
}
