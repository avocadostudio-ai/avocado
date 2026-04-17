"use client"

import { useState, useMemo, useCallback, useRef, useEffect, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { SharedBlockRenderer } from "./renderer"
import { initCarousels } from "./blocks/carousel/init"
import { initTabs } from "./blocks/tabs/init"
import { getAllBlockMeta, allowedBlockTypes, defaultPropsForType, getChromeTypes, type BlockMeta, type FieldMeta, type ImageSpec } from "@ai-site-editor/shared"

const CATEGORY_ORDER: NonNullable<BlockMeta["category"]>[] = ["content", "conversion", "layout", "navigation", "media"]
const CATEGORY_LABELS: Record<string, string> = {
  content: "Content",
  media: "Media",
  navigation: "Navigation",
  conversion: "Conversion",
  layout: "Layout",
}

// ---------------------------------------------------------------------------
// Dummy image URL builder — replaces image props with placeholder images
// that respect the field's declared aspect ratio / dimensions.
// ---------------------------------------------------------------------------

function dummyImageUrl(spec?: ImageSpec): string {
  const w = spec?.width ?? 600
  const h = spec?.height ?? 400
  return `https://placehold.co/${w}x${h}/ab96ab/000000.jpg`
}

function withDummyImages(
  props: Record<string, unknown>,
  meta: BlockMeta | undefined
): Record<string, unknown> {
  if (!meta) return props
  const result = { ...props }

  // Scalar image fields — replace existing or populate missing optional images
  for (const [key, fm] of Object.entries(meta.fields)) {
    if (fm.kind === "image" && (typeof result[key] === "string" || result[key] === undefined)) {
      result[key] = dummyImageUrl(fm.imageSpec)
    }
  }

  // List item image fields
  if (meta.listFields) {
    for (const [listKey, lm] of Object.entries(meta.listFields)) {
      const imageItemKeys = Object.entries(lm.itemFields)
        .filter(([, fm]) => fm.kind === "image")
      if (imageItemKeys.length === 0) continue
      const list = result[listKey]
      if (!Array.isArray(list)) continue
      result[listKey] = list.map((item) => {
        if (!item || typeof item !== "object") return item
        const patched = { ...(item as Record<string, unknown>) }
        for (const [itemKey, fm] of imageItemKeys) {
          if (typeof patched[itemKey] === "string" || patched[itemKey] === undefined) {
            patched[itemKey] = dummyImageUrl(fm.imageSpec)
          }
        }
        return patched
      })
    }
  }

  return result
}

export function BlockCatalogue() {
  const allTypes = useMemo(() => [...allowedBlockTypes, ...getChromeTypes()], [])
  const [selectedType, setSelectedType] = useState<string>(allTypes[0] ?? "")
  const [liveProps, setLiveProps] = useState<Record<string, Record<string, unknown>>>({})
  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window === "undefined") return false
    const stored = window.localStorage.getItem("site-theme-v1")
    if (stored === "dark") return true
    if (stored === "light") return false
    return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? false
  })
  // Sync dark mode to document and localStorage
  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode)
    window.localStorage.setItem("site-theme-v1", darkMode ? "dark" : "light")
  }, [darkMode])

  // Listen for external theme changes (e.g. SiteHeader toggle)
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "site-theme-v1") setDarkMode(e.newValue === "dark")
    }
    window.addEventListener("storage", onStorage)

    // Also watch for classList changes on <html> (same-tab toggle from SiteHeader)
    const observer = new MutationObserver(() => {
      const hasDark = document.documentElement.classList.contains("dark")
      setDarkMode((prev) => prev !== hasDark ? hasDark : prev)
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => { window.removeEventListener("storage", onStorage); observer.disconnect() }
  }, [])

  const [viewportWidth, setViewportWidth] = useState(1280)
  const previewWrapRef = useRef<HTMLDivElement>(null)
  const [previewScale, setPreviewScale] = useState(1)

  const allMeta = getAllBlockMeta()

  const blocks = useMemo(() => {
    return allTypes.map((type) => ({
      type,
      meta: allMeta[type],
      defaultProps: defaultPropsForType(type),
    }))
  }, [allMeta, allTypes])

  // Group blocks by category
  const groupedBlocks = useMemo(() => {
    const groups: Record<string, typeof blocks> = {}
    for (const b of blocks) {
      const cat = b.meta?.category ?? "other"
      ;(groups[cat] ??= []).push(b)
    }
    const sorted: [string, typeof blocks][] = []
    for (const cat of CATEGORY_ORDER) {
      if (groups[cat]) sorted.push([cat, groups[cat]])
    }
    for (const [cat, items] of Object.entries(groups)) {
      if (!CATEGORY_ORDER.includes(cat as any)) sorted.push([cat, items])
    }
    return sorted
  }, [blocks])

  const activeType = selectedType && blocks.some((b) => b.type === selectedType)
    ? selectedType
    : blocks[0]?.type ?? ""

  const activeBlock = blocks.find((b) => b.type === activeType)
  const activeMeta = activeBlock?.meta
  const activeDefaultProps = activeBlock?.defaultProps ?? {}
  const activeRawProps = { ...activeDefaultProps, ...(liveProps[activeType] ?? {}) }
  const activeProps = withDummyImages(activeRawProps, activeMeta)

  // Build enum variants — for each enum field with options, render one preview per value
  const enumVariants = useMemo(() => {
    if (!activeMeta) return []
    const enumFields = Object.entries(activeMeta.fields)
      .filter(([, fm]) => fm.kind === "enum" && Array.isArray(fm.options) && fm.options.length > 1)
    if (enumFields.length === 0) return []
    // Use the first enum field that has visual variants (e.g. imagePosition)
    const [fieldKey, fm] = enumFields[0]
    return fm.options!.map((option) => ({
      label: `${fm.label ?? fieldKey}: ${option}`,
      props: { ...activeProps, [fieldKey]: option },
    }))
  }, [activeMeta, activeProps])

  // Scale preview to fit container
  useEffect(() => {
    const wrap = previewWrapRef.current
    if (!wrap) return
    const measure = () => {
      const wrapW = wrap.clientWidth
      setPreviewScale(Math.min(1, wrapW / viewportWidth))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [activeType, viewportWidth])

  const updateProp = useCallback(
    (key: string, value: unknown) => {
      setLiveProps((prev) => ({
        ...prev,
        [activeType]: { ...(prev[activeType] ?? {}), [key]: value },
      }))
    },
    [activeType]
  )

  const updateListItemProp = useCallback(
    (listKey: string, index: number, itemKey: string, value: unknown) => {
      setLiveProps((prev) => {
        const current = { ...(prev[activeType] ?? {}) }
        const list = Array.isArray(current[listKey])
          ? [...(current[listKey] as Record<string, unknown>[])]
          : Array.isArray(activeDefaultProps[listKey])
            ? [...(activeDefaultProps[listKey] as Record<string, unknown>[])]
            : []
        if (list[index]) {
          list[index] = { ...list[index], [itemKey]: value }
        }
        current[listKey] = list
        return { ...prev, [activeType]: current }
      })
    },
    [activeType, activeDefaultProps]
  )

  const resetProps = useCallback(() => {
    setLiveProps((prev) => {
      const next = { ...prev }
      delete next[activeType]
      return next
    })
  }, [activeType])

  return (
    <div className={`cat-root${darkMode ? " dark" : ""}`}>
      <style>{catalogueCSS}</style>

      {/* Compact header */}
      <header className="cat-header">
        <div className="cat-header-row">
          <div>
            <h1 className="cat-title">Block Catalogue</h1>
            <p className="cat-subtitle">
              {allTypes.length} blocks &middot; rendered with live props
            </p>
          </div>
          <button
            onClick={() => setDarkMode((d) => !d)}
            className="cat-theme-toggle"
            title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
          >
            {darkMode ? "\u2600\uFE0F" : "\uD83C\uDF19"}
          </button>
        </div>
      </header>

      {/* Three-column layout: sidebar | preview | props */}
      <div className="cat-layout">
        {/* Block list grouped by category */}
        <nav className="cat-sidebar">
          {groupedBlocks.map(([cat, items]) => (
            <div key={cat} className="cat-sidebar-group">
              <p className="cat-sidebar-heading">{CATEGORY_LABELS[cat] ?? cat}</p>
              {items.map(({ type, meta }) => (
                <button
                  key={type}
                  onClick={() => setSelectedType(type)}
                  className={`cat-sidebar-item${type === activeType ? " active" : ""}`}
                >
                  {meta?.displayName ?? type}
                  {meta?.chrome && <span className="cat-chrome-badge">chrome</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>

        {/* Center: scaled preview */}
        <main className="cat-main">
          {activeBlock && (
            <>
              <div className="cat-info-bar">
                <h2 className="cat-block-name">{activeMeta?.displayName ?? activeType}</h2>
                {activeMeta?.category && (
                  <span className="cat-badge">{activeMeta.category}</span>
                )}
                {activeMeta?.chrome && (
                  <span className="cat-badge cat-badge-chrome">chrome</span>
                )}
                <code className="cat-type-id">{activeType}</code>
                <div className="cat-viewport-toggle">
                  <button
                    className={`cat-viewport-btn${viewportWidth === 390 ? " active" : ""}`}
                    onClick={() => setViewportWidth(390)}
                    title="Mobile (390px)"
                    aria-label="Mobile view"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="2" width="14" height="20" rx="2" ry="2" /><path d="M12 18h.01" /></svg>
                  </button>
                  <button
                    className={`cat-viewport-btn${viewportWidth === 768 ? " active" : ""}`}
                    onClick={() => setViewportWidth(768)}
                    title="Tablet (768px)"
                    aria-label="Tablet view"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="2" width="16" height="20" rx="2" ry="2" /><path d="M12 18h.01" /></svg>
                  </button>
                  <button
                    className={`cat-viewport-btn${viewportWidth === 1280 ? " active" : ""}`}
                    onClick={() => setViewportWidth(1280)}
                    title="Desktop (1280px)"
                    aria-label="Desktop view"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2" ry="2" /><path d="M8 21h8" /><path d="M12 17v4" /></svg>
                  </button>
                </div>
              </div>
              {activeMeta?.description && (
                <p className="cat-desc">{activeMeta.description}</p>
              )}
              {enumVariants.length > 0 ? (
                enumVariants.map(({ label, props: variantProps }) => (
                  <div key={label} className="cat-variant">
                    <p className="cat-variant-label">{label}</p>
                    <CataloguePreview
                      viewportWidth={viewportWidth}
                      darkMode={darkMode}
                      previewWrapRef={previewWrapRef}
                      previewScale={previewScale}
                    >
                      <SharedBlockRenderer
                        block={{ id: `cat-${activeType}-${label}`, type: activeType, props: variantProps }}
                      />
                    </CataloguePreview>
                  </div>
                ))
              ) : (
                <CataloguePreview
                  viewportWidth={viewportWidth}
                  darkMode={darkMode}
                  previewWrapRef={previewWrapRef}
                  previewScale={previewScale}
                >
                  <SharedBlockRenderer
                    block={{ id: `cat-${activeType}`, type: activeType, props: activeProps }}
                  />
                </CataloguePreview>
              )}
            </>
          )}
        </main>

        {/* Right: prop editor */}
        <aside className="cat-props">
          {activeBlock && activeMeta && (
            <>
              <div className="cat-props-header">
                <h3 className="cat-props-title">Props</h3>
                <button onClick={resetProps} className="cat-props-reset">
                  Reset
                </button>
              </div>

              {Object.entries(activeMeta.fields).map(([key, fm]) => (
                <PropField
                  key={key}
                  fieldKey={key}
                  meta={fm}
                  value={activeProps[key]}
                  onChange={(v) => updateProp(key, v)}
                />
              ))}

              {activeMeta.listFields &&
                Object.entries(activeMeta.listFields).map(([listKey, lm]) => {
                  const items = Array.isArray(activeProps[listKey])
                    ? (activeProps[listKey] as Record<string, unknown>[])
                    : []
                  return (
                    <div key={listKey} className="cat-list-section">
                      <p className="cat-list-label">{lm.label ?? listKey} <span className="cat-list-count">{items.length} items</span></p>
                      {items.map((item, idx) => (
                        <div key={idx} className="cat-list-item">
                          <p className="cat-list-item-idx">#{idx + 1}</p>
                          {Object.entries(lm.itemFields).map(([itemKey, itemMeta]) => (
                            <PropField
                              key={itemKey}
                              fieldKey={itemKey}
                              meta={itemMeta}
                              value={item[itemKey]}
                              onChange={(v) => updateListItemProp(listKey, idx, itemKey, v)}
                            />
                          ))}
                        </div>
                      ))}
                    </div>
                  )
                })}
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Prop field editor component
// ---------------------------------------------------------------------------

function PropField({
  fieldKey,
  meta,
  value,
  onChange,
}: {
  fieldKey: string
  meta: FieldMeta
  value: unknown
  onChange: (v: unknown) => void
}) {
  const label = meta.label ?? fieldKey

  if (meta.kind === "enum" && meta.options) {
    return (
      <div className="cat-prop-row">
        <label className="cat-prop-label">
          {label}
          <span className="cat-prop-kind">{meta.kind}</span>
        </label>
        <select
          className="cat-prop-select"
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        >
          {meta.options.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      </div>
    )
  }

  if (meta.kind === "number") {
    return (
      <div className="cat-prop-row">
        <label className="cat-prop-label">
          {label}
          <span className="cat-prop-kind">{meta.kind}</span>
        </label>
        <input
          type="number"
          className="cat-prop-input"
          value={value != null ? String(value) : ""}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
    )
  }

  if (meta.kind === "color") {
    return (
      <div className="cat-prop-row">
        <label className="cat-prop-label">
          {label}
          <span className="cat-prop-kind">{meta.kind}</span>
        </label>
        <div className="cat-prop-color-wrap">
          <input
            type="color"
            className="cat-prop-color"
            value={String(value ?? "#000000")}
            onChange={(e) => onChange(e.target.value)}
          />
          <input
            type="text"
            className="cat-prop-input cat-prop-color-text"
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      </div>
    )
  }

  const isMultiline = meta.multiline || meta.kind === "richtext"
  return (
    <div className="cat-prop-row">
      <label className="cat-prop-label">
        {label}
        <span className="cat-prop-kind">{meta.kind}</span>
      </label>
      {isMultiline ? (
        <textarea
          className="cat-prop-textarea"
          value={String(value ?? "")}
          rows={3}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          type="text"
          className="cat-prop-input"
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Catalogue preview — renders children inside an iframe so CSS media queries
// respond to the iframe viewport width, not the browser viewport.
// ---------------------------------------------------------------------------

function CataloguePreview({ viewportWidth, darkMode, previewWrapRef, previewScale, children }: {
  viewportWidth: number
  darkMode: boolean
  previewWrapRef: React.RefObject<HTMLDivElement | null>
  previewScale: number
  children: ReactNode
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [mountNode, setMountNode] = useState<HTMLElement | null>(null)
  const [contentHeight, setContentHeight] = useState(200)

  // Initialize the iframe: copy parent styles, create mount node, observe height
  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return

    const setup = () => {
      const doc = iframe.contentDocument
      if (!doc) return

      // Copy parent stylesheets into the iframe
      doc.head.innerHTML = ""
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          if (sheet.href) {
            const link = doc.createElement("link")
            link.rel = "stylesheet"
            link.href = sheet.href
            doc.head.appendChild(link)
          } else if (sheet.ownerNode instanceof HTMLStyleElement) {
            const style = doc.createElement("style")
            style.textContent = sheet.ownerNode.textContent
            doc.head.appendChild(style)
          }
        } catch { /* cross-origin sheets — skip */ }
      }

      doc.body.style.margin = "0"
      doc.body.style.overflow = "hidden"
      doc.documentElement.classList.toggle("dark", darkMode)

      let mount = doc.getElementById("cat-iframe-root")
      if (!mount) {
        mount = doc.createElement("div")
        mount.id = "cat-iframe-root"
        doc.body.appendChild(mount)
      }
      setMountNode(mount)

      // Observe content height changes
      const ro = new ResizeObserver(() => {
        const h = mount!.scrollHeight || doc.body.scrollHeight
        if (h > 0) setContentHeight(h)
      })
      ro.observe(mount)
      ro.observe(doc.body)
      return () => ro.disconnect()
    }

    iframe.addEventListener("load", setup)
    iframe.src = "about:blank"
    return () => iframe.removeEventListener("load", setup)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync dark mode into iframe
  useEffect(() => {
    const doc = iframeRef.current?.contentDocument
    if (doc) doc.documentElement.classList.toggle("dark", darkMode)
  }, [darkMode])

  // Re-sync parent styles into iframe when they change (HMR)
  useEffect(() => {
    const doc = iframeRef.current?.contentDocument
    if (!doc || !mountNode) return

    const observer = new MutationObserver(() => {
      const existingLinks = new Set<string>()
      doc.head.querySelectorAll("link[rel=stylesheet]").forEach((el) => existingLinks.add((el as HTMLLinkElement).href))

      for (const sheet of Array.from(document.styleSheets)) {
        try {
          if (sheet.href && !existingLinks.has(sheet.href)) {
            const link = doc.createElement("link")
            link.rel = "stylesheet"
            link.href = sheet.href
            doc.head.appendChild(link)
          } else if (sheet.ownerNode instanceof HTMLStyleElement) {
            // Find matching style tag by data attribute or position
            const id = sheet.ownerNode.dataset.n || sheet.ownerNode.dataset.href
            if (id) {
              const existing = doc.head.querySelector(`style[data-cat-src="${id}"]`)
              if (existing) {
                existing.textContent = sheet.ownerNode.textContent
              } else {
                const style = doc.createElement("style")
                style.dataset.catSrc = id
                style.textContent = sheet.ownerNode.textContent
                doc.head.appendChild(style)
              }
            }
          }
        } catch { /* skip */ }
      }
    })
    observer.observe(document.head, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [mountNode])

  // Initialize interactive blocks (carousel, etc.) after portal renders
  useEffect(() => {
    if (!mountNode) return
    // Defer to let React finish flushing the portal content
    const id = requestAnimationFrame(() => { initCarousels(mountNode); initTabs(mountNode) })
    return () => cancelAnimationFrame(id)
  })

  const scaledHeight = contentHeight * previewScale

  return (
    <div className="cat-preview-wrap" ref={previewWrapRef} style={{ height: scaledHeight }}>
      <div className="cat-preview-inner" style={{
        width: viewportWidth,
        transform: `scale(${previewScale})`,
        transformOrigin: "top left",
      }}>
        <iframe
          ref={iframeRef}
          title="Block preview"
          style={{ width: "100%", height: contentHeight, border: "none", display: "block" }}
        />
        {mountNode && createPortal(children, mountNode)}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const catalogueCSS = /* css */ `
  .cat-root {
    min-height: 100vh;
    background: var(--bg-0);
    overflow-x: hidden;
  }
  .cat-root * {
    box-sizing: border-box;
  }

  /* ---- Header (non-sticky — site nav provides sticky chrome) ---- */
  .cat-header {
    border-bottom: 1px solid var(--surface-border);
    background: var(--nav-bg, var(--bg-0));
    padding: 12px 24px;
  }
  .cat-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .cat-title {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 800;
    color: var(--heading);
    letter-spacing: -0.02em;
  }
  .cat-subtitle {
    margin: 2px 0 0;
    font-size: 0.75rem;
    color: var(--caption);
  }

  /* ---- Theme toggle ---- */
  .cat-theme-toggle {
    padding: 6px 10px;
    border: 1px solid var(--surface-border);
    border-radius: 8px;
    background: var(--bg-100);
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    transition: border-color 0.15s;
  }
  .cat-theme-toggle:hover {
    border-color: var(--brand);
  }

  /* ---- Three-column layout ---- */
  .cat-layout {
    display: grid;
    grid-template-columns: 200px 1fr 320px;
    height: calc(100vh - 110px);
    overflow: hidden;
  }

  /* ---- Left sidebar: grouped block list ---- */
  .cat-sidebar {
    border-right: 1px solid var(--surface-border);
    padding: 12px 0;
    overflow-y: auto;
    background: var(--bg-0);
  }
  .cat-sidebar-group {
    margin-bottom: 4px;
  }
  .cat-sidebar-heading {
    margin: 0;
    padding: 8px 16px 4px;
    font-size: 0.625rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--caption);
  }
  .cat-sidebar-item {
    display: block;
    width: 100%;
    padding: 6px 16px 6px 24px;
    border: none;
    background: transparent;
    color: var(--text-300);
    font-size: 0.8125rem;
    font-family: inherit;
    cursor: pointer;
    text-align: left;
    transition: background 0.1s, color 0.1s;
  }
  .cat-sidebar-item:hover {
    background: var(--bg-100);
    color: var(--text-100);
  }
  .cat-sidebar-item.active {
    background: var(--brand-subtle, var(--bg-200));
    color: var(--brand);
    font-weight: 600;
  }

  /* ---- Enum variant labels ---- */
  .cat-variant {
    margin-bottom: 20px;
  }
  .cat-variant:last-child {
    margin-bottom: 0;
  }
  .cat-variant-label {
    margin: 0 0 6px;
    font-size: 0.6875rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--caption);
  }

  /* ---- Viewport toggle ---- */
  .cat-viewport-toggle {
    display: flex;
    gap: 2px;
    margin-left: 8px;
    border: 1px solid var(--surface-border);
    border-radius: 6px;
    padding: 2px;
    background: var(--bg-100);
  }
  .cat-viewport-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 24px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-400);
    cursor: pointer;
    padding: 0;
    transition: all 0.15s;
  }
  .cat-viewport-btn svg {
    width: 14px;
    height: 14px;
  }
  .cat-viewport-btn:hover {
    color: var(--text-100);
    background: var(--bg-200);
  }
  .cat-viewport-btn.active {
    color: var(--brand);
    background: var(--bg-0);
    box-shadow: 0 1px 2px rgba(0,0,0,0.06);
  }

  /* ---- Chrome badge ---- */
  .cat-chrome-badge {
    display: inline-block;
    font-size: 0.5rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--surface-border);
    color: var(--caption);
    margin-left: 6px;
    vertical-align: middle;
  }
  .cat-badge-chrome {
    background: var(--surface-border);
    color: var(--caption);
  }

  /* ---- Center: preview ---- */
  .cat-main {
    overflow-y: auto;
    padding: 20px 24px;
    min-width: 0;
  }
  .cat-info-bar {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 4px;
  }
  .cat-block-name {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 700;
    color: var(--heading);
  }
  .cat-badge {
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 2px 8px;
    border-radius: 4px;
    background: var(--brand-subtle);
    color: var(--brand);
    white-space: nowrap;
  }
  .cat-type-id {
    font-size: 0.75rem;
    color: var(--text-400);
    font-family: var(--font-mono, monospace);
    margin-left: auto;
  }
  .cat-desc {
    margin: 0 0 12px;
    font-size: 0.8125rem;
    color: var(--caption);
    line-height: 1.5;
  }

  /* ---- Scaled preview wrapper ---- */
  .cat-preview-wrap {
    border: 1px solid var(--surface-border);
    border-radius: 10px;
    overflow: hidden;
    background: var(--bg-0);
    position: relative;
  }

  /* ---- Right: prop editor ---- */
  .cat-props {
    border-left: 1px solid var(--surface-border);
    overflow-y: auto;
    padding: 16px;
    background: var(--bg-0);
  }
  .cat-props-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--surface-border);
  }
  .cat-props-title {
    margin: 0;
    font-size: 0.8125rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--caption);
  }
  .cat-props-reset {
    padding: 3px 10px;
    border: 1px solid var(--surface-border);
    border-radius: 5px;
    background: transparent;
    color: var(--caption);
    font-size: 0.6875rem;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.15s;
  }
  .cat-props-reset:hover {
    border-color: var(--brand);
    color: var(--text-100);
  }

  /* ---- Prop rows ---- */
  .cat-prop-row {
    margin-bottom: 12px;
  }
  .cat-prop-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-200);
    margin-bottom: 4px;
  }
  .cat-prop-kind {
    font-size: 0.5625rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.45;
    font-weight: 500;
  }
  .cat-prop-input,
  .cat-prop-select,
  .cat-prop-textarea {
    width: 100%;
    padding: 6px 8px;
    border: 1px solid var(--surface-border);
    border-radius: 6px;
    background: var(--bg-100);
    color: var(--text-100);
    font-size: 0.75rem;
    font-family: var(--font-mono, monospace);
    outline: none;
    transition: border-color 0.15s;
  }
  .cat-prop-input:focus,
  .cat-prop-select:focus,
  .cat-prop-textarea:focus {
    border-color: var(--brand);
  }
  .cat-prop-textarea {
    resize: vertical;
    min-height: 60px;
  }
  .cat-prop-color-wrap {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .cat-prop-color {
    width: 32px;
    height: 32px;
    border: 1px solid var(--surface-border);
    border-radius: 6px;
    padding: 2px;
    cursor: pointer;
    background: transparent;
  }
  .cat-prop-color-text {
    flex: 1;
  }

  /* ---- List sections ---- */
  .cat-list-section {
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid var(--surface-border);
  }
  .cat-list-label {
    margin: 0 0 10px;
    font-size: 0.8125rem;
    font-weight: 700;
    color: var(--heading);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .cat-list-count {
    font-size: 0.625rem;
    font-weight: 500;
    color: var(--caption);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .cat-list-item {
    margin-bottom: 14px;
    padding: 10px;
    border: 1px solid var(--surface-border);
    border-radius: 8px;
    background: var(--bg-100);
  }
  .cat-list-item-idx {
    margin: 0 0 8px;
    font-size: 0.625rem;
    font-weight: 700;
    color: var(--caption);
    text-transform: uppercase;
  }

  /* ---- Responsive ---- */
  @media (max-width: 1100px) {
    .cat-layout {
      grid-template-columns: 180px 1fr 260px;
    }
  }
  @media (max-width: 900px) {
    .cat-header { padding: 10px 16px; }
    .cat-layout {
      grid-template-columns: 1fr;
      height: auto;
    }
    .cat-sidebar { display: none; }
    .cat-props { border-left: none; border-top: 1px solid var(--surface-border); }
  }
`
