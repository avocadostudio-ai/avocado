/**
 * Floating toolbar that appears above a text selection within an editable field.
 * Shows an "Ask AI" button that opens the chat panel with the selected text as context.
 */

import type { TextSelectionContext } from "../hooks/useTextSelection"

type TextSelectionToolbarProps = {
  selection: TextSelectionContext
  onAskAI: (context: TextSelectionContext) => void
}

export function TextSelectionToolbar({ selection, onAskAI }: TextSelectionToolbarProps) {
  const top = selection.rect.top + window.scrollY - 40
  const left = selection.rect.left + window.scrollX + selection.rect.width / 2

  return (
    <div
      className="iw-text-toolbar"
      style={{
        position: "absolute",
        top: `${top}px`,
        left: `${left}px`,
        transform: "translateX(-50%)",
        zIndex: 2147483647,
      }}
    >
      <button
        type="button"
        className="iw-text-toolbar-btn"
        onClick={() => onAskAI(selection)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
        </svg>
        Ask AI
      </button>
    </div>
  )
}
