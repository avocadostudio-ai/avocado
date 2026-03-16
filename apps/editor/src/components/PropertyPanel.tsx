import { useState, type ChangeEvent, type CSSProperties, type ReactNode } from "react"
import { getAllBlockMeta, DEFAULT_HEADING_LEVELS, type FieldMeta, type ListFieldMeta } from "@ai-site-editor/shared"
import { useDebouncedCommit } from "../hooks/useDebouncedCommit"
import { WandSparkles } from "lucide-react"

const AI_ELIGIBLE_KINDS = new Set(["text", "richtext", "imageAlt"])
const noop = () => {}

type Props = {
  style?: CSSProperties
  blockId: string | undefined
  blockType: string | undefined
  props: Record<string, unknown> | null
  status: "idle" | "loading" | "ready" | "error"
  onFieldChange: (fieldPath: string, value: string) => void
  onImageClick?: (fieldPath: string, currentUrl: string) => void
  onAiAssist?: (fieldPath: string, fieldLabel: string, fieldKind: string, currentValue: string) => void
  /** Current page slug for page-level settings. */
  slug?: string
  /** Display name for the current page (e.g. "Home (/)"). */
  pageName?: string
  /** Current nav label for this page (from orchestrator site config). */
  navLabel?: string
  /** Called when the user edits the nav label for the current page. */
  onNavLabelChange?: (slug: string, label: string) => void
  /** Current SEO metadata for this page. */
  pageMeta?: { title?: string; description?: string; ogImage?: string }
  /** Called when the user edits a page-level SEO field. */
  onPageMetaChange?: (field: "title" | "description" | "ogImage", value: string) => void
  /** Called when breadcrumb is clicked to deselect the current block. */
  onDeselectBlock?: () => void
  /** Called when AI assist is requested on a page-level field (SEO title, meta description, nav label). */
  onPageAiAssist?: (fieldLabel: string, fieldKind: string, currentValue: string) => void
  /** Called when the user clicks "+ Add" on a list field. */
  onAddListItem?: (listKey: string) => void
}

export function PropertyPanel({ style, blockId, blockType, props, status, onFieldChange, onImageClick, onAiAssist, slug, pageName, navLabel, onNavLabelChange, pageMeta, onPageMetaChange, onDeselectBlock, onPageAiAssist, onAddListItem }: Props) {
  if (!blockId || !blockType) {
    return (
      <div className="property-panel" style={style}>
        <div className="property-panel-context property-panel-context--page">
          <svg className="property-panel-context-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
            <rect x="2" y="1.5" width="12" height="13" rx="2" stroke="currentColor" strokeWidth="1.3" />
            <path d="M5 5h6M5 8h6M5 11h4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
          </svg>
          <div className="property-panel-context-text">
            <span className="property-panel-context-label property-panel-context-label--page">Editing: Page</span>
            {pageName ? <span className="property-panel-context-name">{pageName}</span> : null}
          </div>
        </div>
        {slug && slug !== "/" && onNavLabelChange ? (
          <NavLabelField slug={slug} navLabel={navLabel ?? ""} onNavLabelChange={onNavLabelChange} onAiAssist={onPageAiAssist} />
        ) : null}
        {slug && onPageMetaChange ? (
          <PageMetaFields
            pageMeta={pageMeta ?? {}}
            onPageMetaChange={onPageMetaChange}
            onAiAssist={onPageAiAssist}
          />
        ) : null}
      </div>
    )
  }

  const allMeta = getAllBlockMeta()
  const meta = allMeta[blockType]

  if (!meta) {
    return (
      <div className="property-panel" style={style}>
        <div className="property-panel-empty">Unknown block type: {blockType}</div>
      </div>
    )
  }

  return (
    <div className="property-panel" style={style}>
      <div className="property-panel-context property-panel-context--component">
        <svg className="property-panel-context-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
          <rect x="1.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <rect x="9.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <rect x="1.5" y="9.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <rect x="9.5" y="9.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
        </svg>
        <div className="property-panel-context-text">
          <span className="property-panel-context-label property-panel-context-label--component">Editing: {meta.displayName}</span>
          {pageName ? (
            <span className="property-panel-context-breadcrumb">
              <button type="button" className="property-panel-context-breadcrumb-link" onClick={onDeselectBlock}>Page</button>
              <span className="property-panel-context-breadcrumb-sep" aria-hidden="true">&rarr;</span>
              <span>{pageName}</span>
            </span>
          ) : null}
        </div>
      </div>
      {status === "loading" && !props ? (
        <div className="property-panel-empty">Loading...</div>
      ) : status === "error" ? (
        <div className="property-panel-empty">Failed to load block properties</div>
      ) : props ? (
        <div className="property-panel-fields">
          {renderFieldEntries(Object.entries(meta.fields), props, "", blockType, onFieldChange, onImageClick, onAiAssist)}
          {meta.listFields
            ? Object.entries(meta.listFields).map(([key, listField]) => {
                const items = Array.isArray(props[key]) ? (props[key] as Record<string, unknown>[]) : []
                return (
                  <ListFieldSection
                    key={key}
                    listKey={key}
                    listField={listField}
                    items={items}
                    blockType={blockType}
                    onFieldChange={onFieldChange}
                    onImageClick={onImageClick}
                    onAiAssist={onAiAssist}
                    onAddItem={onAddListItem ? () => onAddListItem(key) : undefined}
                  />
                )
              })
            : null}
        </div>
      ) : null}
    </div>
  )
}

