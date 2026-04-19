import React, { forwardRef, useState, useCallback, type CSSProperties, type ReactNode } from "react"
import { Undo2, Redo2 } from "lucide-react"
import type { ChatEntry } from "../lib/editor-types"
import { renderFinalMarkdown, renderStreamingMarkdown } from "../lib/markdown-renderer"
import { isRedundantChangeLine } from "../lib/editor-utils"
import ClaudeStyleChatInput from "./claude-style-chat-input"
import { useEditorStore } from "../store"
import { ThinkingBlock } from "./ThinkingBlock"

type MediaHandler = (blob: Blob, mimeType: string) => Promise<string>

export type ChatThreadCoreProps = {
  entries?: ChatEntry[]
  isLoading?: boolean
  streamStatus?: string | null
  streamStatusLabel?: string | null
  streamingText?: string | null
  streamSteps?: { label: string; done: boolean }[]
  streamingChanges?: string[]
  undoInFlightEntryId: string | null
  className?: string
  style?: CSSProperties
  onSuggestionClick: (prompt: string) => void
  onUndo: (entryId: string) => void
  renderEntryExtras?: (entry: ChatEntry) => ReactNode
  renderStreamingExtras?: () => ReactNode
  renderStreamStatusFallback?: () => ReactNode
  undoLabel?: string
  undoneLabel?: string
}

