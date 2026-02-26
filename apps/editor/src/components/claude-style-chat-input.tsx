import { useEffect, useRef, useState } from "react"
import ArrowUpIcon from "./arrow-up-icon"

type ModelKey = "fast" | "balanced" | "reasoning" | "codex"

type Props = {
  message: string
  isLoading: boolean
  modelKey: ModelKey
  hasUserEntry: boolean
  onMessageChange: (value: string) => void
  onModelChange: (value: ModelKey) => void
  onSubmit: (explicitMessage?: string) => void
  onUndo: () => void
  onRedo: () => void
  onTranscribeAudio: (blob: Blob, mimeType: string) => Promise<string>
  onAutoHeightChange: (height: number) => void
}

function modelLabel(model: ModelKey) {
  if (model === "fast") return "Fast"
  if (model === "reasoning") return "Reasoning"
  if (model === "codex") return "Codex"
  return "Balanced"
}

export default function ClaudeStyleChatInput(props: Props) {
  const { message, isLoading, modelKey, hasUserEntry, onMessageChange, onModelChange, onSubmit, onUndo, onRedo, onTranscribeAudio, onAutoHeightChange } = props
  const [isRecording, setIsRecording] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const shellRef = useRef<HTMLDivElement | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const stopActionRef = useRef<"cancel" | "confirm" | null>(null)

  function syncComposerHeight() {
    const textarea = textareaRef.current
    const shell = shellRef.current
    if (!textarea || !shell) return

    const maxTextareaHeight = 220
    textarea.style.height = "0px"
    const target = Math.min(maxTextareaHeight, Math.max(24, textarea.scrollHeight))
    textarea.style.height = `${target}px`
    textarea.style.overflowY = textarea.scrollHeight > maxTextareaHeight ? "auto" : "hidden"

    onAutoHeightChange(shell.scrollHeight)
  }

  useEffect(() => {
    return () => {
      try {
        mediaRecorderRef.current?.stop()
      } catch {
        // Ignore invalid-state stops during unmount.
      }
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
      mediaRecorderRef.current = null
      mediaStreamRef.current = null
    }
  }, [])

  useEffect(() => {
    syncComposerHeight()
  }, [message, isRecording, isTranscribing, transcriptionError, onAutoHeightChange])

  useEffect(() => {
    const onResize = () => syncComposerHeight()
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  function supportsRecording() {
    return typeof window !== "undefined" && typeof window.MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia
  }

  function appendTranscript(text: string) {
    const transcript = text.trim()
    if (!transcript) return
    const prefix = message.trim().length > 0 ? `${message.trim()} ` : ""
    onMessageChange(`${prefix}${transcript}`.trim())
  }

  async function handleMicClick() {
    setTranscriptionError(null)
    if (!supportsRecording()) {
      setTranscriptionError("Speech input is not supported in this browser.")
      return
    }
    if (isLoading || isTranscribing) return

    if (isRecording) {
      mediaRecorderRef.current?.stop()
      setIsRecording(false)
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaStreamRef.current = stream
      const recorder = new MediaRecorder(stream)
      mediaRecorderRef.current = recorder
      audioChunksRef.current = []

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) audioChunksRef.current.push(event.data)
      }

      recorder.onstop = async () => {
        const stopAction = stopActionRef.current
        stopActionRef.current = null
        const mimeType = recorder.mimeType || "audio/webm"
        const chunks = audioChunksRef.current
        audioChunksRef.current = []
        stream.getTracks().forEach((track) => track.stop())
        mediaStreamRef.current = null
        mediaRecorderRef.current = null
        setIsRecording(false)

        if (stopAction === "cancel" || chunks.length === 0) return

        setIsTranscribing(true)
        try {
          const blob = new Blob(chunks, { type: mimeType })
          const transcript = await onTranscribeAudio(blob, mimeType)
          const transcriptText = transcript.trim()
          if (!transcriptText) {
            setTranscriptionError("No speech detected. Try recording again.")
            return
          }

          const nextMessage = [message.trim(), transcriptText].filter(Boolean).join(" ").trim()
          if (stopAction === "confirm") {
            onSubmit(nextMessage)
          } else {
            appendTranscript(transcriptText)
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : "Failed to transcribe audio."
          setTranscriptionError(detail)
        } finally {
          setIsTranscribing(false)
        }
      }

      recorder.start()
      setIsRecording(true)
    } catch {
      setTranscriptionError("Microphone access is blocked. Please allow mic permissions and try again.")
    }
  }

  function cancelRecording() {
    if (!isRecording) return
    stopActionRef.current = "cancel"
    mediaRecorderRef.current?.stop()
    audioChunksRef.current = []
  }

  function confirmRecording() {
    if (!isRecording) return
    stopActionRef.current = "confirm"
    mediaRecorderRef.current?.stop()
  }

  const micBusy = isRecording || isTranscribing
  const canSubmit = !isLoading && !micBusy && message.trim().length > 0

  return (
    <div className="composer-shell" ref={shellRef}>
      <textarea
        ref={textareaRef}
        value={message}
        onChange={(e) => onMessageChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !micBusy) {
            e.preventDefault()
            onSubmit()
          }
        }}
        placeholder={hasUserEntry ? "" : "Try: Add testimonials below hero"}
        rows={1}
      />
      {isRecording ? <div className="composer-input-note">Listening... click ✓ to send or X to cancel.</div> : null}
      {isTranscribing ? <div className="composer-input-note">Transcribing...</div> : null}
      {transcriptionError ? <div className="composer-input-note composer-input-note-error">{transcriptionError}</div> : null}
      <div className="composer-actions">
        <div className="composer-actions-left" role="group" aria-label="History actions">
          <button type="button" className="composer-ghost-btn" onClick={onUndo} disabled={isLoading} aria-label="Undo">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 7 4 12l5 5" />
              <path d="M5 12h7a4.5 4.5 0 0 1 0 9H10" />
            </svg>
          </button>
          <button type="button" className="composer-ghost-btn" onClick={onRedo} disabled={isLoading} aria-label="Redo">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m15 7 5 5-5 5" />
              <path d="M19 12h-7a4.5 4.5 0 0 0 0 9h2" />
            </svg>
          </button>
        </div>
        <div className="composer-actions-center">
          <label className="composer-model-picker">
            <span>{modelLabel(modelKey)}</span>
            <select value={modelKey} onChange={(e) => onModelChange(e.target.value as ModelKey)} aria-label="Select model">
              <option value="fast">Fast</option>
              <option value="balanced">Balanced</option>
              <option value="reasoning">Reasoning</option>
              <option value="codex">Codex</option>
            </select>
          </label>
        </div>
        <div className="composer-actions-right" role="group" aria-label="Voice and send actions">
          {isRecording ? (
            <>
              <button type="button" className="composer-ghost-btn" onClick={cancelRecording} disabled={isLoading || isTranscribing} aria-label="Cancel voice input">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m6 6 12 12" />
                  <path d="m18 6-12 12" />
                </svg>
              </button>
              <button type="button" className="composer-send-btn" onClick={confirmRecording} disabled={isLoading || isTranscribing} aria-label="Send recorded message">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m5 12 4 4 10-10" />
                </svg>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="composer-ghost-btn"
                onClick={() => void handleMicClick()}
                disabled={isLoading || isTranscribing}
                aria-label="Start voice input"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 14a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v4a3 3 0 0 0 3 3Z" />
                  <path d="M19 11a7 7 0 0 1-14 0" />
                  <path d="M12 18v3" />
                </svg>
              </button>
              <button type="button" className="composer-send-btn" onClick={() => onSubmit()} disabled={!canSubmit} aria-label="Send message">
                <ArrowUpIcon size={16} color="currentColor" strokeWidth={2.8} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