/** Detect if `altKey` is the companion imageAlt for `imageKey` (e.g. imageUrl → imageAlt). */
function isAltFor(imageKey: string, altKey: string): boolean {
  if (imageKey === "imageUrl" && altKey === "imageAlt") return true
  if (imageKey.endsWith(".src") && altKey === imageKey.replace(/\.src$/, ".alt")) return true
  return false
}

/** Extract a display filename from a URL. */
function filenameFromUrl(url: string): string {
  try {
    const pathname = new URL(url, "http://localhost").pathname
    const last = pathname.split("/").pop() || ""
    return last.length > 30 ? last.slice(0, 27) + "..." : last || "(image)"
  } catch {
    return url.length > 30 ? url.slice(0, 27) + "..." : url || "(empty)"
  }
}

/**
 * Renders a list of field entries, pairing imageUrl + imageAlt into a single widget.
 */
function renderFieldEntries(
  entries: [string, FieldMeta][],
  data: Record<string, unknown>,
  pathPrefix: string,
  blockType: string | undefined,
  onFieldChange: (fieldPath: string, value: string) => void,
  onImageClick?: (fieldPath: string, currentUrl: string) => void,
  onAiAssist?: (fieldPath: string, fieldLabel: string, fieldKind: string, currentValue: string) => void
): ReactNode[] {
  const pairedAltKeys = new Set<string>()

  // Pre-scan: find imageAlt fields that are paired with an image field
  for (let i = 0; i < entries.length; i++) {
    const [key, field] = entries[i]
    if (field.kind === "image") {
      // Look for the companion alt field
      for (const [altKey, altField] of entries) {
        if (altField.kind === "imageAlt" && isAltFor(key, altKey)) {
          pairedAltKeys.add(altKey)
        }
      }
    }
  }

  const nodes: ReactNode[] = []

  for (const [key, field] of entries) {
    // Skip alt fields that are paired — they render inside the image widget
    if (pairedAltKeys.has(key)) continue

    if (field.kind === "image") {
      // Find paired alt field
      const altEntry = entries.find(([ak, af]) => af.kind === "imageAlt" && isAltFor(key, ak))
      const altKey = altEntry?.[0]
      const altValue = altKey ? (data[altKey] == null ? "" : String(data[altKey])) : undefined

      nodes.push(
        <ImageFieldWidget
          key={key}
          label={field.label ?? key}
          imageUrl={data[key] == null ? "" : String(data[key])}
          altText={altValue}
          onChangeClick={() => onImageClick?.(pathPrefix + key, data[key] == null ? "" : String(data[key]))}
          onAltCommit={altKey ? (v) => onFieldChange(pathPrefix + altKey, v) : undefined}
          onAltAiAssist={altKey && onAiAssist ? () => onAiAssist(pathPrefix + altKey, "Alt text", "imageAlt", altValue ?? "") : undefined}
        />
      )
    } else {
      nodes.push(
        <FieldEditor
          key={key}
          fieldKey={key}
          field={field}
          value={data[key]}
          blockType={blockType}
          onCommit={(value) => onFieldChange(pathPrefix + key, value)}
          onAiAssist={AI_ELIGIBLE_KINDS.has(field.kind) && onAiAssist
            ? () => onAiAssist(pathPrefix + key, field.label ?? key, field.kind, data[key] == null ? "" : String(data[key]))
            : undefined}
        />
      )
    }
  }

  return nodes
}

function SparkleButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="property-field-ai-btn" onClick={onClick} title="AI suggestions">
      <WandSparkles size={14} aria-hidden="true" />
    </button>
  )
}

function ImageFieldWidget({
  label,
  imageUrl,
  altText,
  onChangeClick,
  onAltCommit,
  onAltAiAssist
}: {
  label: string
  imageUrl: string
  altText?: string
  onChangeClick: () => void
  onAltCommit?: (value: string) => void
  onAltAiAssist?: () => void
}) {
  const [altLocal, setAltLocal] = useState(altText ?? "")
  const [altFocused, setAltFocused] = useState(false)
  const displayAlt = altFocused ? altLocal : (altText ?? "")
  const { debouncedCommit: debouncedAltCommit, flushCommit: flushAltCommit } = useDebouncedCommit(onAltCommit ?? noop, 400)

  return (
    <div className="property-field">
      <div className="property-field-label"><span>{label}</span></div>
      <div className="property-field-image-widget">
        <div className="property-field-image-preview">
          {imageUrl ? (
            <img
              className="property-field-image-thumb"
              src={imageUrl}
              alt=""
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none" }}
            />
          ) : (
            <div className="property-field-image-thumb property-field-image-placeholder">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="m21 15-5-5L5 21" />
              </svg>
            </div>
          )}
          <button type="button" className="property-field-image-change" onClick={onChangeClick}>
            {imageUrl ? "Change" : "Choose image"}
          </button>
        </div>
        {onAltCommit !== undefined && (
          <div className="property-field-image-alt-group">
            <div className="property-field-image-alt-label">
              <span>Alt text</span>
              {onAltAiAssist ? <SparkleButton onClick={onAltAiAssist} /> : null}
            </div>
            <input
              type="text"
              className="property-field-image-alt"
              placeholder="Describe what's in this image"
              value={displayAlt}
              onFocus={() => { setAltLocal(altText ?? ""); setAltFocused(true) }}
              onChange={(e) => { setAltLocal(e.target.value); debouncedAltCommit(e.target.value) }}
              onBlur={() => {
                setAltFocused(false)
                flushAltCommit()
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

function ListFieldSection({
  listKey,
  listField,
  items,
  blockType,
  onFieldChange,
  onImageClick,
  onAiAssist,
  onAddItem
}: {
  listKey: string
  listField: ListFieldMeta
  items: Record<string, unknown>[]
  blockType: string | undefined
  onFieldChange: (fieldPath: string, value: string) => void
  onImageClick?: (fieldPath: string, currentUrl: string) => void
  onAiAssist?: (fieldPath: string, fieldLabel: string, fieldKind: string, currentValue: string) => void
  onAddItem?: () => void
}) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)
  const label = listField.label ?? listKey

  return (
    <div className="property-list-section">
      <div className="property-list-header">{label} ({items.length})</div>
      {items.map((item, index) => {
        const isExpanded = expandedIndex === index
        // Use the first text-like field value as a preview label
        const previewKey = Object.keys(listField.itemFields).find(
          (k) => listField.itemFields[k].kind === "text" || listField.itemFields[k].kind === "richtext"
        )
        const previewText = previewKey && item[previewKey] != null ? String(item[previewKey]) : `Item ${index + 1}`
        const truncated = previewText.length > 40 ? previewText.slice(0, 40) + "..." : previewText

        return (
          <div key={index} className="property-list-item">
            <button
              type="button"
              className={`property-list-item-toggle ${isExpanded ? "is-expanded" : ""}`}
              onClick={() => setExpandedIndex(isExpanded ? null : index)}
            >
              <span className="property-list-item-chevron" aria-hidden="true" />
              <span className="property-list-item-preview">{truncated}</span>
            </button>
            {isExpanded ? (
              <div className="property-list-item-fields">
                {renderFieldEntries(
                  Object.entries(listField.itemFields),
                  item,
                  `${listKey}[${index}].`,
                  blockType,
                  onFieldChange,
                  onImageClick,
                  onAiAssist
                )}
              </div>
            ) : null}
          </div>
        )
      })}
      {onAddItem ? (
        <button type="button" className="property-list-add-btn" onClick={onAddItem}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M8 3v10M3 8h10" />
          </svg>
          Add
        </button>
      ) : null}
    </div>
  )
}

const HEADING_LEVEL_LABELS: Record<string, string> = {
  h1: "H1 — Page title",
  h2: "H2 — Section",
  h3: "H3 — Subsection",
  h4: "H4",
  h5: "H5",
  h6: "H6",
}

function FieldEditor({
  fieldKey,
  field,
  value,
  blockType,
  onCommit,
  onAiAssist
}: {
  fieldKey: string
  field: FieldMeta
  value: unknown
  blockType?: string | undefined
  onCommit: (value: string) => void
  onAiAssist?: () => void
}) {
  const stringValue = value == null ? "" : String(value)
  const [localValue, setLocalValue] = useState(stringValue)
  const [focused, setFocused] = useState(false)
  const { debouncedCommit, flushCommit } = useDebouncedCommit(onCommit, 400)

  // Sync from props when not focused
  const displayValue = focused ? localValue : stringValue

  const label = field.label ?? fieldKey

  const handleFocus = () => {
    setLocalValue(stringValue)
    setFocused(true)
  }

  const handleBlur = () => {
    setFocused(false)
    flushCommit()
  }

  if (field.kind === "headingLevel") {
    const defaultTag = (blockType && DEFAULT_HEADING_LEVELS[blockType]) ?? "h2"
    const current = stringValue && /^h[1-6]$/.test(stringValue) ? stringValue : ""
    return (
      <div className="property-field">
        <div className="property-field-label"><span>{label}</span></div>
        <select
          className="property-field-input"
          value={current}
          onChange={(e) => onCommit(e.target.value)}
        >
          <option value="">Auto ({defaultTag.toUpperCase()})</option>
          {(["h1", "h2", "h3", "h4", "h5", "h6"] as const).map((h) => (
            <option key={h} value={h}>{HEADING_LEVEL_LABELS[h]}</option>
          ))}
        </select>
      </div>
    )
  }

  if (field.kind === "image") {
    return (
      <div className="property-field">
        <div className="property-field-label"><span>{label}</span></div>
        <div className="property-field-image-url" title={stringValue}>
          {stringValue || "(empty)"}
        </div>
      </div>
    )
  }

  if (field.kind === "enum" && field.options) {
    return (
      <div className="property-field">
        <div className="property-field-label"><span>{label}</span></div>
        <select
          className="property-field-input"
          value={stringValue}
          onChange={(e) => onCommit(e.target.value)}
        >
          {field.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </div>
    )
  }

  if (field.kind === "color") {
    return (
      <div className="property-field">
        <div className="property-field-label"><span>{label}</span></div>
        <input
          type="color"
          className="property-field-color"
          value={stringValue || "#000000"}
          onChange={(e) => onCommit(e.target.value)}
        />
      </div>
    )
  }

  const useTextarea = field.kind === "richtext" || field.multiline === true
  const inputType = field.kind === "number" ? "number" : field.kind === "url" ? "url" : "text"
  const sharedProps = {
    value: displayValue,
    onFocus: handleFocus,
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setLocalValue(e.target.value); debouncedCommit(e.target.value) },
    onBlur: handleBlur
  } as const

  return (
    <div className="property-field">
      <div className="property-field-label">
        <span>
          {label}
          {field.required && <span className="property-field-required">*</span>}
        </span>
        {onAiAssist ? <SparkleButton onClick={onAiAssist} /> : null}
      </div>
      {useTextarea ? (
        <textarea className="property-field-textarea" rows={3} {...sharedProps} />
      ) : (
        <input type={inputType} className="property-field-input" {...sharedProps} />
      )}
    </div>
  )
}

function NavLabelField({ slug, navLabel, onNavLabelChange, onAiAssist }: { slug: string; navLabel: string; onNavLabelChange: (slug: string, label: string) => void; onAiAssist?: (fieldLabel: string, fieldKind: string, currentValue: string) => void }) {
  const [local, setLocal] = useState(navLabel)
  const [focused, setFocused] = useState(false)
  const display = focused ? local : navLabel
  const { debouncedCommit, flushCommit } = useDebouncedCommit((v: string) => onNavLabelChange(slug, v), 400)

  return (
    <div className="property-panel-page-section">
      <div className="property-field">
        <div className="property-field-label">
          <span>Nav label for {slug}</span>
          {onAiAssist ? <SparkleButton onClick={() => onAiAssist("Nav label", "text", navLabel)} /> : null}
        </div>
        <input
          type="text"
          className="property-field-input"
          placeholder="Default"
          value={display}
          onFocus={() => { setLocal(navLabel); setFocused(true) }}
          onChange={(e) => { setLocal(e.target.value); debouncedCommit(e.target.value) }}
          onBlur={() => { setFocused(false); flushCommit() }}
        />
      </div>
    </div>
  )
}

function PageMetaFields({
  pageMeta,
  onPageMetaChange,
  onAiAssist
}: {
  pageMeta: { title?: string; description?: string; ogImage?: string }
  onPageMetaChange: (field: "title" | "description" | "ogImage", value: string) => void
  onAiAssist?: (fieldLabel: string, fieldKind: string, currentValue: string) => void
}) {
  return (
    <div className="property-panel-page-section">
      <div className="property-panel-block-name">SEO</div>
      <PageMetaField
        label="SEO title"
        value={pageMeta.title ?? ""}
        placeholder="Defaults to page title"
        recommendedMax={60}
        onCommit={(value) => onPageMetaChange("title", value)}
        onAiAssist={onAiAssist ? () => onAiAssist("SEO title", "text", pageMeta.title ?? "") : undefined}
      />
      <PageMetaField
        label="Meta description"
        value={pageMeta.description ?? ""}
        placeholder="Defaults to generated description"
        multiline
        recommendedMax={160}
        onCommit={(value) => onPageMetaChange("description", value)}
        onAiAssist={onAiAssist ? () => onAiAssist("Meta description", "richtext", pageMeta.description ?? "") : undefined}
      />
      <PageMetaField
        label="Open Graph image URL"
        value={pageMeta.ogImage ?? ""}
        placeholder="https://..."
        onCommit={(value) => onPageMetaChange("ogImage", value)}
      />
    </div>
  )
}

function PageMetaField({
  label,
  value,
  placeholder,
  multiline,
  recommendedMax,
  onCommit,
  onAiAssist
}: {
  label: string
  value: string
  placeholder?: string
  multiline?: boolean
  recommendedMax?: number
  onCommit: (value: string) => void
  onAiAssist?: () => void
}) {
  const [local, setLocal] = useState(value)
  const [focused, setFocused] = useState(false)
  const display = focused ? local : value
  const { debouncedCommit, flushCommit } = useDebouncedCommit(onCommit, 400)

  const shared = {
    placeholder,
    value: display,
    onFocus: () => { setLocal(value); setFocused(true) },
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setLocal(e.target.value)
      debouncedCommit(e.target.value)
    },
    onBlur: () => {
      setFocused(false)
      flushCommit()
    }
  } as const

  const charLen = (focused ? local : value).length

  return (
    <div className="property-field">
      <div className="property-field-label">
        <span>{label}</span>
        {onAiAssist ? <SparkleButton onClick={onAiAssist} /> : null}
      </div>
      {multiline ? (
        <textarea className="property-field-textarea" rows={3} {...shared} />
      ) : (
        <input type="text" className="property-field-input" {...shared} />
      )}
      {recommendedMax != null && (
        <span className={`property-field-char-count${charLen > recommendedMax ? " property-field-char-count--over" : ""}`}>
          {charLen} / {recommendedMax}
        </span>
      )}
    </div>
  )
}
