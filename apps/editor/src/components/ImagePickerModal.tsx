import React, { useCallback, useEffect, useRef, useState } from "react"
import { X, Search, Upload, Sparkles, HardDrive, Image as ImageIcon, RefreshCw, Cloud, ZoomIn, Eye } from "lucide-react"
import { ImageGenerateChat } from "./ImageGenerateChat"
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

/** Detect the aspect ratio of an image URL. Returns a Gemini-compatible ratio string (e.g. "3:2"). */
function detectImageAspectRatio(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const w = img.naturalWidth; const h = img.naturalHeight
      if (!w || !h) { resolve(null); return }
      const ratio = w / h
      // Map to closest Gemini-supported ratio
      const candidates: [string, number][] = [["1:1", 1], ["3:2", 1.5], ["2:3", 2/3], ["16:9", 16/9], ["9:16", 9/16]]
      let best = "3:2"; let bestDist = Infinity
      for (const [name, target] of candidates) {
        const dist = Math.abs(ratio - target)
        if (dist < bestDist) { bestDist = dist; best = name }
      }
      resolve(best)
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

export function ImagePickerModal({ open, features, currentUrl: rawCurrentUrl, gdriveFolderId, cmsMedia, siteOrigin, onClose, onSelect }: ImagePickerModalProps) {
  const { t } = useT()
  const currentUrl = resolveImageUrl(unwrapNextImageUrl(rawCurrentUrl), siteOrigin)
  const hasEditableImage = !isImagePlaceholder(currentUrl)
  const availableTabs: Tab[] = []
  if (features.imageGenerate) availableTabs.push("generate")
  if (features.googleDrive) availableTabs.push("drive")
  if (features.unsplash) availableTabs.push("unsplash")
  if (cmsMedia?.provider === "contentful") availableTabs.push("contentful")
  if (cmsMedia?.provider === "sanity") availableTabs.push("sanity")
  if (cmsMedia?.provider === "strapi") availableTabs.push("strapi")
  availableTabs.push("upload")

  const [activeTab, setActiveTab] = useState<Tab>(availableTabs[0])
  const [searchQuery, setSearchQuery] = useState("")
  const [items, setItems] = useState<ImageItem[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [urlInput, setUrlInput] = useState("")
  const [urlAltInput, setUrlAltInput] = useState("")
  const [generatePrompt, setGeneratePrompt] = useState("")
  const [generating, setGenerating] = useState(false)
  const [generatedResult, setGeneratedResult] = useState<{ url: string; alt: string } | null>(null)
  const [editMode, setEditMode] = useState<"choose" | "edit" | "new">(hasEditableImage ? "choose" : "new")
  const [uploadPreview, setUploadPreview] = useState<string | null>(null)
  const [uploadResult, setUploadResult] = useState<{ url: string } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)
  const [lightboxShowOriginal, setLightboxShowOriginal] = useState(false)
  const [detectedAspectRatio, setDetectedAspectRatio] = useState<string | null>(null)
  const [referenceImages, setReferenceImages] = useState<Array<{ url: string; thumbUrl: string; uploading?: boolean }>>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const refImageInputRef = useRef<HTMLInputElement>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestIdRef = useRef(0)
  const modalRef = useRef<HTMLDivElement>(null)

  // Blur any element outside the modal (e.g. main chat textarea) to prevent
  // its cursor from blinking behind the semi-transparent overlay.
  useEffect(() => {
    if (open) {
      const active = document.activeElement as HTMLElement | null
      if (active && active !== document.body && modalRef.current && !modalRef.current.contains(active)) {
        active.blur()
      }
    }
  }, [open])

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

  // Reset state when the modal opens
  useEffect(() => {
    if (!open) return
    setSelectedId(null)
    setSearchQuery("")
    setItems([])
    setUrlInput("")
    setUrlAltInput("")
    setGeneratePrompt("")
    setGeneratedResult(null)
    setEditMode(hasEditableImage ? "choose" : "new")
    setActiveTab(availableTabs[0])
    setUploadResult(null)
    setUploadPreview(null)
    setReferenceImages([])
    setDetectedAspectRatio(null)
    setCurrentPage(1)
    setHasMore(false)
    setLoadingMore(false)
    // Detect aspect ratio from the current image so generated images match
    if (hasEditableImage && currentUrl) {
      void detectImageAspectRatio(currentUrl).then(r => { if (r) setDetectedAspectRatio(r) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Fetch tab-specific data when the active tab changes
  useEffect(() => {
    if (!open) return
    setItems([])
    setCurrentPage(1)
    setHasMore(false)
    if (activeTab === "drive" && features.googleDrive) void fetchDriveImages()
    else if (activeTab === "unsplash" && features.unsplash && searchQuery) void fetchUnsplashImages(searchQuery, 1)
    else if ((activeTab === "contentful" || activeTab === "sanity" || activeTab === "strapi") && cmsMedia) void fetchCmsMediaAssets()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeTab, features.googleDrive, features.unsplash, cmsMedia, fetchDriveImages, fetchUnsplashImages, fetchCmsMediaAssets])

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

  // Single-shot fallback (when Gemini chat is not available)
  const handleGenerate = async () => {
    if (!generatePrompt.trim() || generating) return
    const userPrompt = generatePrompt.trim()
    setGenerating(true)
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
    finally { setGenerating(false) }
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
      <div ref={modalRef} style={S.modal} onClick={(e) => e.stopPropagation()}>
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

        {/* ---- Generate tab (assistant-ui powered) ---- */}
        {activeTab === "generate" && features.imageGenerateChat && (
          <ImageGenerateChat
            currentUrl={currentUrl}
            hasEditableImage={hasEditableImage}
            editMode={editMode}
            setEditMode={setEditMode}
            referenceImages={referenceImages}
            setReferenceImages={setReferenceImages}
            detectedAspectRatio={detectedAspectRatio}
            setDetectedAspectRatio={setDetectedAspectRatio}
            onSelect={(url, alt) => { onSelect(url, alt); onClose() }}
            onLightbox={setLightboxUrl}
            refImageInputRef={refImageInputRef}
            effectiveMaxReferences={effectiveMaxReferences}
            handleRefImageInput={handleRefImageInput}
            handleRefDrop={handleRefDrop}
          />
        )}
        {/* Single-shot fallback (no Gemini chat) */}
        {activeTab === "generate" && !features.imageGenerateChat && (
          <div style={S.formArea}>
            {generatedResult && (
              <div style={S.previewRow}>
                <img src={generatedResult.url} alt={generatedResult.alt} style={S.previewImg} />
              </div>
            )}
            <div style={S.chatInputArea}>
              <div style={S.chatInputRow}>
                <textarea
                  placeholder={t("imagePicker.examplePrompt")}
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
                <button
                  onClick={handleGenerate}
                  disabled={!generatePrompt.trim() || generating}
                  style={{ ...S.generateBtn, ...(!generatePrompt.trim() || generating ? S.disabled : {}) }}>
                  <Sparkles size={15} />
                  {generating ? "..." : t("imagePicker.generate")}
                </button>
              </div>
            </div>
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
  chatInputArea: {
    flexShrink: 0, display: "flex", flexDirection: "column" as const, gap: 8,
    paddingTop: 10, paddingBottom: 14
  },
  chatInputRow: {
    display: "flex", gap: 8, alignItems: "center"
  },
  generateBtn: {
    display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0,
    height: 36, padding: "0 14px", background: "#2f79dc", color: "white",
    border: "1px solid #6fa8f2", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer"
  },
  // Footer
  footer: { padding: "10px 20px 18px", display: "flex", justifyContent: "flex-end" },
  submitBtn: {
    background: "#346ec2", color: "white", border: "1px solid #5f90da", borderRadius: 10,
    padding: "10px 28px", fontSize: 14, fontWeight: 500, cursor: "pointer"
  },
  disabled: { opacity: 0.4, cursor: "not-allowed" }
}
