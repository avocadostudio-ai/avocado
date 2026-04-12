/**
 * Image generation chat for the Asset Picker Generate tab.
 * Uses assistant-ui ComposerPrimitive for the input area, with direct
 * message rendering and SSE streaming to the Gemini chat endpoint.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import {
  useExternalStoreRuntime,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  type ThreadMessageLike,
} from "@assistant-ui/react"
import { ArrowUp, ZoomIn, Paperclip, X, Square, Sparkles } from "lucide-react"
import { orchestrator } from "../lib/editor-utils"
import { renderFinalMarkdown } from "../lib/markdown-renderer"
import { useT } from "@/i18n"
import "./ImageGenerateChat.css"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ChatMessage = {
  id: string
  role: "user" | "assistant"
  text: string
  imageUrl?: string
}

type ImageGenerateChatProps = {
  currentUrl?: string
  hasEditableImage: boolean
  editMode: "choose" | "edit" | "new"
  setEditMode: (mode: "choose" | "edit" | "new") => void
  referenceImages: Array<{ url: string; thumbUrl: string; uploading?: boolean }>
  setReferenceImages: React.Dispatch<React.SetStateAction<Array<{ url: string; thumbUrl: string; uploading?: boolean }>>>
  detectedAspectRatio: string | null
  setDetectedAspectRatio: (r: string | null) => void
  onSelect: (url: string, alt: string) => void
  onLightbox: (url: string) => void
  refImageInputRef: React.RefObject<HTMLInputElement | null>
  effectiveMaxReferences: number
  handleRefImageInput: (e: React.ChangeEvent<HTMLInputElement>) => void
  handleRefDrop: (e: React.DragEvent) => void
}

const EMPTY_MESSAGES: readonly ThreadMessageLike[] = []

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ImageGenerateChat(props: ImageGenerateChatProps) {
  const { t } = useT()
  const {
    currentUrl, hasEditableImage, editMode, setEditMode,
    referenceImages, setReferenceImages, detectedAspectRatio, setDetectedAspectRatio,
    onSelect, onLightbox, refImageInputRef, effectiveMaxReferences,
    handleRefImageInput, handleRefDrop,
  } = props

  // ── State ──
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [chatId, setChatId] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const isRunningRef = useRef(false)
  const [generatedResult, setGeneratedResult] = useState<{ url: string; alt: string } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollRafRef = useRef(0)

  const nextId = useRef(0)
  const mkId = () => `imgchat_${++nextId.current}_${Date.now()}`

  // ── Auto-scroll ──
  const scheduleScroll = useCallback(() => {
    cancelAnimationFrame(scrollRafRef.current)
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
    })
  }, [])

  useEffect(() => { scheduleScroll() }, [messages, scheduleScroll])
  useEffect(() => () => cancelAnimationFrame(scrollRafRef.current), [])

  // ── SSE send handler ──
  const handleSend = useCallback(async (userText: string) => {
    if (!userText.trim() || isRunningRef.current) return
    const text = userText.trim()

    // On first message in edit mode, include the original image in the user bubble
    const includeOriginal = editMode === "edit" && hasEditableImage && currentUrl && !chatId
    const userMsg: ChatMessage = { id: mkId(), role: "user", text, ...(includeOriginal ? { imageUrl: currentUrl } : {}) }
    const assistantMsg: ChatMessage = { id: mkId(), role: "assistant", text: "" }
    setMessages(prev => [...prev, userMsg, assistantMsg])
    isRunningRef.current = true
    setIsRunning(true)

    const ctrl = new AbortController()
    abortRef.current = ctrl

    try {
      const res = await fetch(`${orchestrator}/image/generate/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          prompt: text,
          chatId: chatId ?? undefined,
          stream: true,
          ...(detectedAspectRatio ? { aspectRatio: detectedAspectRatio } : {}),
          ...(editMode === "edit" && hasEditableImage && currentUrl && !chatId ? { referenceImageUrl: currentUrl } : {}),
          ...(referenceImages.length > 0 && !chatId ? { referenceImageUrls: referenceImages.filter(r => r.url).map(r => r.url) } : {}),
        }),
      })
      if (!res.ok || !res.body) return

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        let eventType = ""
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim()
          } else if (line.startsWith("data: ") && eventType) {
            try {
              const data = JSON.parse(line.slice(6))
              if (eventType === "chatId") {
                setChatId(data.chatId)
                if (data.aspectRatio) setDetectedAspectRatio(data.aspectRatio)
              } else if (eventType === "text") {
                setMessages(prev => {
                  const updated = [...prev]
                  const last = updated[updated.length - 1]
                  if (last?.role === "assistant") {
                    updated[updated.length - 1] = { ...last, text: last.text + data.text }
                  }
                  return updated
                })
              } else if (eventType === "image") {
                setMessages(prev => {
                  const updated = [...prev]
                  const last = updated[updated.length - 1]
                  if (last?.role === "assistant") {
                    updated[updated.length - 1] = { ...last, imageUrl: data.url }
                  }
                  return updated
                })
                setGeneratedResult({ url: data.url, alt: data.alt })
              }
            } catch { /* parse error */ }
            eventType = ""
          }
        }
        scheduleScroll()
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return
    } finally {
      isRunningRef.current = false
      setIsRunning(false)
      abortRef.current = null
    }
  }, [chatId, currentUrl, detectedAspectRatio, editMode, hasEditableImage, referenceImages, scheduleScroll, setDetectedAspectRatio])

  const handleCancel = useCallback(() => {
    abortRef.current?.abort()
    isRunningRef.current = false
    setIsRunning(false)
  }, [])
  const runtime = useExternalStoreRuntime({
    messages: EMPTY_MESSAGES,
    isRunning,
    convertMessage: (msg: ThreadMessageLike) => msg,
    onNew: async (message: { content: readonly { type: string; text?: string }[] }) => {
      const text = message.content.find((p): p is { type: "text"; text: string } => p.type === "text")?.text
      if (text) void handleSend(text)
    },
    onCancel: async () => handleCancel(),
  })

  const showChoiceCards = hasEditableImage && editMode === "choose" && messages.length === 0
  const showEditContext = hasEditableImage && editMode === "edit" && messages.length === 0
  const showComposer = !showChoiceCards

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div
        className="aui-image-chat"
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy" }}
        onDrop={handleRefDrop}
      >
        {/* Choice cards: edit vs generate */}
        {showChoiceCards && (
          <div className="aui-image-chat-choices">
            <button className="aui-image-chat-choice" onClick={() => setEditMode("edit")}>
              <img src={currentUrl} alt="" className="aui-image-chat-choice-img" />
              <span className="aui-image-chat-choice-title">{t("imagePicker.editThisImage")}</span>
              <span className="aui-image-chat-choice-desc">{t("imagePicker.editThisImageDesc")}</span>
            </button>
            <button className="aui-image-chat-choice" onClick={() => setEditMode("new")}>
              <div className="aui-image-chat-choice-icon"><Sparkles size={24} /></div>
              <span className="aui-image-chat-choice-title">{t("imagePicker.generateNew")}</span>
              <span className="aui-image-chat-choice-desc">{t("imagePicker.generateNewDesc")}</span>
            </button>
          </div>
        )}

        {/* Edit context: show current image */}
        {showEditContext && (
          <div className="aui-image-chat-edit-ctx" onClick={() => currentUrl && onLightbox(currentUrl)}>
            <img src={currentUrl} alt="" className="aui-image-chat-edit-ctx-img" />
            <div className="aui-image-chat-zoom-icon"><ZoomIn size={20} /></div>
          </div>
        )}

        {/* Chat messages — direct rendering (reliable, same as the old working code) */}
        {messages.length > 0 && (
          <div ref={scrollRef} className="aui-image-thread-viewport">
            {messages.map((msg, i) => {
              const isLastAssistant = isRunning && msg.role === "assistant" && i === messages.length - 1
              if (msg.role === "user") {
                return (
                  <div key={msg.id} className="aui-image-msg aui-image-msg-user">
                    {msg.text && <span className="aui-image-msg-text">{msg.text}</span>}
                    {msg.imageUrl && <img src={msg.imageUrl} alt="" className="aui-image-msg-user-img" />}
                  </div>
                )
              }
              return (
                <div key={msg.id} className="aui-image-msg aui-image-msg-assistant">
                  {msg.text && <div className="aui-image-msg-text">{renderFinalMarkdown(msg.text)}</div>}
                  {msg.imageUrl && (
                    <div className="aui-image-msg-image-row">
                      <div className="aui-image-msg-zoom-wrap" onClick={() => onLightbox(msg.imageUrl!)}>
                        <img src={msg.imageUrl} alt="" className="aui-image-msg-image" />
                        <div className="aui-image-msg-zoom-icon"><ZoomIn size={20} /></div>
                      </div>
                      {generatedResult && msg.imageUrl === generatedResult.url && !isRunning && (
                        <button
                          className="aui-image-msg-use-btn"
                          onClick={() => onSelect(generatedResult.url, generatedResult.alt)}
                        >
                          {t("imagePicker.useImage")}
                        </button>
                      )}
                    </div>
                  )}
                  {isLastAssistant && (
                    <span className="aui-image-typing-dots">
                      <span />
                      <span />
                      <span />
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Composer (assistant-ui powered) */}
        {showComposer && (
          <div className="aui-image-composer-area">
            <input ref={refImageInputRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={handleRefImageInput} />
            {/* Reference images strip */}
            {referenceImages.length > 0 && (
              <div className="aui-image-ref-strip">
                {referenceImages.map((ref, i) => (
                  <div key={i} className="aui-image-ref-thumb">
                    <img src={ref.thumbUrl} alt="" />
                    {ref.uploading && <div className="aui-image-ref-uploading" />}
                    {!chatId && (
                      <button
                        className="aui-image-ref-remove"
                        onClick={() => setReferenceImages(prev => prev.filter((_, ri) => ri !== i))}
                      ><X size={10} /></button>
                    )}
                  </div>
                ))}
                {!chatId && referenceImages.length < effectiveMaxReferences && (
                  <button className="aui-image-ref-add" onClick={() => refImageInputRef.current?.click()}>+</button>
                )}
                <span className="aui-image-ref-count">{referenceImages.length}/{effectiveMaxReferences}</span>
              </div>
            )}

            <ComposerPrimitive.Root className="aui-image-composer-root">
              {!chatId && (
                <button
                  className="aui-image-composer-attach"
                  onClick={() => refImageInputRef.current?.click()}
                  disabled={referenceImages.length >= effectiveMaxReferences}
                ><Paperclip size={15} /></button>
              )}
              <ComposerPrimitive.Input
                placeholder={
                  messages.length > 0
                    ? t("imagePicker.followUpPrompt")
                    : editMode === "edit"
                      ? t("imagePicker.editPrompt")
                      : t("imagePicker.generatePrompt")
                }
                className="aui-image-composer-input"
              />
              {isRunning ? (
                <button className="aui-image-composer-stop" onClick={handleCancel}>
                  <Square size={14} fill="currentColor" />
                </button>
              ) : (
                <ComposerPrimitive.Send className="aui-image-composer-send">
                  <ArrowUp size={16} />
                </ComposerPrimitive.Send>
              )}
            </ComposerPrimitive.Root>
          </div>
        )}
      </div>
    </AssistantRuntimeProvider>
  )
}
