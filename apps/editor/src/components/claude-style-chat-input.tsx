import { useEffect, useLayoutEffect, useRef, useState } from "react"
import ArrowUpIcon from "./arrow-up-icon"

type ModelKey = "fast" | "balanced" | "reasoning" | "codex"
type AIProvider = "openai" | "anthropic"

const MODEL_LABELS: Record<AIProvider, Record<ModelKey, string>> = {
  openai: { fast: "gpt-4o-mini", balanced: "gpt-4o", reasoning: "o1", codex: "o3" },
  anthropic: { fast: "Haiku", balanced: "Sonnet", reasoning: "Sonnet+Thinking", codex: "Opus" },
}

const PROVIDER_LABELS: Record<AIProvider, string> = {
  openai: "OpenAI",
  anthropic: "Claude",
}

type Props = {
  message: string
  isLoading: boolean
  modelKey: ModelKey
  provider: AIProvider
  availableProviders: AIProvider[]
  hasUserEntry: boolean
  onMessageChange: (value: string) => void
  onModelChange: (value: ModelKey) => void
  onProviderChange: (value: AIProvider) => void
  onSubmit: (explicitMessage?: string) => void
  onTranscribeAudio: (blob: Blob, mimeType: string) => Promise<string>
  onInterpretImage: (blob: Blob, mimeType: string) => Promise<string>
  onUploadImage: (blob: Blob, mimeType: string) => Promise<string>
  onCancel?: () => void
  onAutoHeightChange: (height: number) => void
}

function modelLabel(provider: AIProvider, model: ModelKey) {
  return MODEL_LABELS[provider][model]
}

function selectionValue(provider: AIProvider, model: ModelKey) {
  return `${provider}:${model}`
}

