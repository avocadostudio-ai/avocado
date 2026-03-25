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
  /** Pre-filled input text (e.g. from + button) */
  initialInput?: string
  /** Quick action suggestions shown at the top */
  quickActions?: string[]
  selectedBlockLabel?: string | null
}

export function ChatPanel({ chatLog, isLoading, streamStatus, onSubmit, onClose, initialInput, quickActions, selectedBlockLabel }: ChatPanelProps) {
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
        <span className="iw-panel-title">AI Editor</span>
        {selectedBlockLabel && (
          <span className="iw-panel-context">{selectedBlockLabel}</span>
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
                    onClick={() => { setInput(s); inputRef.current?.focus() }}
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
          className="iw-send"
          onClick={handleSubmit}
          disabled={!input.trim() || isLoading}
          aria-label="Send"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m5 12 7-7 7 7" />
            <path d="M12 19V5" />
          </svg>
        </button>
      </div>
    </div>
  )
}
