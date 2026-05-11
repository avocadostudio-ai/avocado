/**
 * Floating chat panel — message history + input.
 * Miniature version of the editor's chat panel, rendered directly in the site DOM.
 */

import { useState, useRef, useEffect, useMemo } from "react"
import { markdownToHtml } from "@ai-site-editor/preview-adapter"
import type { WidgetChatEntry } from "../lib/widget-state"

type ChatPanelProps = {
  chatLog: WidgetChatEntry[]
  isLoading: boolean
  streamStatus: string | null
  onSubmit: (message: string) => void
  onClose: () => void
  /** When provided, the send button becomes a stop button while loading. */
  onCancel?: () => void
  /** Pre-filled input text (e.g. from + button) */
  initialInput?: string
  /** Quick action suggestions shown at the top */
  quickActions?: string[]
  selectedBlockLabel?: string | null
  /** Undo/redo — when omitted, the buttons hide */
  canUndo?: boolean
  canRedo?: boolean
  onUndo?: () => void
  onRedo?: () => void
}

export function ChatPanel({ chatLog, isLoading, streamStatus, onSubmit, onClose, onCancel, initialInput, quickActions, selectedBlockLabel, canUndo, canRedo, onUndo, onRedo }: ChatPanelProps) {
  const [input, setInput] = useState(initialInput ?? "")
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chatLog.length, streamStatus])

  // Auto-focus input when panel opens
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSubmit = () => {
    const text = input.trim()
    if (!text || isLoading) return
    setInput("")
    onSubmit(text)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div className="iw-panel">
      <div className="iw-panel-header">
        <span className="iw-panel-title">AI Assistant</span>
        {selectedBlockLabel && (
          <span className="iw-panel-context">{selectedBlockLabel}</span>
        )}
        {(onUndo || onRedo) && (
          <div className="iw-panel-history">
            <button
              type="button"
              className="iw-panel-history-btn"
              onClick={onUndo}
              disabled={!canUndo}
              aria-label="Undo (⌘Z)"
              title="Undo (⌘Z)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 14 4 9l5-5" />
                <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" />
              </svg>
            </button>
            <button
              type="button"
              className="iw-panel-history-btn"
              onClick={onRedo}
              disabled={!canRedo}
              aria-label="Redo (⌘⇧Z)"
              title="Redo (⌘⇧Z)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 14 5-5-5-5" />
                <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5v0A5.5 5.5 0 0 0 9.5 20H13" />
              </svg>
            </button>
          </div>
        )}
        <button type="button" className="iw-panel-close" onClick={onClose} aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m7 7 10 10" />
            <path d="M17 7 7 17" />
          </svg>
        </button>
      </div>

      <div className="iw-panel-messages" ref={scrollRef}>
        {chatLog.length === 0 && !streamStatus && quickActions && quickActions.length > 0 && (
          <div className="iw-panel-quick-actions">
            <p className="iw-panel-quick-actions-label">Choose a block to add:</p>
            <div className="iw-message-suggestions">
              {quickActions.map((action, i) => (
                <button
                  key={i}
                  type="button"
                  className="iw-suggestion-pill"
                  onClick={() => { onSubmit(action); }}
                  disabled={isLoading}
                >
                  {action}
                </button>
              ))}
            </div>
          </div>
        )}
        {chatLog.length === 0 && !streamStatus && !quickActions && (
          <div className="iw-panel-empty">
            Select a block or type a message to get started.
          </div>
        )}
        {chatLog.map((entry) => (
          <div key={entry.id} className={`iw-message iw-message--${entry.role}`}>
            <div
              className="iw-message-text"
              dangerouslySetInnerHTML={{
                __html: entry.role === "assistant" ? markdownToHtml(entry.text) : entry.text
              }}
            />
            {entry.changes && entry.changes.length > 0 && (
              <ul className="iw-message-changes">
                {entry.changes.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            )}
            {entry.suggestions && entry.suggestions.length > 0 && (
              <div className="iw-message-suggestions">
                {entry.suggestions.map((s, i) => (
                  <button
                    key={i}
                    type="button"
                    className="iw-suggestion-pill"
                    onClick={() => { onSubmit(s) }}
                    disabled={isLoading}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {streamStatus && (
          <div className="iw-message iw-message--assistant iw-message--streaming">
            <div className="iw-message-status">{streamStatus}</div>
          </div>
        )}
      </div>

      <div className="iw-panel-input">
        <textarea
          ref={inputRef}
          className="iw-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask AI anything..."
          rows={1}
          disabled={isLoading}
        />
        <button
          type="button"
          className={`iw-send${isLoading && onCancel ? " is-stop" : ""}`}
          onClick={isLoading && onCancel ? onCancel : handleSubmit}
          disabled={!(isLoading && onCancel) && (!input.trim() || isLoading)}
          aria-label={isLoading && onCancel ? "Stop" : "Send"}
        >
          <span className="icon-send">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 12 7-7 7 7" />
              <path d="M12 19V5" />
            </svg>
          </span>
          <span className="icon-stop">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinejoin="round">
              <rect x="4" y="4" width="16" height="16" rx="1" />
            </svg>
          </span>
        </button>
      </div>
    </div>
  )
}