export const ChatThreadCore = React.memo(forwardRef<HTMLDivElement, ChatThreadCoreProps>(function ChatThreadCore({
  entries: entriesProp,
  isLoading: isLoadingProp,
  streamStatus: streamStatusProp,
  streamStatusLabel,
  streamingText: streamingTextProp,
  streamSteps: streamStepsProp,
  streamingChanges: streamingChangesProp,
  undoInFlightEntryId,
  className = "chat-thread",
  style,
  onSuggestionClick,
  onUndo,
  renderEntryExtras,
  renderStreamingExtras,
  renderStreamStatusFallback,
  undoLabel = "Undo",
  undoneLabel = "Undone",
}, ref) {
  // Read from store — props take precedence when provided
  const storeChatLog = useEditorStore((s) => s.chatLog)
  const storeIsLoading = useEditorStore((s) => s.isLoading)
  const storeStreamStatus = useEditorStore((s) => s.streamStatus)
  const storeStreamingText = useEditorStore((s) => s.streamingText)
  const storeStreamSteps = useEditorStore((s) => s.streamSteps)
  const storeStreamingChanges = useEditorStore((s) => s.streamingChanges)
  const storeStreamingThinking = useEditorStore((s) => s.streamingThinking)
  const entries = entriesProp ?? storeChatLog
  const isLoading = isLoadingProp ?? storeIsLoading
  const streamStatus = streamStatusProp ?? storeStreamStatus
  const streamingText = streamingTextProp ?? storeStreamingText
  const streamSteps = streamStepsProp ?? storeStreamSteps
  const streamingChanges = streamingChangesProp ?? storeStreamingChanges
  const streamingThinking = storeStreamingThinking
  const opChecklist = useEditorStore((s) => s.opChecklist)
  const doneStreamSteps = streamSteps.filter((s) => s.done)
  const fallbackStatusLabel = streamStatusLabel ?? streamStatus
  const [clickedSuggestion, setClickedSuggestion] = useState<{ entryId: string; idx: number } | null>(null)
  const handleSuggestionClick = useCallback((entryId: string, idx: number, line: string) => {
    setClickedSuggestion({ entryId, idx })
    onSuggestionClick(line)
  }, [onSuggestionClick])
  const hasRenderableEntry = entries.some((entry) => {
    const text = typeof entry.text === "string" ? entry.text.trim() : ""
    return (
      text.length > 0
      || Boolean(entry.status)
      || Boolean((entry.suggestions ?? []).length)
      || Boolean((entry.changes ?? []).length)
      || Boolean(entry.variations)
      || Boolean(entry.canUndo)
      || Boolean(entry.wasUndone)
      || Boolean(entry.errors?.length)
    )
  })
  const isEmpty = !hasRenderableEntry && !streamingText && !streamStatus
  // K + D: once the user has posted at least one message, collapse the
  // permanent welcome bubble. If a field AI context entry is open, suppress
  // the welcome's suggestion strip so we don't render two competing rows.
  const hasUserTurn = entries.some((e) => e.role === "user")
  const hasFieldContext = entries.some((e) => e.fieldAiContext)

  return (
    <div className={className} style={style} ref={ref}>
      {isEmpty ? (
        <article className="chat-thread-empty">
          Start chatting to see responses here.
        </article>
      ) : null}
      {entries.map((entry) => (
        (() => {
          const rawText = typeof entry.text === "string" ? entry.text : ""
          const safeText = rawText.trim().length > 0 ? rawText : (entry.role === "assistant" ? "…" : "")
          const isWelcome = entry.id === "welcome"
          const collapseWelcome = isWelcome && hasUserTurn
          const suppressWelcomeSuggestions = isWelcome && hasFieldContext
          if (collapseWelcome) {
            return (
              <article key={entry.id} className="msg msg-assistant msg-welcome-collapsed">
                <details>
                  <summary>Welcome</summary>
                  {renderFinalMarkdown(safeText)}
                </details>
              </article>
            )
          }
          return (
        <article
          key={entry.id}
          className={`msg msg-${entry.role} ${entry.status === "needs_clarification" ? "msg-clarification" : ""} ${entry.canUndo ? "msg-has-undo" : ""} ${entry.fieldAiContext ? "msg-field-context" : ""}`}
        >
          {entry.role === "assistant" && entry.thinking && entry.thinking.text.length > 0 ? (
            <ThinkingBlock
              text={entry.thinking.text}
              status="done"
              durationMs={entry.thinking.durationMs}
            />
          ) : null}
          <div className="msg-main">{entry.role === "assistant" ? renderFinalMarkdown(safeText) : safeText}</div>
          {(() => {
            const changeLines = (entry.changes ?? []).filter((line) => !isRedundantChangeLine(rawText, line))
            if (changeLines.length === 0) return null
            if (changeLines.length > 5) {
              const remaining = changeLines.length - 3
              const moreLabel = entry.status === "info"
                ? `${remaining} more`
                : /translat/i.test(rawText)
                  ? `${remaining} more translations`
                  : `${remaining} more changes`
              const previewCount = 3
              return (
                <>
                  <ul className="msg-list">
                    {changeLines.slice(0, previewCount).map((line, idx) => <li key={idx}>{line}</li>)}
                  </ul>
                  <details className="msg-list-details">
                    <summary>{moreLabel}</summary>
                    <ul className="msg-list">
                      {changeLines.slice(previewCount).map((line, idx) => <li key={idx}>{line}</li>)}
                    </ul>
                  </details>
                </>
              )
            }
            return (
              <ul className="msg-list">
                {changeLines.map((line, idx) => <li key={idx}>{line}</li>)}
              </ul>
            )
          })()}
          {!entry.variations && !suppressWelcomeSuggestions && (entry.suggestions ?? []).length > 0 ? (
            <div className={`msg-suggestions${clickedSuggestion?.entryId === entry.id ? " msg-suggestions--chosen" : ""}`}>
              {entry.suggestions?.map((line, idx) => {
                const isChosen = clickedSuggestion?.entryId === entry.id && clickedSuggestion.idx === idx
                const isDimmed = clickedSuggestion?.entryId === entry.id && clickedSuggestion.idx !== idx
                return (
                  <button
                    key={`${entry.id}-${idx}`}
                    type="button"
                    className={`msg-suggestion${isChosen ? " msg-suggestion--chosen" : ""}${isDimmed ? " msg-suggestion--dimmed" : ""}`}
                    onClick={() => handleSuggestionClick(entry.id, idx, line)}
                    disabled={isLoading}
                  >
                    {line}
                  </button>
                )
              })}
            </div>
          ) : null}
          {renderEntryExtras ? renderEntryExtras(entry) : null}
          {entry.canUndo || entry.wasUndone ? (
            <div className="msg-undo-row">
              <button
                type="button"
                className="msg-undo-btn"
                onClick={() => onUndo(entry.id)}
                disabled={!entry.canUndo || isLoading || undoInFlightEntryId !== null}
              >
                <span>{entry.wasUndone ? undoneLabel : undoLabel}</span>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M9 7 4 12l5 5" />
                  <path d="M5 12h7a4.5 4.5 0 0 1 0 9H10" />
                </svg>
              </button>
            </div>
          ) : null}
        </article>
          )
        })()
      ))}
      {streamingText ? (
        <article className="msg msg-assistant msg-streaming">
          {doneStreamSteps.length > 0 ? (
            <ul className="stream-steps stream-steps-in-bubble">
              {doneStreamSteps.map((step, idx) => (
                <li key={idx} className="stream-step is-done">{step.label}</li>
              ))}
            </ul>
          ) : null}
          {streamingThinking ? (
            <ThinkingBlock
              text={streamingThinking.text}
              status={streamingThinking.status}
              durationMs={streamingThinking.durationMs}
            />
          ) : null}
          <div className="msg-main">
            {renderStreamingMarkdown(streamingText)}
          </div>
          {streamingChanges.length > 0 ? (
            <ul className="msg-list">
              {streamingChanges.slice(0, 8).map((line, idx) => (
                <li key={idx}>{line}</li>
              ))}
              {streamingChanges.length > 8 ? (
                <li className="msg-list-overflow">and {streamingChanges.length - 8} more…</li>
              ) : null}
            </ul>
          ) : null}
          {fallbackStatusLabel ? (
            <span className="streaming-pill-status streaming-pill-status-text stream-status-inline">{fallbackStatusLabel}</span>
          ) : null}
          {renderStreamingExtras ? renderStreamingExtras() : null}
        </article>
      ) : streamStatus ? (
        <article className="msg msg-assistant msg-streaming">
          {renderStreamStatusFallback ? renderStreamStatusFallback() : (
            <>
              {doneStreamSteps.length > 0 ? (
                <ul className="stream-steps stream-steps-in-bubble">
                  {doneStreamSteps.map((step, idx) => (
                    <li key={idx} className="stream-step is-done">{step.label}</li>
                  ))}
                </ul>
              ) : null}
              {streamingThinking ? (
                <ThinkingBlock
                  text={streamingThinking.text}
                  status={streamingThinking.status}
                  durationMs={streamingThinking.durationMs}
                />
              ) : null}
              {opChecklist.length > 0 ? (
                <ul className="op-checklist">
                  {opChecklist.map((item, idx) => (
                    <li key={idx} className={`op-checklist-item${item.done ? " is-done" : ""}`}>
                      <span className="op-checklist-icon">{item.done ? "✓" : "·"}</span>
                      {item.label}
                    </li>
                  ))}
                </ul>
              ) : null}
              {fallbackStatusLabel ? (
                <span className="streaming-pill-status streaming-pill-status-text stream-status-inline">{fallbackStatusLabel}</span>
              ) : null}
            </>
          )}
          {renderStreamingExtras ? renderStreamingExtras() : null}
        </article>
      ) : null}
      <div />
    </div>
  )
}))

