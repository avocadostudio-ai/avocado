import React, { useCallback, useEffect, useRef, useState } from "react"
import { X, Search, Upload, Sparkles, HardDrive, Image as ImageIcon, RefreshCw, Cloud } from "lucide-react"
import { orchestrator } from "../lib/editor-utils"
import { fetchCmsMedia, getCmsMediaLabel, type CmsMediaItem } from "../lib/cms-media"
import type { CmsMediaConfig } from "../lib/editor-types"

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
}

type ImagePickerModalProps = {
  open: boolean
  features: Features
  currentUrl?: string
  gdriveFolderId?: string
  cmsMedia?: CmsMediaConfig
  onClose: () => void
  onSelect: (imageUrl: string, alt: string) => void
}

export function ImagePickerModal({ open, features, currentUrl, gdriveFolderId, cmsMedia, onClose, onSelect }: ImagePickerModalProps) {
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
  const [generatedResult, setGeneratedResult] = useState<{ url: string; alt: string } | null>(null)
  const [uploadPreview, setUploadPreview] = useState<string | null>(null)
  const [uploadResult, setUploadResult] = useState<{ url: string } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
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
    setUploadResult(null)
    setUploadPreview(null)
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
    setGenerating(true)
    setGeneratedResult(null)
    try {
      const res = await fetch(`${orchestrator}/image/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: generatePrompt.trim() })
      })
      if (!res.ok) return
      const data = (await res.json()) as { url: string; alt: string }
      setGeneratedResult(data)
    } catch { /* ignore */ }
    finally { setGenerating(false) }
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
        onSelect(uploadResult.url, "Uploaded image")
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
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null

  const tabConfig: Record<Tab, { label: string; icon: React.ReactNode; searchPlaceholder?: string }> = {
    drive: { label: "Drive", icon: <HardDrive size={14} />, searchPlaceholder: "Search Drive images..." },
    unsplash: { label: "Unsplash", icon: <ImageIcon size={14} />, searchPlaceholder: "Search Unsplash photos..." },
    contentful: { label: "Contentful", icon: <Cloud size={14} />, searchPlaceholder: "Search Contentful assets..." },
    sanity: { label: "Sanity", icon: <Cloud size={14} />, searchPlaceholder: "Search Sanity assets..." },
    strapi: { label: "Strapi", icon: <Cloud size={14} />, searchPlaceholder: "Search Strapi media..." },
    upload: { label: "Upload", icon: <Upload size={14} /> },
    generate: { label: "Generate", icon: <Sparkles size={14} /> }
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
        {/* Header row: title + current image + close */}
        <div style={S.header}>
          <div style={S.headerLeft}>
            <span style={S.title}>Asset Picker</span>
          </div>
          <button onClick={onClose} style={S.closeBtn} aria-label="Close"><X size={18} /></button>
        </div>

        {/* Tabs */}
        <div style={S.tabs}>
          {availableTabs.map((t) => (
            <button key={t} onClick={() => setActiveTab(t)}
              style={{ ...S.tab, ...(activeTab === t ? S.tabActive : {}) }}>
              {tabConfig[t].icon}
              {tabConfig[t].label}
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
                placeholder={tabConfig[activeTab].searchPlaceholder ?? "Search..."}
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
                  aria-label="Refresh"
                  title="Refresh from Drive"
                >
                  <RefreshCw size={14} />
                </button>
              )}
            </div>
            <div style={S.gridScroll}>
              {loading && <div style={S.status}>Searching...</div>}
              {!loading && items.length === 0 && (
                <div style={S.status}>
                  {activeTab === "unsplash" && !searchQuery ? "Type to search Unsplash" : "No images found"}
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
                    Load more
                  </button>
                </div>
              )}
              {loadingMore && (
                <div style={S.loadMoreRow}>
                  <span style={{ fontSize: 13, color: "#9cb2d0" }}>Loading...</span>
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
              {uploading ? "Uploading..." : uploadPreview ? "Choose different file" : "Upload from computer"}
            </button>

            {uploadPreview && (
              <div style={S.previewRow}>
                <img src={uploadResult?.url ?? uploadPreview} alt="" style={S.previewImg} />
                {uploading && <span style={S.previewLabel}>Uploading...</span>}
                {uploadResult && <span style={{ ...S.previewLabel, color: "#4ade80" }}>Ready</span>}
              </div>
            )}

            {/* Divider */}
            <div style={S.divider}><span style={S.dividerText}>or paste a URL</span></div>

            {/* URL input */}
            <input
              type="text"
              placeholder="https://example.com/image.jpg"
              value={urlInput}
              onChange={(e) => { setUrlInput(e.target.value); setUploadResult(null); setUploadPreview(null) }}
              style={S.input}
            />
          </div>
        )}

        {/* ---- Generate tab ---- */}
        {activeTab === "generate" && (
          <div style={S.formArea}>
            <textarea
              placeholder="Describe the image you want, e.g. 'A professional photo of a modern office with natural light'"
              value={generatePrompt}
              onChange={(e) => setGeneratePrompt(e.target.value)}
              style={S.textarea}
              rows={3}
              autoFocus
            />
            <button
              onClick={handleGenerate}
              disabled={!generatePrompt.trim() || generating}
              style={{ ...S.generateBtn, ...(!generatePrompt.trim() || generating ? S.disabled : {}) }}>
              <Sparkles size={15} />
              {generating ? "Generating..." : "Generate image"}
            </button>
            {generatedResult && (
              <div style={S.previewRow}>
                <img src={generatedResult.url} alt={generatedResult.alt} style={S.previewImg} />
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div style={S.footer}>
          <button onClick={handleSelect} disabled={!canSubmit}
            style={{ ...S.submitBtn, ...(canSubmit ? {} : S.disabled) }}>
            {activeTab === "upload" && urlInput.trim() && !uploadResult ? "Apply URL" : "Use image"}
          </button>
        </div>
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
  tabActive: { background: "#304a71", color: "#f4f8ff", borderColor: "#8daede", boxShadow: "inset 0 0 0 1px rgba(173, 201, 239, 0.2)" },

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
  cardSelected: { borderColor: "#63a4ff", boxShadow: "0 0 0 1px #63a4ff, 0 8px 20px rgba(38, 116, 230, 0.35)" },
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
    width: "100%", padding: "10px 12px", background: "#0b1425",
    border: "1px solid #355073", borderRadius: 10, color: "#edf4ff",
    fontSize: 14, outline: "none", boxSizing: "border-box",
    resize: "vertical", fontFamily: "inherit"
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

  generateBtn: {
    display: "inline-flex", alignItems: "center", gap: 6, marginTop: 10,
    padding: "9px 18px", background: "#2f79dc", color: "white",
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