export default function ClaudeStyleChatInput(props: Props) {
  const { message, isLoading, modelKey, provider, availableProviders, onMessageChange, onModelChange, onProviderChange, onSubmit, onCancel, onTranscribeAudio, onInterpretImage, onUploadImage, onAutoHeightChange } = props
  const [isRecording, setIsRecording] = useState(false)
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
    const textarea = textareaRef.current
    const shell = shellRef.current
    if (!textarea || !shell) return

    // Temporarily collapse so scrollHeight reflects only content, not available space
    textarea.style.height = "0px"
    textarea.style.overflowY = "hidden"
    const naturalHeight = textarea.scrollHeight

    // Compute available space inside the shell for the textarea:
    // shell height minus padding, gap, and actions row
    const shellStyle = getComputedStyle(shell)
    const shellPaddingTop = parseFloat(shellStyle.paddingTop) || 0
    const shellPaddingBottom = parseFloat(shellStyle.paddingBottom) || 0
    const shellGap = parseFloat(shellStyle.gap) || 0

    // Measure the actions row height
    const actionsEl = shell.querySelector(".composer-actions") as HTMLElement | null
    const actionsHeight = actionsEl ? actionsEl.offsetHeight : 38

    // Measure any status notes below the textarea inside composer-input-area
    const inputArea = shell.querySelector(".composer-input-area") as HTMLElement | null
    let notesHeight = 0
    if (inputArea) {
      const inputAreaGap = parseFloat(getComputedStyle(inputArea).gap) || 0
      for (const child of inputArea.children) {
        if (child !== textarea) {
          notesHeight += (child as HTMLElement).offsetHeight + inputAreaGap
        }
      }
    }

    // Hard cap on textarea growth (absolute max before scrolling)
    const maxTextareaHeight = 220
    const target = Math.min(maxTextareaHeight, Math.max(24, naturalHeight))
    textarea.style.height = `${target}px`
    // Enable scrolling when content exceeds the capped height.
    // Also handles the case where flex-shrink compresses the textarea below target.
    textarea.style.overflowY = naturalHeight > target ? "auto" : "hidden"

    // Report the ideal total height to the parent so the grid row can grow.
    // Include the shell's border and the .composer wrapper's own vertical padding.
    const shellBorderV = (parseFloat(shellStyle.borderTopWidth) || 0) + (parseFloat(shellStyle.borderBottomWidth) || 0)

    const composerWrapper = shell.parentElement
    let wrapperPaddingV = 28 // fallback: 14px top + 14px bottom
    if (composerWrapper) {
      const ws = getComputedStyle(composerWrapper)
      wrapperPaddingV = (parseFloat(ws.paddingTop) || 0) + (parseFloat(ws.paddingBottom) || 0)
    }
    const idealHeight = shellPaddingTop + shellPaddingBottom + shellBorderV + target + notesHeight + shellGap + actionsHeight + wrapperPaddingV
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
        const detail = interpretedResult.reason instanceof Error ? interpretedResult.reason.message : "Failed to analyze pasted image."
        setImagePasteError(detail)
      } else if (!uploadedUrl && interpretedResult.status === "fulfilled") {
        setImagePasteError("Image uploaded failed. Try again or use drag-and-drop upload.")
      } else if (uploadedUrl && interpretedResult.status === "rejected") {
        // URL is the critical part for image replacement; keep this non-fatal.
        setImagePasteError(null)
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Failed to analyze pasted image."
      setImagePasteError(detail)
    } finally {
      setIsUploadingImage(false)
      setIsAnalyzingImage(false)
    }
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
  const canSubmit = !isLoading && !micBusy && !isUploadingImage && !isAnalyzingImage && message.trim().length > 0
  const providersForModels = availableProviders.length > 0 ? availableProviders : [provider]
  const selectedOption = selectionValue(provider, modelKey)

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
            setImagePasteError("Only image files are supported here.")
            return
          }
          void handleImagePaste(file, file.type || "image/png")
        }}
      />
      <div className="composer-input-area">
        <textarea
          ref={textareaRef}
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
        {isRecording ? <div className="composer-input-note">Listening... click ✓ to send or X to cancel.</div> : null}
        {isTranscribing ? <div className="composer-input-note">Transcribing...</div> : null}
        {isUploadingImage ? <div className="composer-input-note">Uploading pasted image...</div> : null}
        {isAnalyzingImage ? <div className="composer-input-note">Analyzing pasted image...</div> : null}
        {transcriptionError ? <div className="composer-input-note composer-input-note-error">{transcriptionError}</div> : null}
        {imagePasteError ? <div className="composer-input-note composer-input-note-error">{imagePasteError}</div> : null}
      </div>
      <div className="composer-actions">
        <div className="composer-actions-left">
          {!isRecording && (
            <button
              type="button"
              className="composer-ghost-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={isLoading || isUploadingImage || isAnalyzingImage}
              aria-label="Add image"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
            </button>
          )}
          <label className="composer-model-picker">
            <span>{`${PROVIDER_LABELS[provider]} ${modelLabel(provider, modelKey)}`}</span>
            <select
              value={selectedOption}
              onChange={(e) => {
                const [nextProvider, nextModel] = e.target.value.split(":") as [AIProvider, ModelKey]
                onProviderChange(nextProvider)
                onModelChange(nextModel)
              }}
              aria-label="Select AI model"
            >
              {providersForModels.flatMap((p) =>
                (Object.keys(MODEL_LABELS[p]) as ModelKey[]).map((m) => (
                  <option key={selectionValue(p, m)} value={selectionValue(p, m)}>
                    {PROVIDER_LABELS[p]} {MODEL_LABELS[p][m]}
                  </option>
                ))
              )}
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
              {isLoading && onCancel ? (
                <button type="button" className="composer-stop-btn" onClick={onCancel} aria-label="Stop generation">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                </button>
              ) : (
                <button type="button" className="composer-send-btn" onClick={() => onSubmit()} disabled={!canSubmit} aria-label="Send message">
                  <ArrowUpIcon size={16} color="currentColor" strokeWidth={2.8} />
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
