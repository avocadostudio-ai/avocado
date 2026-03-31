import { createUsePuck, useGetPuck } from "@puckeditor/core"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { getPuckHostApi } from "../../host/runtime"
import type { ChatEntry } from "../../host/types"
import { deriveSelectionContextFromPuck } from "./selection"
import { usePuckChatContext } from "./PuckChatContext"
import type { ChatPanelProps, PuckSelectionStore, SelectionContext } from "./types"

const usePuckSelector = createUsePuck()

export function PuckChatPluginPanelFromContext() {
  const context = usePuckChatContext()
  if (!context) return null
  return <PuckChatPluginPanel {...context} />
}

export function PuckChatPluginPanel({
  session,
  siteId,
  isBusy,
  error,
  chatEntries,
  streamStatus,
  streamingText,
  streamSteps,
  streamingChanges,
  undoInFlightEntryId,
  onSendPrompt,
  onCancelPrompt,
  onClickSuggestion,
  onUndo,
  onSelectionChange
}: ChatPanelProps) {
  const hostApi = getPuckHostApi()
  const media = hostApi.useMediaInput()
  const ChatComposerCore = hostApi.ChatComposerCore
  const [draft, setDraft] = useState("")
  const threadRef = useRef<HTMLDivElement | null>(null)
  const shouldAutoScrollRef = useRef(true)
  const didInitialAutoScrollRef = useRef(false)
  const getPuck = useGetPuck()
  const selectionJson = usePuckSelector((store) => JSON.stringify(
    deriveSelectionContextFromPuck(store as unknown as PuckSelectionStore) ?? null
  ))
  const liveSelection = useMemo(() => {
    try {
      const parsed = JSON.parse(selectionJson) as SelectionContext | null
      return parsed ?? undefined
    } catch {
      return undefined
    }
  }, [selectionJson])
  const safeEntries = useMemo(() => (
    Array.isArray(chatEntries)
      ? chatEntries.filter((entry): entry is ChatEntry => Boolean(entry && typeof entry === "object"))
      : []
  ), [chatEntries])
  const [fallbackStoredEntries, setFallbackStoredEntries] = useState<ChatEntry[]>([])

  useEffect(() => {
    if (typeof window === "undefined") return
    const storageKey = `editor-chat-log-v1:${session}:${siteId}`
    let lastRaw: string | null = null

    const readFallbackEntries = () => {
      try {
        const raw = window.localStorage.getItem(storageKey)
        if (raw === lastRaw) return
        lastRaw = raw
        if (!raw) {
          setFallbackStoredEntries([])
          return
        }
        const parsed = JSON.parse(raw) as unknown
        if (!Array.isArray(parsed)) {
          setFallbackStoredEntries([])
          return
        }
        setFallbackStoredEntries(parsed.filter((entry): entry is ChatEntry => Boolean(entry && typeof entry === "object")))
      } catch {
        setFallbackStoredEntries([])
      }
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key && event.key !== storageKey) return
      readFallbackEntries()
    }

    readFallbackEntries()
    window.addEventListener("storage", onStorage)
    const pollId = window.setInterval(readFallbackEntries, 700)
    return () => {
      window.removeEventListener("storage", onStorage)
      window.clearInterval(pollId)
    }
  }, [session, siteId])

  const displayEntries = safeEntries.length > 0 ? safeEntries : fallbackStoredEntries
  const hasUserEntry = displayEntries.some((entry) => entry.role === "user")
  const hasThreadContent = displayEntries.length > 0 || Boolean(streamingText) || Boolean(streamStatus)
  const doneStreamSteps = useMemo(() => streamSteps.filter((s) => s.done), [streamSteps])

  const scrollThreadToBottom = useCallback(() => {
    const thread = threadRef.current
    if (!thread) return
    thread.scrollTop = thread.scrollHeight
  }, [])

  const onThreadScroll = useCallback(() => {
    const thread = threadRef.current
    if (!thread) return
    const distanceToBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight
    shouldAutoScrollRef.current = distanceToBottom < 64
  }, [])

  const send = useCallback((explicitMessage?: string) => {
    const prompt = (explicitMessage ?? draft).trim()
    if (!prompt) return
    const latestSelection = deriveSelectionContextFromPuck(getPuck() as unknown as PuckSelectionStore)
    onSelectionChange(latestSelection)
    setDraft("")
    shouldAutoScrollRef.current = true
    scrollThreadToBottom()
    void onSendPrompt(prompt)
  }, [draft, getPuck, onSelectionChange, onSendPrompt, scrollThreadToBottom])

  useEffect(() => {
    onSelectionChange(liveSelection)
  }, [
    liveSelection?.activeBlockId,
    liveSelection?.activeBlockType,
    liveSelection?.activeEditablePath,
    onSelectionChange
  ])

  useEffect(() => {
    if (!hasThreadContent) return
    const shouldForceInitial = !didInitialAutoScrollRef.current
    if (!shouldForceInitial && !shouldAutoScrollRef.current) return
    const raf1 = window.requestAnimationFrame(() => {
      scrollThreadToBottom()
      didInitialAutoScrollRef.current = true
    })
    return () => {
      window.cancelAnimationFrame(raf1)
    }
  }, [
    hasThreadContent,
    displayEntries.length,
    streamingText,
    streamStatus,
    streamSteps.length,
    streamingChanges.length,
    scrollThreadToBottom
  ])

  return (
    <div className="puck-poc-chat puck-poc-chat--plugin">
      <div className="puck-poc-chat__header">
        <h1>AI Page Builder</h1>
      </div>
      <div className="puck-poc-chat__surface">
        <div
          ref={threadRef}
          className="puck-poc-chat__thread-core"
          onScroll={onThreadScroll}
        >
          {displayEntries.length === 0 && !streamingText && !streamStatus ? (
            <article className="chat-thread-empty">Start chatting to see responses here.</article>
          ) : null}
          {displayEntries.map((entry) => {
            const safeText = typeof entry.text === "string" && entry.text.trim().length > 0 ? entry.text : "…"
            const roleClass = entry.role === "user" ? "user" : "assistant"
            const safeSuggestions = Array.isArray(entry.suggestions)
              ? entry.suggestions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
              : []
            return (
              <article key={entry.id} className={`puck-poc-msg puck-poc-msg--${roleClass}`}>
                <div className="puck-poc-msg__main">
                  {(() => {
                    if (entry.role !== "assistant") return safeText
                      try {
                      return hostApi.renderFinalMarkdown(safeText)
                      } catch {
                      return safeText
                      }
                  })()}
                </div>
                {safeSuggestions.length > 0 ? (
                  <div className="msg-suggestions">
                    {safeSuggestions.map((line, idx) => (
                      <button
                        key={`${entry.id}-${idx}`}
                        type="button"
                        className="msg-suggestion"
                        onClick={() => void onClickSuggestion(line)}
                        disabled={isBusy}
                      >
                        {line}
                      </button>
                    ))}
                  </div>
                ) : null}
                {entry.canUndo || entry.wasUndone ? (
                  <div className="msg-undo-row">
                    <button
                      type="button"
                      className="msg-undo-btn"
                      onClick={() => void onUndo(entry.id)}
                      disabled={!entry.canUndo || isBusy || undoInFlightEntryId !== null}
                    >
                      {entry.wasUndone ? "Undone" : "Undo"}
                    </button>
                  </div>
                ) : null}
              </article>
            )
          })}
          {streamingText ? (
            <article className="puck-poc-msg puck-poc-msg--assistant">
              {doneStreamSteps.length > 0 ? (
                <ul className="stream-steps stream-steps-in-bubble">
                  {doneStreamSteps.map((step, idx) => (
                    <li key={idx} className="stream-step is-done">{step.label}</li>
                  ))}
                </ul>
              ) : null}
              <div className="puck-poc-msg__main">{hostApi.renderSimpleMarkdown(streamingText)}</div>
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
            </article>
          ) : streamStatus ? (
            <article className="puck-poc-msg puck-poc-msg--assistant">
              {doneStreamSteps.length > 0 ? (
                <ul className="stream-steps stream-steps-in-bubble">
                  {doneStreamSteps.map((step, idx) => (
                    <li key={idx} className="stream-step is-done">{step.label}</li>
                  ))}
                </ul>
              ) : null}
              <div className="puck-poc-msg__main">{streamStatus}</div>
            </article>
          ) : null}
        </div>
        <ChatComposerCore
          message={draft}
          isLoading={isBusy}
          hasUserEntry={hasUserEntry}
          onMessageChange={setDraft}
          onSubmit={send}
          onTranscribeAudio={media.transcribeAudio}
          onInterpretImage={media.interpretPastedImage}
          onUploadImage={media.uploadPastedImage}
          onCancel={onCancelPrompt}
          onAutoHeightChange={() => {}}
          className="composer puck-poc-chat__composer-core"
        />
      </div>

      {error ? <p className="puck-poc-chat__error">{error}</p> : null}
    </div>
  )
}
