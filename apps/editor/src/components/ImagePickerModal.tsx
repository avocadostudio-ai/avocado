import React, { useCallback, useEffect, useRef, useState } from "react"
import { X, Search, Upload, Sparkles, HardDrive, Image as ImageIcon, RefreshCw, Cloud, ZoomIn, Paperclip, Eye } from "lucide-react"
import { isImagePlaceholder } from "@ai-site-editor/shared"
import { orchestrator } from "../lib/editor-utils"
import { fetchCmsMedia, getCmsMediaLabel, type CmsMediaItem } from "../lib/cms-media"
import type { CmsMediaConfig } from "../lib/editor-types"
import { useT } from "@/i18n"

type ImageItem = {
  id: string
  name?: string
  imageUrl?: string
  thumbUrl: string
  alt?: string
  author?: string
}

type Tab = "drive" | "unsplash" | "contentful" | "sanity" | "strapi" | "upload" | "generate"

type Features = {
  googleDrive?: boolean
  unsplash?: boolean
  contentful?: boolean
  imageGenerate?: boolean
  imageGenerateChat?: boolean
}

type ChatMessage = {
  role: "user" | "assistant"
  text: string
  imageUrl?: string
}

type ImagePickerModalProps = {
  open: boolean
  features: Features
  currentUrl?: string
  gdriveFolderId?: string
  cmsMedia?: CmsMediaConfig
  /** Origin of the active site — used to resolve relative image URLs (e.g. /media/villa/img.webp → http://localhost:3001/media/villa/img.webp) */
  siteOrigin?: string
  onClose: () => void
  onSelect: (imageUrl: string, alt: string) => void
}

/** Unwrap Next.js /_next/image?url=...&w=...&q=... proxy URLs to the raw image URL */
function unwrapNextImageUrl(url: string | undefined): string | undefined {
  if (!url) return url
  try {
    const parsed = new URL(url, "http://localhost")
    if (parsed.pathname === "/_next/image") {
      const raw = parsed.searchParams.get("url")
      if (raw) return raw
    }
  } catch { /* not a valid URL */ }
  return url
}

