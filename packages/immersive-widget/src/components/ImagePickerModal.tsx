/**
 * Self-contained image picker modal for immersive mode.
 * Talks directly to the orchestrator for Unsplash search and image generation.
 * Tabs: Unsplash search | URL input | AI Generate
 */

import { useState, useEffect, useRef, useCallback } from "react"

type Tab = "unsplash" | "url" | "generate"

type ImageItem = {
  id: string
  imageUrl: string
  thumbUrl: string
  alt: string
  author?: string
}

export type ImagePickerTarget = {
  slug: string
  blockId: string
  editablePath: string
  currentUrl?: string
}

type ImagePickerModalProps = {
  target: ImagePickerTarget | null
  orchestratorUrl: string
  accessToken?: string
  onSelect: (imageUrl: string, alt: string) => void
  onClose: () => void
}

const CloseIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m7 7 10 10" /><path d="M17 7 7 17" />
  </svg>
)

const SearchIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
  </svg>
)

const SparkleIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
  </svg>
)

const LinkIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
)

export function ImagePickerModal({ target, orchestratorUrl, accessToken, onSelect, onClose }: ImagePickerModalProps) {
  const open = target !== null
  const [tab, setTab] = useState<Tab>("unsplash")
  const [unsplashQuery, setUnsplashQuery] = useState("")
  const [unsplashResults, setUnsplashResults] = useState<ImageItem[]>([])
  const [unsplashLoading, setUnsplashLoading] = useState(false)
  const [unsplashError, setUnsplashError] = useState<string | null>(null)
  const [urlInput, setUrlInput] = useState("")
  const [generatePrompt, setGeneratePrompt] = useState("")
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setTab("unsplash")
      setUnsplashQuery("")
      setUnsplashResults([])
      setUnsplashError(null)
      setUrlInput(target?.currentUrl ?? "")
      setGeneratePrompt("")
      setGenerateError(null)
      setGeneratedUrl(null)
      setTimeout(() => searchInputRef.current?.focus(), 50)
    }
  }, [open])

  // Focus URL input when switching to URL tab
  useEffect(() => {
    if (tab === "url") {
      setTimeout(() => urlInputRef.current?.focus(), 50)
    }
  }, [tab])

  // Escape to close
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [open, onClose])

  const authHeaders = useCallback((): Record<string, string> => {
    return accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
  }, [accessToken])

  const searchUnsplash = useCallback(async (q: string) => {
    const query = q.trim()
    if (!query) { setUnsplashResults([]); return }
    setUnsplashLoading(true)
    setUnsplashError(null)
    try {
      const res = await fetch(`${orchestratorUrl}/unsplash/search?q=${encodeURIComponent(query)}&limit=12`, {
        headers: authHeaders(),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string }
        setUnsplashError(err.error ?? "Search failed")
        setUnsplashResults([])
        return
      }
      const data = await res.json() as { items?: ImageItem[] }
      setUnsplashResults(data.items ?? [])
    } catch {
      setUnsplashError("Search failed — check your connection")
      setUnsplashResults([])
    } finally {
      setUnsplashLoading(false)
    }
  }, [orchestratorUrl, authHeaders])

  const handleUnsplashSearch = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    void searchUnsplash(unsplashQuery)
  }, [unsplashQuery, searchUnsplash])

  const handleGenerate = useCallback(async () => {
    const prompt = generatePrompt.trim()
    if (!prompt) return
    setGenerating(true)
    setGenerateError(null)
    setGeneratedUrl(null)
    try {
      const res = await fetch(`${orchestratorUrl}/image/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ prompt }),
      })
      const data = await res.json() as { url?: string; error?: string }
      if (!res.ok || !data.url) {
        setGenerateError(data.error ?? "Generation failed")
        return
      }
      setGeneratedUrl(data.url)
    } catch {
      setGenerateError("Generation failed — check your connection")
    } finally {
      setGenerating(false)
    }
  }, [generatePrompt, orchestratorUrl, authHeaders])

  if (!open) return null

  return (
    <div
      className="iw-image-picker-overlay"
      data-editor-widget-ignore=""
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="iw-image-picker-modal">
        {/* Header */}
        <div className="iw-image-picker-header">
          <span className="iw-image-picker-title">Choose Image</span>
          <button type="button" className="iw-image-picker-close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        {/* Tabs */}
        <div className="iw-image-picker-tabs">
          <button
            type="button"
            className={`iw-image-picker-tab${tab === "unsplash" ? " active" : ""}`}
            onClick={() => setTab("unsplash")}
          >
            <SearchIcon /> Unsplash
          </button>
          <button
            type="button"
            className={`iw-image-picker-tab${tab === "generate" ? " active" : ""}`}
            onClick={() => setTab("generate")}
          >
            <SparkleIcon /> Generate
          </button>
          <button
            type="button"
            className={`iw-image-picker-tab${tab === "url" ? " active" : ""}`}
            onClick={() => setTab("url")}
          >
            <LinkIcon /> URL
          </button>
        </div>

        {/* Tab content */}
        <div className="iw-image-picker-body">
          {/* Unsplash tab */}
          {tab === "unsplash" && (
            <div className="iw-image-picker-tab-content">
              <form className="iw-image-picker-search-row" onSubmit={handleUnsplashSearch}>
                <input
                  ref={searchInputRef}
                  type="text"
                  className="iw-image-picker-input"
                  value={unsplashQuery}
                  onChange={(e) => setUnsplashQuery(e.target.value)}
                  placeholder="Search Unsplash..."
                />
                <button
                  type="submit"
                  className="iw-image-picker-btn-primary"
                  disabled={!unsplashQuery.trim() || unsplashLoading}
                >
                  {unsplashLoading ? "…" : "Search"}
                </button>
              </form>
              {unsplashError && <p className="iw-image-picker-error">{unsplashError}</p>}
              {!unsplashError && unsplashResults.length === 0 && !unsplashLoading && (
                <p className="iw-image-picker-hint">Type a keyword and press Search</p>
              )}
              {unsplashLoading && <p className="iw-image-picker-hint">Searching…</p>}
              {unsplashResults.length > 0 && (
                <div className="iw-image-picker-grid">
                  {unsplashResults.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="iw-image-picker-thumb"
                      onClick={() => onSelect(item.imageUrl, item.alt)}
                      title={item.alt || item.author || ""}
                    >
                      <img src={item.thumbUrl} alt={item.alt} loading="lazy" />
                      {item.author && <span className="iw-image-picker-author">{item.author}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Generate tab */}
          {tab === "generate" && (
            <div className="iw-image-picker-tab-content">
              <div className="iw-image-picker-search-row">
                <input
                  type="text"
                  className="iw-image-picker-input"
                  value={generatePrompt}
                  onChange={(e) => setGeneratePrompt(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !generating) void handleGenerate() }}
                  placeholder="Describe the image to generate..."
                />
                <button
                  type="button"
                  className="iw-image-picker-btn-primary"
                  onClick={() => void handleGenerate()}
                  disabled={!generatePrompt.trim() || generating}
                >
                  {generating ? "…" : "Generate"}
                </button>
              </div>
              {generateError && <p className="iw-image-picker-error">{generateError}</p>}
              {generating && (
                <p className="iw-image-picker-hint iw-image-picker-generating">
                  <span>Generating image</span>
                  <span className="iw-image-picker-dots" aria-hidden="true">
                    <span className="iw-image-picker-dot" />
                    <span className="iw-image-picker-dot" />
                    <span className="iw-image-picker-dot" />
                  </span>
                </p>
              )}
              {generatedUrl && !generating && (
                <div className="iw-image-picker-generated">
                  <img src={generatedUrl} alt={generatePrompt} className="iw-image-picker-generated-img" />
                  <button
                    type="button"
                    className="iw-image-picker-btn-primary"
                    style={{ marginTop: 12, width: "100%" }}
                    onClick={() => onSelect(generatedUrl, generatePrompt)}
                  >
                    Use this image
                  </button>
                </div>
              )}
              {!generatedUrl && !generating && !generateError && (
                <p className="iw-image-picker-hint">Describe what you want and press Generate</p>
              )}
            </div>
          )}

          {/* URL tab */}
          {tab === "url" && (
            <div className="iw-image-picker-tab-content">
              <div className="iw-image-picker-search-row">
                <input
                  ref={urlInputRef}
                  type="url"
                  className="iw-image-picker-input"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && urlInput.trim()) onSelect(urlInput.trim(), "") }}
                  placeholder="https://example.com/image.jpg"
                />
                <button
                  type="button"
                  className="iw-image-picker-btn-primary"
                  onClick={() => { if (urlInput.trim()) onSelect(urlInput.trim(), "") }}
                  disabled={!urlInput.trim()}
                >
                  Use
                </button>
              </div>
              {urlInput && (
                <div className="iw-image-picker-url-preview">
                  <img src={urlInput} alt="Preview" onError={(e) => { (e.target as HTMLImageElement).style.display = "none" }} />
                </div>
              )}
              {!urlInput && <p className="iw-image-picker-hint">Paste a direct image URL</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