export type ChatComposerCoreProps = {
  message: string
  isLoading: boolean
  hasUserEntry: boolean
  onMessageChange: (value: string) => void
  onSubmit: (explicitMessage?: string) => void
  onTranscribeAudio: MediaHandler
  onInterpretImage: MediaHandler
  onUploadImage: MediaHandler
  onCancel?: () => void
  onAutoHeightChange?: (height: number) => void
  selectionModeEnabled?: boolean
  onToggleSelectionMode?: () => void
  compact?: boolean
  className?: string
  style?: CSSProperties
  canUndoServer?: boolean
  canRedoServer?: boolean
  onGlobalUndo?: () => void
  onGlobalRedo?: () => void
  undoTooltip?: string
  redoTooltip?: string
}

export function ChatComposerCore({
  message,
  isLoading,
  hasUserEntry,
  onMessageChange,
  onSubmit,
  onTranscribeAudio,
  onInterpretImage,
  onUploadImage,
  onCancel,
  onAutoHeightChange,
  selectionModeEnabled,
  onToggleSelectionMode,
  compact,
  className = "composer",
  style,
  canUndoServer,
  canRedoServer,
  onGlobalUndo,
  onGlobalRedo,
  undoTooltip = "Undo (Ctrl+Z)",
  redoTooltip = "Redo (Ctrl+Y)",
}: ChatComposerCoreProps) {
  const showToolbar = onGlobalUndo && onGlobalRedo
  return (
    <div className={className} style={style}>
      {showToolbar ? (
        <div className="undo-redo-toolbar">
          <button
            type="button"
            className="undo-redo-btn"
            disabled={!canUndoServer || isLoading}
            onClick={onGlobalUndo}
            title={undoTooltip}
            aria-label={undoTooltip}
          >
            <Undo2 size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="undo-redo-btn"
            disabled={!canRedoServer || isLoading}
            onClick={onGlobalRedo}
            title={redoTooltip}
            aria-label={redoTooltip}
          >
            <Redo2 size={15} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      <ClaudeStyleChatInput
        message={message}
        isLoading={isLoading}
        hasUserEntry={hasUserEntry}
        onMessageChange={onMessageChange}
        onSubmit={onSubmit}
        onTranscribeAudio={onTranscribeAudio}
        onInterpretImage={onInterpretImage}
        onUploadImage={onUploadImage}
        onCancel={onCancel}
        onAutoHeightChange={onAutoHeightChange ?? (() => {})}
        selectionModeEnabled={selectionModeEnabled}
        onToggleSelectionMode={onToggleSelectionMode}
        compact={compact}
      />
    </div>
  )
}

export type ChatSurfaceProps = {
  containerClassName?: string
  containerStyle?: CSSProperties
  threadProps: ChatThreadCoreProps
  composerProps: ChatComposerCoreProps
}

export function ChatSurface({
  containerClassName,
  containerStyle,
  threadProps,
  composerProps,
}: ChatSurfaceProps) {
  return (
    <div className={containerClassName} style={containerStyle}>
      <ChatThreadCore {...threadProps} />
      <ChatComposerCore {...composerProps} />
    </div>
  )
}