/** Resolve a potentially-relative image URL against the site origin so the editor can display it */
function resolveImageUrl(url: string | undefined, siteOrigin: string | undefined): string | undefined {
  if (!url) return url
  // Already absolute
  if (/^https?:\/\//i.test(url) || url.startsWith("data:") || url.startsWith("blob:")) return url
  // Relative path like /media/villa/img.webp — prefix with site origin
  if (siteOrigin && url.startsWith("/")) return `${siteOrigin}${url}`
  return url
}

export function ImagePickerModal({ open, features, currentUrl: rawCurrentUrl, gdriveFolderId, cmsMedia, siteOrigin, onClose, onSelect }: ImagePickerModalProps) {
  const { t } = useT()
  const currentUrl = resolveImageUrl(unwrapNextImageUrl(rawCurrentUrl), siteOrigin)
  const hasEditableImage = !isImagePlaceholder(currentUrl)
  const availableTabs: Tab[] = []
  if (features.googleDrive) availableTabs.push("drive")
  if (features.unsplash) availableTabs.push("unsplash")
  if (cmsMedia?.provider === "contentful") availableTabs.push("contentful")
  if (cmsMedia?.provider === "sanity") availableTabs.push("sanity")
  if (cmsMedia?.provider === "strapi") availableTabs.push("strapi")
  availableTabs.push("upload")
  if (features.imageGenerate) availableTabs.push("generate")

  const [activeTab, setActiveTab] = useState<Tab>(availableTabs[0])
  const [searchQuery, setSearchQuery] = useState("")
  const [items, setItems] = useState<ImageItem[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [urlInput, setUrlInput] = useState("")
  const [urlAltInput, setUrlAltInput] = useState("")
  const [generatePrompt, setGeneratePrompt] = useState("")
  const [generating, setGenerating] = useState(false)
  const [generateStatus, setGenerateStatus] = useState("")
  const [generatedResult, setGeneratedResult] = useState<{ url: string; alt: string } | null>(null)
  const [chatId, setChatId] = useState<string | null>(null)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [editMode, setEditMode] = useState<"choose" | "edit" | "new">(hasEditableImage ? "choose" : "new")
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const scrollRafRef = useRef(0)
  const [uploadPreview, setUploadPreview] = useState<string | null>(null)
  const [uploadResult, setUploadResult] = useState<{ url: string } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)
  const [lightboxShowOriginal, setLightboxShowOriginal] = useState(false)
  const [referenceImages, setReferenceImages] = useState<Array<{ url: string; thumbUrl: string; uploading?: boolean }>>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const refImageInputRef = useRef<HTMLInputElement>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestIdRef = useRef(0)

  useEffect(() => {
    if (!open && searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
      searchTimerRef.current = null
    }
  }, [open])

  const fetchDriveImages = useCallback(async (q?: string, refresh?: boolean) => {
    const id = ++requestIdRef.current
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (q) params.set("q", q)
      params.set("limit", "20")
      if (gdriveFolderId?.trim()) params.set("folderId", gdriveFolderId.trim())
      if (refresh) params.set("refresh", "1")
      const res = await fetch(`${orchestrator}/gdrive/images?${params}`)
      if (id !== requestIdRef.current) return
      if (!res.ok) { setItems([]); return }
      const data = (await res.json()) as { items: ImageItem[] }
      if (id !== requestIdRef.current) return
      setItems(data.items.map((item) => ({
        ...item,
        imageUrl: `${orchestrator}/gdrive/images/${item.id}`,
        thumbUrl: item.thumbUrl || `${orchestrator}/gdrive/images/${item.id}`
      })))
    } catch { if (id === requestIdRef.current) setItems([]) }
    finally { if (id === requestIdRef.current) setLoading(false) }
  }, [gdriveFolderId])

  const fetchUnsplashImages = useCallback(async (q?: string, page = 1) => {
    if (!q) { setItems([]); setHasMore(false); return }
    const id = ++requestIdRef.current
    if (page === 1) setLoading(true); else setLoadingMore(true)
    try {
      const res = await fetch(`${orchestrator}/unsplash/search?q=${encodeURIComponent(q)}&limit=20&page=${page}`)
      if (id !== requestIdRef.current) return
      if (!res.ok) { if (page === 1) setItems([]); setHasMore(false); return }
      const data = (await res.json()) as { items: ImageItem[]; totalPages: number }
      if (id !== requestIdRef.current) return
      setItems((prev) => page === 1 ? data.items : [...prev, ...data.items])
      setHasMore(page < data.totalPages)
    } catch { if (id === requestIdRef.current) { if (page === 1) setItems([]); setHasMore(false) } }
    finally { if (id === requestIdRef.current) { if (page === 1) setLoading(false); else setLoadingMore(false) } }
  }, [])

  const fetchCmsMediaAssets = useCallback(async (q?: string, page = 1) => {
    if (!cmsMedia) return
    const id = ++requestIdRef.current
    if (page === 1) setLoading(true); else setLoadingMore(true)
    try {
      const data = await fetchCmsMedia(cmsMedia, q ?? "", page, 20)
      if (id !== requestIdRef.current) return
      const mapped: ImageItem[] = data.items.map((item) => ({
        id: item.id,
        name: item.name,
        imageUrl: item.imageUrl,
        thumbUrl: item.thumbUrl,
        alt: item.alt,
      }))
      setItems((prev) => page === 1 ? mapped : [...prev, ...mapped])
      setHasMore(page < data.totalPages)
    } catch { if (id === requestIdRef.current) { if (page === 1) setItems([]); setHasMore(false) } }
    finally { if (id === requestIdRef.current) { if (page === 1) setLoading(false); else setLoadingMore(false) } }
  }, [cmsMedia])

  // Reset state on open / tab switch
  useEffect(() => {
    if (!open) return
    setSelectedId(null)
    setSearchQuery("")
    setItems([])
    setUrlInput("")
    setUrlAltInput("")
    setGeneratePrompt("")
    setGeneratedResult(null)
    setChatId(null)
    setChatMessages([])
    setEditMode(hasEditableImage ? "choose" : "new")
    setUploadResult(null)
    setUploadPreview(null)
    setReferenceImages([])
    setCurrentPage(1)
    setHasMore(false)
    setLoadingMore(false)
    if (activeTab === "drive" && features.googleDrive) void fetchDriveImages()
    if ((activeTab === "contentful" || activeTab === "sanity" || activeTab === "strapi") && cmsMedia) void fetchCmsMediaAssets()
  }, [open, activeTab, features.googleDrive, cmsMedia, fetchDriveImages, fetchCmsMediaAssets])

  const handleSearchChange = (value: string) => {
    setSearchQuery(value)
    setCurrentPage(1)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => {
      if (activeTab === "drive") void fetchDriveImages(value || undefined)
      if (activeTab === "unsplash") void fetchUnsplashImages(value || undefined, 1)
      if (activeTab === "contentful" || activeTab === "sanity" || activeTab === "strapi") void fetchCmsMediaAssets(value || undefined, 1)
    }, 400)
  }

  const handleGenerate = async () => {
    if (!generatePrompt.trim() || generating) return
    const userPrompt = generatePrompt.trim()
    setGenerating(true)
    setGenerateStatus("Generating image\u2026")

    // Use multi-turn chat endpoint with SSE streaming when available
    if (features.imageGenerateChat) {
      setChatMessages((prev) => [...prev, { role: "user", text: userPrompt }, { role: "assistant", text: "" }])
      setGeneratePrompt("")

      const scheduleScroll = () => {
        cancelAnimationFrame(scrollRafRef.current)
        scrollRafRef.current = requestAnimationFrame(() => {
          chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: "smooth" })
        })
      }

      const updateLastAssistant = (updater: (msg: ChatMessage) => ChatMessage) => {
        setChatMessages((prev) => {
          let idx = -1
          for (let i = prev.length - 1; i >= 0; i--) { if (prev[i].role === "assistant") { idx = i; break } }
          if (idx < 0) return prev
          const updated = [...prev]
          updated[idx] = updater(updated[idx])
          return updated
        })
      }

      try {
        const res = await fetch(`${orchestrator}/image/generate/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt: userPrompt, chatId: chatId ?? undefined, stream: true,
            ...(editMode === "edit" && hasEditableImage && currentUrl && !chatId ? { referenceImageUrl: currentUrl } : {}),
            ...(referenceImages.length > 0 && !chatId ? { referenceImageUrls: referenceImages.filter(r => r.url).map(r => r.url) } : {})
          })
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
                } else if (eventType === "status") {
                  setGenerateStatus(data.stage ?? "Generating image\u2026")
                } else if (eventType === "text") {
                  updateLastAssistant((msg) => ({ ...msg, text: msg.text + data.text }))
                } else if (eventType === "image") {
                  updateLastAssistant((msg) => ({ ...msg, imageUrl: data.url }))
                  setGeneratedResult({ url: data.url, alt: data.alt })
                }
              } catch { /* ignore parse errors */ }
              eventType = ""
            }
          }
          scheduleScroll()
        }
      } catch { /* ignore */ }
      finally { setGenerating(false); setGenerateStatus("") }
    } else {
      // Single-shot fallback (OpenAI / no chat)
      setGeneratedResult(null)
      try {
        const res = await fetch(`${orchestrator}/image/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: userPrompt })
        })
        if (!res.ok) return
        const data = (await res.json()) as { url: string; alt: string }
        setGeneratedResult(data)
      } catch { /* ignore */ }
      finally { setGenerating(false); setGenerateStatus("") }
    }
  }

  const MAX_REFERENCES = 14
  const effectiveMaxReferences = (editMode === "edit" && hasEditableImage) ? MAX_REFERENCES - 1 : MAX_REFERENCES

  const handleReferenceImageAdd = async (files: File[]) => {
    const remaining = effectiveMaxReferences - referenceImages.length
    const toProcess = files.filter(f => f.type.startsWith("image/") && f.size <= 5 * 1024 * 1024).slice(0, remaining)
    if (toProcess.length === 0) return

    // Add with local previews immediately
    const newEntries = toProcess.map(f => ({ url: "", thumbUrl: URL.createObjectURL(f), uploading: true, _file: f }))
    const startIdx = referenceImages.length
    setReferenceImages(prev => [...prev, ...newEntries.map(({ _file: _, ...e }) => e)])

    // Upload each in parallel
    await Promise.allSettled(newEntries.map(async (entry, i) => {
      const form = new FormData()
      form.append("image", entry._file)
      const res = await fetch(`${orchestrator}/image/upload`, { method: "POST", body: form })
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
      const data = (await res.json()) as { url: string }
      setReferenceImages(prev => prev.map((r, ri) => ri === startIdx + i ? { ...r, url: data.url, uploading: false } : r))
    }))
  }

  const handleRefImageInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length > 0) void handleReferenceImageAdd(files)
    e.target.value = ""
  }

  const handleRefDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/"))
    if (files.length > 0) void handleReferenceImageAdd(files)
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    // Show local preview immediately
    const localUrl = URL.createObjectURL(file)
    setUploadPreview(localUrl)
    setUploading(true)
    setUploadResult(null)
    try {
      const form = new FormData()
      form.append("image", file)
      const res = await fetch(`${orchestrator}/image/upload`, { method: "POST", body: form })
      if (!res.ok) return
      const data = (await res.json()) as { url: string }
      setUploadResult(data)
    } catch { /* ignore */ }
    finally { setUploading(false) }
  }

  const handleSelect = () => {
    if (activeTab === "upload") {
      // URL input or file upload
      if (uploadResult) {
        onSelect(uploadResult.url, t("imagePicker.uploadedImage"))
      } else if (urlInput.trim()) {
        onSelect(urlInput.trim(), urlAltInput.trim() || "Image")
      } else {
        return
      }
    } else if (activeTab === "generate" && generatedResult) {
      onSelect(generatedResult.url, generatedResult.alt)
    } else {
      const item = items.find((i) => i.id === selectedId)
      if (!item) return
      const url = item.imageUrl ?? ""
      // Use || (not ??) so empty-string alt falls back — empty alt causes schema validation failure
      const alt = item.alt || item.name?.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ") || "Image"
      onSelect(url, alt)
    }
    onClose()
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (lightboxUrl) { setLightboxUrl(null); setLightboxShowOriginal(false); e.stopPropagation() }
        else onClose()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose, lightboxUrl])

  if (!open) return null

  const tabConfig: Record<Tab, { label: string; icon: React.ReactNode; searchPlaceholder?: string }> = {
    drive: { label: t("imagePicker.drive"), icon: <HardDrive size={14} />, searchPlaceholder: t("imagePicker.searchDrive") },
    unsplash: { label: t("imagePicker.unsplash"), icon: <ImageIcon size={14} />, searchPlaceholder: t("imagePicker.searchUnsplash") },
    contentful: { label: t("imagePicker.contentful"), icon: <Cloud size={14} />, searchPlaceholder: t("imagePicker.searchContentful") },
    sanity: { label: t("imagePicker.sanity"), icon: <Cloud size={14} />, searchPlaceholder: t("imagePicker.searchSanity") },
    strapi: { label: t("imagePicker.strapi"), icon: <Cloud size={14} />, searchPlaceholder: t("imagePicker.searchStrapi") },
    upload: { label: t("imagePicker.upload"), icon: <Upload size={14} /> },
    generate: { label: t("imagePicker.generate"), icon: <Sparkles size={14} /> }
  }

  const canSubmit =
    activeTab === "upload" ? Boolean(uploadResult) || urlInput.trim().length > 0
    : activeTab === "generate" ? Boolean(generatedResult)
    : Boolean(selectedId)

  const isCmsTab = activeTab === "contentful" || activeTab === "sanity" || activeTab === "strapi"
  const isGridTab = activeTab === "drive" || activeTab === "unsplash" || isCmsTab

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <style>{`@keyframes imgPickerDotBounce { 0%,60%,100% { opacity: 0.3; transform: scale(0.8); } 30% { opacity: 1; transform: scale(1); } }
.imgpicker-zoom-wrap .imgpicker-zoom-icon { opacity: 0; transition: opacity 0.15s; }
.imgpicker-zoom-wrap:hover .imgpicker-zoom-icon { opacity: 1; }
.imgpicker-zoom-wrap:hover img { filter: brightness(0.7); }`}</style>
        {/* Header row: title + current image + close */}
        <div style={S.header}>
          <div style={S.headerLeft}>
            <span style={S.title}>{t("imagePicker.title")}</span>
          </div>
          <button onClick={onClose} style={S.closeBtn} aria-label={t("imagePicker.close")}><X size={18} /></button>
        </div>

        {/* Tabs */}
        <div style={S.tabs}>
          {availableTabs.map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              style={{ ...S.tab, ...(activeTab === tab ? S.tabActive : {}) }}>
              {tabConfig[tab].icon}
              {tabConfig[tab].label}
            </button>
          ))}
        </div>

        {/* ---- Grid tabs: Drive / Unsplash ---- */}
        {isGridTab && (
          <>
            <div style={S.searchBar}>
              <Search size={15} style={{ color: "#88a1c6", flexShrink: 0 }} />
              <input
                type="text"
                placeholder={tabConfig[activeTab].searchPlaceholder ?? t("imagePicker.search")}
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
                style={S.searchInput}
                autoFocus
              />
              {activeTab === "drive" && (
                <button
                  onClick={() => void fetchDriveImages(searchQuery || undefined, true)}
                  disabled={loading}
                  style={S.refreshBtn}
                  aria-label={t("imagePicker.refreshDrive")}
                  title={t("imagePicker.refreshDrive")}
                >
                  <RefreshCw size={14} />
                </button>
              )}
            </div>
            <div style={S.gridScroll}>
              {loading && <div style={S.status}>{t("imagePicker.searching")}</div>}
              {!loading && items.length === 0 && (
                <div style={S.status}>
                  {activeTab === "unsplash" && !searchQuery ? t("imagePicker.typeToSearch") : t("imagePicker.noImages")}
                </div>
              )}
              <div style={S.grid}>
                {items.map((item) => (
                  <button key={item.id} onClick={() => setSelectedId(item.id)}
                    style={{ ...S.card, ...(selectedId === item.id ? S.cardSelected : {}) }}>
                    <img src={item.thumbUrl} alt={item.alt ?? ""} style={S.cardImg} loading="lazy" />
                    <span style={S.cardLabel}>{item.alt || item.name || ""}</span>
                  </button>
                ))}
              </div>
              {(activeTab === "unsplash" || isCmsTab) && hasMore && items.length > 0 && !loading && !loadingMore && (
                <div style={S.loadMoreRow}>
                  <button
                    style={S.loadMoreBtn}
                    onClick={() => {
                      const next = currentPage + 1
                      setCurrentPage(next)
                      if (isCmsTab) void fetchCmsMediaAssets(searchQuery || undefined, next)
                      else void fetchUnsplashImages(searchQuery || undefined, next)
                    }}
                  >
                    {t("imagePicker.loadMore")}
                  </button>
                </div>
              )}
              {loadingMore && (
                <div style={S.loadMoreRow}>
                  <span style={{ fontSize: 13, color: "#9cb2d0" }}>{t("imagePicker.loading")}</span>
                </div>
              )}
            </div>
          </>
        )}

        {/* ---- Upload tab (file + URL merged) ---- */}
        {activeTab === "upload" && (
          <div style={S.formArea}>
            {/* File upload section */}
            <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={handleFileSelect} style={{ display: "none" }} />
            <button onClick={() => fileInputRef.current?.click()} style={S.uploadBtn} disabled={uploading}>
              <Upload size={18} />
              {uploading ? t("imagePicker.uploading") : uploadPreview ? t("imagePicker.chooseDifferent") : t("imagePicker.uploadFromComputer")}
            </button>

            {uploadPreview && (
              <div style={S.previewRow}>
                <img src={uploadResult?.url ?? uploadPreview} alt="" style={S.previewImg} />
                {uploading && <span style={S.previewLabel}>{t("imagePicker.uploading")}</span>}
                {uploadResult && <span style={{ ...S.previewLabel, color: "#4ade80" }}>{t("imagePicker.ready")}</span>}
              </div>
            )}

            {/* Divider */}
            <div style={S.divider}><span style={S.dividerText}>{t("imagePicker.orPasteUrl")}</span></div>

            {/* URL input */}
            <input
              type="text"
              placeholder={t("imagePicker.urlPlaceholder")}
              value={urlInput}
              onChange={(e) => { setUrlInput(e.target.value); setUploadResult(null); setUploadPreview(null) }}
              style={S.input}
            />
          </div>
        )}

        {/* ---- Generate tab ---- */}
        {activeTab === "generate" && (
          <div
            style={{ ...S.formArea, display: "flex", flexDirection: "column", flex: features.imageGenerateChat ? "1 1 0" : undefined, minHeight: 0 }}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy" }}
            onDrop={handleRefDrop}
          >
            {/* Choice: edit existing or generate new */}
            {features.imageGenerateChat && hasEditableImage && editMode === "choose" && chatMessages.length === 0 && (
              <div style={S.editChoiceContainer}>
                <button style={S.editChoiceCard} onClick={() => setEditMode("edit")}>
                  <img src={currentUrl} alt="" style={S.editChoiceImg} />
                  <span style={S.editChoiceTitle}>{t("imagePicker.editThisImage")}</span>
                  <span style={S.editChoiceDesc}>{t("imagePicker.editThisImageDesc")}</span>
                </button>
                <button style={S.editChoiceCard} onClick={() => setEditMode("new")}>
                  <div style={S.editChoiceNewIcon}><Sparkles size={24} /></div>
                  <span style={S.editChoiceTitle}>{t("imagePicker.generateNew")}</span>
                  <span style={S.editChoiceDesc}>{t("imagePicker.generateNewDesc")}</span>
                </button>
              </div>
            )}

            {/* Edit mode: show current image as reference */}
            {features.imageGenerateChat && hasEditableImage && editMode === "edit" && chatMessages.length === 0 && (
              <div style={S.editContext}>
                <div className="imgpicker-zoom-wrap" style={S.zoomWrap} onClick={() => setLightboxUrl(currentUrl!)}>
                  <img src={currentUrl} alt="" style={S.editContextImg} />
                  <div className="imgpicker-zoom-icon" style={S.zoomIcon}><ZoomIn size={20} /></div>
                </div>
              </div>
            )}

            {/* Multi-turn chat history */}
            {features.imageGenerateChat && chatMessages.length > 0 && (
              <div ref={chatScrollRef} style={S.chatScroll}>
                {chatMessages.map((msg, i) => {
                  const isLastAssistant = generating && msg.role === "assistant" && i === chatMessages.length - 1
                  return (
                    <div key={i} style={msg.role === "user" ? S.chatBubbleUser : S.chatBubbleAssistant}>
                      {msg.text && <span style={S.chatText}>{msg.text}</span>}
                      {msg.imageUrl && (
                        <div style={S.chatImageRow}>
                          <div className="imgpicker-zoom-wrap" style={S.zoomWrap} onClick={() => setLightboxUrl(msg.imageUrl!)}>
                            <img src={msg.imageUrl} alt="" style={S.chatImage} />
                            <div className="imgpicker-zoom-icon" style={S.zoomIcon}><ZoomIn size={20} /></div>
                          </div>
                          {generatedResult && msg.imageUrl === generatedResult.url && !generating && (
                            <button onClick={handleSelect} style={S.useImageBeside}>{t("imagePicker.useImage")}</button>
                          )}
                        </div>
                      )}
                      {isLastAssistant && (
                        <div style={S.generatingRow}>
                          <span style={S.typingDots}>
                            <span style={{ ...S.dot, animationDelay: "0s" }} />
                            <span style={{ ...S.dot, animationDelay: "0.2s" }} />
                            <span style={{ ...S.dot, animationDelay: "0.4s" }} />
                          </span>
                          <span style={S.generatingLabel}>{generateStatus}</span>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* Single-shot: show preview below textarea */}
            {!features.imageGenerateChat && generatedResult && (
              <div style={S.previewRow}>
                <img src={generatedResult.url} alt={generatedResult.alt} style={S.previewImg} />
              </div>
            )}

            {/* Prompt input — hidden during choice screen */}
            {!(hasEditableImage && editMode === "choose" && features.imageGenerateChat && chatMessages.length === 0) && (
            <div style={S.chatInputArea}>
              {/* Reference images strip */}
              {referenceImages.length > 0 && (
                <div style={S.refStrip}>
                  {referenceImages.map((ref, i) => (
                    <div key={i} style={S.refThumb}>
                      <img src={ref.thumbUrl} alt="" style={S.refThumbImg} />
                      {ref.uploading && <div style={S.refUploading} />}
                      {!chatId && (
                        <button
                          style={S.refRemoveBtn}
                          onClick={() => setReferenceImages(prev => prev.filter((_, ri) => ri !== i))}
                          aria-label={t("imagePicker.removeReference")}
                        ><X size={10} /></button>
                      )}
                    </div>
                  ))}
                  {!chatId && referenceImages.length < effectiveMaxReferences && (
                    <button style={S.refAddBtn} onClick={() => refImageInputRef.current?.click()}>+</button>
                  )}
                  <span style={S.refCount}>{referenceImages.length}/{effectiveMaxReferences}</span>
                </div>
              )}
              <input ref={refImageInputRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={handleRefImageInput} />
              <div style={S.chatInputRow}>
                <textarea
                  placeholder={chatMessages.length > 0
                    ? t("imagePicker.examplePrompt")
                    : editMode === "edit"
                      ? t("imagePicker.edit")
                      : t("imagePicker.examplePrompt")}
                  value={generatePrompt}
                  onChange={(e) => {
                    setGeneratePrompt(e.target.value)
                    e.target.style.height = "auto"
                    e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleGenerate() } }}
                  style={S.textarea}
                  rows={1}
                  autoFocus
                />
                {!chatId && (
                  <button
                    style={{ ...S.attachBtn, ...(referenceImages.length >= effectiveMaxReferences ? S.disabled : {}) }}
                    onClick={() => refImageInputRef.current?.click()}
                    disabled={referenceImages.length >= effectiveMaxReferences}
                    title={t("imagePicker.attachReference", { max: String(effectiveMaxReferences) })}
                  ><Paperclip size={15} /></button>
                )}
                <button
                  onClick={handleGenerate}
                  disabled={!generatePrompt.trim() || generating}
                  style={{ ...S.generateBtn, ...(!generatePrompt.trim() || generating ? S.disabled : {}) }}>
                  <Sparkles size={15} />
                  {generating ? "..." : chatMessages.length > 0 ? t("imagePicker.refine") : editMode === "edit" ? t("imagePicker.edit") : t("imagePicker.generate")}
                </button>
              </div>
            </div>
            )}
          </div>
        )}

        {/* Footer — hidden on generate+chat tab (Use image is inline there) */}
        {!(activeTab === "generate" && features.imageGenerateChat) && (
        <div style={S.footer}>
          <button onClick={handleSelect} disabled={!canSubmit}
            style={{ ...S.submitBtn, ...(canSubmit ? {} : S.disabled) }}>
            {activeTab === "upload" && urlInput.trim() && !uploadResult ? t("imagePicker.applyUrl") : t("imagePicker.useImage")}
          </button>
        </div>
        )}

        {/* Lightbox */}
        {lightboxUrl && (
          <div style={S.lightboxOverlay} onClick={() => { setLightboxUrl(null); setLightboxShowOriginal(false) }}>
            <button onClick={() => { setLightboxUrl(null); setLightboxShowOriginal(false) }} style={S.lightboxClose} aria-label={t("imagePicker.closePreview")}><X size={20} /></button>
            <img src={lightboxShowOriginal && currentUrl ? currentUrl : lightboxUrl} alt="" style={S.lightboxImg} onClick={(e) => e.stopPropagation()} />
            {editMode === "edit" && hasEditableImage && currentUrl && lightboxUrl !== currentUrl && (
              <button
                onClick={(e) => { e.stopPropagation(); setLightboxShowOriginal(prev => !prev) }}
                style={S.lightboxToggleOriginal}
              >
                <Eye size={15} />
                {lightboxShowOriginal ? t("imagePicker.showEdited") : t("imagePicker.showOriginal")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const S: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed", inset: 0, background: "rgba(2, 6, 14, 0.72)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999
  },
  modal: {
    background: "linear-gradient(180deg, #1a2740 0%, #15233a 45%, #111c31 100%)",
    borderRadius: 14, width: 640, maxWidth: "92vw", height: "80vh",
    display: "flex", flexDirection: "column", color: "#e7eefb",
    boxShadow: "0 28px 64px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(145, 170, 210, 0.24)"
  },
  header: {
    display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 20px 6px"
  },
  headerLeft: {
    display: "flex", alignItems: "center", gap: 14
  },
  title: { fontWeight: 600, fontSize: 17, color: "#f2f7ff" },
  closeBtn: {
    background: "none", border: "none", color: "#9db1cd", cursor: "pointer",
    padding: 6, borderRadius: 6, display: "flex"
  },

  // Tabs
  tabs: { display: "flex", gap: 6, padding: "10px 20px 14px" },
  tab: {
    display: "inline-flex", alignItems: "center", gap: 6,
    background: "rgba(9, 17, 31, 0.35)", border: "1px solid #375071", borderRadius: 8,
    padding: "8px 16px", color: "#9db1cc", fontSize: 13, cursor: "pointer",
    fontWeight: 500, transition: "all .15s"
  },
  tabActive: { background: "#304a71", color: "#f4f8ff", border: "1px solid #8daede", boxShadow: "inset 0 0 0 1px rgba(173, 201, 239, 0.2)" },

  // Search
  searchBar: {
    display: "flex", alignItems: "center", gap: 8, margin: "0 20px 10px",
    padding: "9px 12px", background: "#0b1425", borderRadius: 10, border: "1px solid #2b4161"
  },
  searchInput: {
    flex: 1, background: "transparent", border: "none", outline: "none",
    color: "#edf4ff", fontSize: 14
  },
  refreshBtn: {
    background: "none", border: "none", color: "#8fa6c9", cursor: "pointer",
    padding: 4, borderRadius: 6, display: "flex", flexShrink: 0,
    transition: "color .15s"
  },

  // Grid
  gridScroll: {
    flex: "1 1 0", overflow: "hidden auto", padding: "0 20px 4px",
    minHeight: 0
  },
  grid: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 },
  card: {
    background: "#0d182d", border: "2px solid transparent", borderRadius: 10,
    padding: 0, cursor: "pointer", display: "flex", flexDirection: "column",
    overflow: "hidden", textAlign: "left"
  },
  cardSelected: { border: "2px solid #63a4ff", boxShadow: "0 0 0 1px #63a4ff, 0 8px 20px rgba(38, 116, 230, 0.35)" },
  cardImg: { width: "100%", aspectRatio: "4/3", objectFit: "cover" },
  cardLabel: {
    fontSize: 11, color: "#afc2de", padding: "5px 6px", lineHeight: 1.35,
    overflow: "hidden", display: "-webkit-box",
    WebkitLineClamp: 2, WebkitBoxOrient: "vertical"
  },

  status: { padding: "48px 0", textAlign: "center", color: "#7f95b8", fontSize: 14 },
  loadMoreRow: { display: "flex", justifyContent: "center", padding: "12px 0 4px" },
  loadMoreBtn: {
    background: "#2c456a", color: "#eff5ff", border: "1px solid #5e7eac", borderRadius: 8,
    padding: "8px 24px", fontSize: 13, fontWeight: 500, cursor: "pointer"
  },

  // Form area (upload / generate)
  formArea: { padding: "4px 20px 8px" },
  input: {
    width: "100%", padding: "10px 12px", background: "#0b1425",
    border: "1px solid #355073", borderRadius: 10, color: "#edf4ff",
    fontSize: 14, outline: "none", boxSizing: "border-box"
  },
  textarea: {
    width: "100%", padding: "8px 12px", background: "#0b1425",
    border: "1px solid #355073", borderRadius: 10, color: "#edf4ff",
    fontSize: 14, outline: "none", boxSizing: "border-box", resize: "none" as const, overflow: "hidden",
    fontFamily: "inherit"
  },

  uploadBtn: {
    display: "flex", alignItems: "center", gap: 8, width: "100%",
    justifyContent: "center", padding: "14px 20px", background: "transparent",
    color: "#afc2de", border: "2px dashed #3f5f88", borderRadius: 12,
    fontSize: 14, cursor: "pointer", transition: "border-color .15s"
  },

  divider: {
    display: "flex", alignItems: "center", gap: 12, margin: "16px 0",
    color: "#7389aa", fontSize: 12
  },
  dividerText: {
    flex: "none", padding: "0 4px"
  },

  previewRow: {
    display: "flex", alignItems: "center", gap: 12, marginTop: 14,
    padding: 10, background: "#0b1425", borderRadius: 10, border: "1px solid #304a6b"
  },
  previewImg: {
    width: 120, height: 80, objectFit: "cover", borderRadius: 8, flexShrink: 0
  },
  previewLabel: { fontSize: 13, color: "#afc2de" },

  editChoiceContainer: {
    display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12
  },
  editChoiceCard: {
    display: "flex", flexDirection: "column" as const, alignItems: "center", gap: 8,
    padding: "20px 16px", background: "#0d182d", border: "1px solid #304a6b",
    borderRadius: 12, cursor: "pointer", color: "#e0ecff", textAlign: "center" as const,
    transition: "border-color .15s, background .15s"
  },
  editChoiceImg: {
    width: 80, height: 56, objectFit: "cover" as const, borderRadius: 8
  },
  editChoiceNewIcon: {
    width: 80, height: 56, display: "flex", alignItems: "center", justifyContent: "center",
    background: "#1a2d4a", borderRadius: 8, color: "#6fa8f2"
  },
  editChoiceTitle: {
    fontSize: 14, fontWeight: 600, color: "#f2f7ff"
  },
  editChoiceDesc: {
    fontSize: 12, color: "#8fa6c9", lineHeight: 1.35
  },
  editContext: {
    display: "flex", alignItems: "center", gap: 14, padding: 12,
    background: "#0d182d", borderRadius: 10, border: "1px solid #304a6b",
    marginBottom: 16
  },
  editContextImg: {
    width: 240, height: 160, objectFit: "cover" as const, borderRadius: 8, flexShrink: 0,
    transition: "filter 0.15s"
  },
  zoomWrap: {
    position: "relative" as const, display: "inline-block", cursor: "pointer", borderRadius: 8,
    overflow: "hidden"
  },
  zoomIcon: {
    position: "absolute" as const, inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
    color: "white", pointerEvents: "none" as const
  },
  lightboxOverlay: {
    position: "fixed" as const, inset: 0, background: "rgba(0,0,0,0.8)",
    display: "flex", alignItems: "center", justifyContent: "center",
    zIndex: 10000, cursor: "zoom-out"
  },
  lightboxImg: {
    maxWidth: "90%", maxHeight: "90%", borderRadius: 8, objectFit: "contain" as const,
    cursor: "default"
  },
  lightboxClose: {
    position: "absolute" as const, top: 16, right: 16,
    background: "rgba(255,255,255,0.15)", border: "none", borderRadius: "50%",
    width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center",
    color: "white", cursor: "pointer"
  },
  lightboxToggleOriginal: {
    position: "absolute" as const, bottom: 24, left: "50%", transform: "translateX(-50%)",
    background: "rgba(255,255,255,0.15)", border: "none", borderRadius: 20,
    padding: "8px 18px", display: "flex", alignItems: "center", gap: 7,
    color: "white", fontSize: 13, fontWeight: 500, cursor: "pointer",
    whiteSpace: "nowrap" as const, backdropFilter: "blur(8px)"
  },
  editContextLabel: {
    fontSize: 13, color: "#8fa6c9", lineHeight: 1.4
  },
  chatInputArea: {
    flexShrink: 0, display: "flex", flexDirection: "column" as const, gap: 8,
    paddingTop: 10, paddingBottom: 14
  },
  chatInputRow: {
    display: "flex", gap: 8, alignItems: "center"
  },
  chatScroll: {
    flex: "1 1 0", minHeight: 0, overflowY: "auto" as const,
    display: "flex", flexDirection: "column" as const, gap: 8,
    padding: "4px 0"
  },
  chatBubbleUser: {
    alignSelf: "flex-end", maxWidth: "80%",
    background: "#2a4a75", borderRadius: "12px 12px 4px 12px",
    padding: "8px 12px", fontSize: 13, color: "#e0ecff"
  },
  chatBubbleAssistant: {
    alignSelf: "flex-start", maxWidth: "85%",
    background: "#0d182d", borderRadius: "12px 12px 12px 4px",
    padding: "8px 12px", fontSize: 13, color: "#c8d9f0",
    display: "flex", flexDirection: "column" as const, gap: 8
  },
  chatText: { lineHeight: 1.45 },
  generatingRow: {
    display: "flex", alignItems: "center", gap: 8
  },
  generatingLabel: {
    fontSize: 13, color: "#9cb2d0", fontStyle: "italic" as const
  },
  typingDots: {
    display: "inline-flex", gap: 4, alignItems: "center", padding: "4px 0"
  },
  dot: {
    width: 8, height: 8, borderRadius: "50%", background: "#6fa8f2",
    animation: "imgPickerDotBounce 1.2s ease-in-out infinite"
  },
  chatImage: {
    width: "100%", maxWidth: 320, borderRadius: 8, marginTop: 4
  },
  chatImageRow: {
    display: "flex", alignItems: "flex-end", gap: 10, marginTop: 4
  },
  useImageBeside: {
    background: "#346ec2", color: "white",
    border: "1px solid #5f90da", borderRadius: 10,
    padding: "9px 20px", fontSize: 13, fontWeight: 500, cursor: "pointer",
    whiteSpace: "nowrap" as const, flexShrink: 0
  },
  generateBtn: {
    display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0,
    height: 36, padding: "0 14px", background: "#2f79dc", color: "white",
    border: "1px solid #6fa8f2", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer"
  },
  attachBtn: {
    display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
    width: 36, height: 36, background: "none", border: "1px solid #3f5f88",
    borderRadius: 8, color: "#8fa6c9", cursor: "pointer", padding: 0
  },
  refStrip: {
    display: "flex", alignItems: "center", gap: 6, overflowX: "auto" as const,
    paddingBottom: 6
  },
  refThumb: {
    position: "relative" as const, width: 44, height: 44, flexShrink: 0, borderRadius: 6,
    overflow: "hidden"
  },
  refThumbImg: {
    width: "100%", height: "100%", objectFit: "cover" as const, display: "block"
  },
  refRemoveBtn: {
    position: "absolute" as const, top: 2, right: 2,
    width: 16, height: 16, padding: 0, border: "none",
    borderRadius: "50%", background: "rgba(0,0,0,0.6)", color: "white",
    display: "flex", alignItems: "center", justifyContent: "center",
    cursor: "pointer", fontSize: 10, lineHeight: 1
  },
  refUploading: {
    position: "absolute" as const, inset: 0, background: "rgba(0,0,0,0.4)",
    display: "flex", alignItems: "center", justifyContent: "center",
    borderRadius: 6
  },
  refAddBtn: {
    width: 44, height: 44, flexShrink: 0, borderRadius: 6,
    border: "1px dashed #3f5f88", background: "none", color: "#8fa6c9",
    cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center"
  },
  refCount: {
    fontSize: 11, color: "#7389aa", whiteSpace: "nowrap" as const, marginLeft: 4, flexShrink: 0
  },

  // Footer
  footer: { padding: "10px 20px 18px", display: "flex", justifyContent: "flex-end" },
  submitBtn: {
    background: "#346ec2", color: "white", border: "1px solid #5f90da", borderRadius: 10,
    padding: "10px 28px", fontSize: 14, fontWeight: 500, cursor: "pointer"
  },
  disabled: { opacity: 0.4, cursor: "not-allowed" }
}
