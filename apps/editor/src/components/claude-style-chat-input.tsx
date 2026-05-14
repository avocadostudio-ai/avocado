import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { ArrowUp, Check, Mic, MousePointerClick, Plus, Square, X } from "lucide-react"
import { useT } from "@/i18n"

const IS_DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "1"

function formatRecordingTime(ms: number) {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

type Props = {
  message: string
  isLoading: boolean
  hasUserEntry: boolean
  onMessageChange: (value: string) => void
  onSubmit: (explicitMessage?: string) => void
  onTranscribeAudio: (blob: Blob, mimeType: string) => Promise<string>
  onInterpretImage: (blob: Blob, mimeType: string) => Promise<string>
  onUploadImage: (blob: Blob, mimeType: string) => Promise<string>
  onCancel?: () => void
  onAutoHeightChange: (height: number) => void
  selectionModeEnabled?: boolean
  onToggleSelectionMode?: () => void
  compact?: boolean
}

export default function ClaudeStyleChatInput(props: Props) {
  const { message, isLoading, onMessageChange, onSubmit, onCancel, onTranscribeAudio, onInterpretImage, onUploadImage, onAutoHeightChange, selectionModeEnabled, onToggleSelectionMode, compact } = props
  const { t } = useT()
  const [isRecording, setIsRecording] = useState(false)
  const [recordingElapsedMs, setRecordingElapsedMs] = useState(0)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [isUploadingImage, setIsUploadingImage] = useState(false)
  const [isAnalyzingImage, setIsAnalyzingImage] = useState(false)
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null)
  const [imagePasteError, setImagePasteError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const shellRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const stopActionRef = useRef<"cancel" | "confirm" | null>(null)

  function syncComposerHeight() {
    const shell = shellRef.current
    if (!shell) return
    const textarea = textareaRef.current

    if (textarea) {
      // Temporarily collapse so scrollHeight reflects only content, not available space
      textarea.style.height = "0px"
      textarea.style.overflowY = "hidden"
      const naturalHeight = textarea.scrollHeight
      const maxTextareaHeight = 220
      const target = Math.min(maxTextareaHeight, Math.max(20, naturalHeight))
      textarea.style.height = `${target}px`
      textarea.style.overflowY = naturalHeight > target ? "auto" : "hidden"
    }

    // Ask the browser directly for the wrapper's natural content height —
    // includes its padding and every child (toolbar + shell + future siblings)
    // regardless of the grid-row clamp. Simpler and more correct than summing
    // padding/border/gap/children by hand.
    const composerWrapper = shell.closest(".composer") as HTMLElement | null
    const idealHeight = composerWrapper ? composerWrapper.scrollHeight : shell.scrollHeight
    onAutoHeightChange(idealHeight)
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

  useLayoutEffect(() => {
    syncComposerHeight()
  }, [message, isRecording, isTranscribing, isUploadingImage, isAnalyzingImage, transcriptionError, imagePasteError, onAutoHeightChange])

  // In Vite dev, component CSS is injected via JS modules and may not be applied
  // when the first useLayoutEffect runs — measurements then come back undersized
  // and `composerHeight` gets stuck at its minimum. Re-measure after the first
  // paint and after web fonts settle to recover the correct height.
  useEffect(() => {
    const rafId = requestAnimationFrame(() => syncComposerHeight())
    let cancelled = false
    if (typeof document !== "undefined" && document.fonts?.ready) {
      document.fonts.ready.then(() => { if (!cancelled) syncComposerHeight() }).catch(() => {})
    }
    return () => {
      cancelAnimationFrame(rafId)
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onResize = () => syncComposerHeight()
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  // Re-measure on any size change of the composer wrapper or shell — e.g. when
  // the chat-panel splitter is dragged or icons reflow at narrower widths. A
  // MutationObserver handles the case where a sibling (undo/redo toolbar)
  // appears or disappears inside the wrapper: the wrapper's offsetHeight is
  // clamped by the grid row so the ResizeObserver wouldn't fire for that.
  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return
    const wrapper = shell.closest(".composer") as HTMLElement | null

    let resizeObserver: ResizeObserver | undefined
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => syncComposerHeight())
      resizeObserver.observe(shell)
      if (wrapper) resizeObserver.observe(wrapper)
    }

    let mutationObserver: MutationObserver | undefined
    if (wrapper && typeof MutationObserver !== "undefined") {
      mutationObserver = new MutationObserver(() => syncComposerHeight())
      mutationObserver.observe(wrapper, { childList: true })
    }

    return () => {
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
    }
  }, [])

  useEffect(() => {
    if (!isRecording) {
      setRecordingElapsedMs(0)
      return
    }
    const startedAt = performance.now()
    setRecordingElapsedMs(0)
    const id = window.setInterval(() => {
      setRecordingElapsedMs(performance.now() - startedAt)
    }, 250)
    return () => window.clearInterval(id)
  }, [isRecording])

  function supportsRecording() {
    return typeof window !== "undefined" && typeof window.MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia
  }

  function appendTranscript(text: string) {
    const transcript = text.trim()
    if (!transcript) return
    const prefix = message.trim().length > 0 ? `${message.trim()} ` : ""
    onMessageChange(`${prefix}${transcript}`.trim())
  }

  async function handleImagePaste(blob: Blob, mimeType: string) {
    setImagePasteError(null)
    setIsUploadingImage(true)
    setIsAnalyzingImage(true)
    try {
      const [uploadedResult, interpretedResult] = await Promise.allSettled([
        onUploadImage(blob, mimeType),
        onInterpretImage(blob, mimeType)
      ])

      let uploadedUrl = ""
      if (uploadedResult.status === "fulfilled") {
        uploadedUrl = uploadedResult.value.trim()
      }

      let interpretedContext = ""
      if (interpretedResult.status === "fulfilled") {
        interpretedContext = interpretedResult.value.trim()
      }

      const nextLines = [message.trim()]
      if (uploadedUrl) nextLines.push(`Pasted image URL: ${uploadedUrl}`)
      if (interpretedContext) nextLines.push(`Image context: ${interpretedContext}`)
      onMessageChange(nextLines.filter(Boolean).join("\n"))

      if (!uploadedUrl && interpretedResult.status === "rejected") {
        const detail = interpretedResult.reason instanceof Error ? interpretedResult.reason.message : t("chatInput.analyzeFailed")
        setImagePasteError(detail)
      } else if (!uploadedUrl && interpretedResult.status === "fulfilled") {
        setImagePasteError(t("chatInput.uploadFailed"))
      } else if (uploadedUrl && interpretedResult.status === "rejected") {
        // URL is the critical part for image replacement; keep this non-fatal.
        setImagePasteError(null)
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : t("chatInput.analyzeFailed")
      setImagePasteError(detail)
    } finally {
      setIsUploadingImage(false)
      setIsAnalyzingImage(false)
    }
  }

  async function handleMicClick() {
    setTranscriptionError(null)
    if (!supportsRecording()) {
      setTranscriptionError(t("chatInput.speechUnsupported"))
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
            setTranscriptionError(t("chatInput.noSpeechDetected"))
            return
          }

          const nextMessage = [message.trim(), transcriptText].filter(Boolean).join(" ").trim()
          if (stopAction === "confirm") {
            onSubmit(nextMessage)
          } else {
            appendTranscript(transcriptText)
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : t("chatInput.transcribeFailed")
          setTranscriptionError(detail)
        } finally {
          setIsTranscribing(false)
        }
      }

      recorder.start()
      setIsRecording(true)
    } catch {
      setTranscriptionError(t("chatInput.micBlocked"))
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
  const canSubmit = !isLoading && !micBusy && !isUploadingImage && !isAnalyzingImage && message.trim().length > 0

  return (
    <div className={`composer-shell${isLoading ? " is-loading" : ""}`} ref={shellRef}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ""
          if (!file) return
          if (!file.type.startsWith("image/")) {
            setImagePasteError(t("chatInput.imageOnly"))
            return
          }
          void handleImagePaste(file, file.type || "image/png")
        }}
      />
      <div className="composer-input-area">
        {!isRecording && (
          <textarea
            ref={textareaRef}
            placeholder={IS_DEMO_MODE ? t("demo.placeholder") : t("chatInput.placeholder")}
            value={message}
            onChange={(e) => {
              onMessageChange(e.target.value)
              syncComposerHeight()
            }}
            onInput={() => syncComposerHeight()}
            onPaste={(e) => {
              const items = e.clipboardData?.items
              if (!items) return
              for (const item of items) {
                if (!item.type?.startsWith("image/")) continue
                const file = item.getAsFile()
                if (!file) continue
                e.preventDefault()
                void handleImagePaste(file, file.type || "image/png")
                return
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !micBusy && !isUploadingImage && !isAnalyzingImage) {
                e.preventDefault()
                onSubmit()
              }
            }}
            rows={1}
          />
        )}
        {isRecording ? (
          <div className="composer-input-note composer-input-note-listening">
            <span className="composer-rec-dot" aria-hidden="true" />
            <span className="composer-rec-label">{t("chatInput.listening")}</span>
            <span className="composer-rec-timer" aria-hidden="true">{formatRecordingTime(recordingElapsedMs)}</span>
          </div>
        ) : null}
        {isTranscribing ? <div className="composer-input-note">{t("chatInput.transcribing")}</div> : null}
        {isUploadingImage ? <div className="composer-input-note">{t("chatInput.uploadingImage")}</div> : null}
        {isAnalyzingImage ? <div className="composer-input-note">{t("chatInput.analyzingImage")}</div> : null}
        {transcriptionError ? <div className="composer-input-note composer-input-note-error">{transcriptionError}</div> : null}
        {imagePasteError ? <div className="composer-input-note composer-input-note-error">{imagePasteError}</div> : null}
      </div>
      <div className="composer-actions">
        {!compact && !isRecording && (
          <>
            <button
              type="button"
              className="composer-ghost-btn composer-plus-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={isLoading || isUploadingImage || isAnalyzingImage}
              aria-label={t("chatInput.addImage")}
              data-tooltip={t("chatInput.addImage")}
            >
              <Plus size={16} />
            </button>
            {onToggleSelectionMode && (
              <button
                type="button"
                className={`composer-ghost-btn composer-selector-btn${selectionModeEnabled ? " is-active" : ""}`}
                onClick={onToggleSelectionMode}
                disabled={isLoading}
                aria-label={selectionModeEnabled ? t("chatInput.exitSelector") : t("chatInput.selectElement")}
                data-tooltip={selectionModeEnabled ? t("chatInput.exitSelector") : t("chatInput.selectElement")}
                aria-pressed={selectionModeEnabled}
              >
                <MousePointerClick size={16} />
              </button>
            )}
          </>
        )}
        <div className="composer-actions-spacer" />
        <div className="composer-actions-right" role="group" aria-label={t("chatInput.voiceActions")}>
          {!compact && isRecording ? (
            <>
              <button type="button" className="composer-ghost-btn composer-cancel-btn" onClick={cancelRecording} disabled={isLoading || isTranscribing} aria-label={t("chatInput.cancelVoice")}>
                <X size={16} />
              </button>
              <button type="button" className="composer-send-btn" onClick={confirmRecording} disabled={isLoading || isTranscribing} aria-label={t("chatInput.sendRecorded")}>
                <Check size={16} />
              </button>
            </>
          ) : (
            <>
              {!compact && (
                <button
                  type="button"
                  className="composer-ghost-btn"
                  onClick={() => void handleMicClick()}
                  disabled={isLoading || isTranscribing}
                  aria-label={t("chatInput.startVoice")}
                >
                  <Mic size={16} />
                </button>
              )}
              <button
                type="button"
                className={`composer-send-btn${isLoading && onCancel ? " is-stop" : ""}`}
                onClick={isLoading && onCancel ? onCancel : () => onSubmit()}
                disabled={!(isLoading && onCancel) && !canSubmit}
                aria-label={isLoading && onCancel ? t("chatInput.stopGeneration") : t("chatInput.sendMessage")}
              >
                <span className="icon-send">
                  <ArrowUp size={16} strokeWidth={2.8} />
                </span>
                <span className="icon-stop">
                  <Square size={12} fill="currentColor" />
                </span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
