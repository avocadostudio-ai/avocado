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
  /** Current nav label for this page (from orchestrator site config). */
  navLabel?: string
  /** Called when the user edits the nav label for the current page. */
  onNavLabelChange?: (slug: string, label: string) => void
}

export function PropertyPanel({ style, blockId, blockType, props, status, onFieldChange, onImageClick, onAiAssist, slug, navLabel, onNavLabelChange }: Props) {
  if (!blockId || !blockType) {
    return (
      <div className="property-panel" style={style}>
        {slug && slug !== "/" && onNavLabelChange ? (
          <NavLabelField slug={slug} navLabel={navLabel ?? ""} onNavLabelChange={onNavLabelChange} />
        ) : null}
        <div className="property-panel-empty">
          <svg className="property-panel-empty-icon" viewBox="0 0 48 48" width="48" height="48" fill="none" aria-hidden="true">
            <rect x="8" y="10" width="32" height="28" rx="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" opacity=".45" />
            <rect x="13" y="17" width="14" height="2.5" rx="1.25" fill="currentColor" opacity=".25" />
            <rect x="13" y="22" width="22" height="2" rx="1" fill="currentColor" opacity=".15" />
            <rect x="13" y="26.5" width="18" height="2" rx="1" fill="currentColor" opacity=".15" />
            <rect x="13" y="31" width="10" height="2" rx="1" fill="currentColor" opacity=".15" />
            <circle cx="38" cy="12" r="7" fill="var(--accent, #6366f1)" opacity=".12" />
            <path d="M38 9v6M35 12h6" stroke="var(--accent, #6366f1)" strokeWidth="1.5" strokeLinecap="round" opacity=".55" />
          </svg>
          <span className="property-panel-empty-title">No block selected</span>
          <span className="property-panel-empty-hint">Click any block on the canvas to edit its properties here</span>
        </div>
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
      {slug && slug !== "/" && onNavLabelChange ? (
        <NavLabelField slug={slug} navLabel={navLabel ?? ""} onNavLabelChange={onNavLabelChange} />
      ) : null}
      <div className="property-panel-header">
        <div className="property-panel-block-name">{meta.displayName}</div>
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
  onAiAssist
}: {
  listKey: string
  listField: ListFieldMeta
  items: Record<string, unknown>[]
  blockType: string | undefined
  onFieldChange: (fieldPath: string, value: string) => void
  onImageClick?: (fieldPath: string, currentUrl: string) => void
  onAiAssist?: (fieldPath: string, fieldLabel: string, fieldKind: string, currentValue: string) => void
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

function NavLabelField({ slug, navLabel, onNavLabelChange }: { slug: string; navLabel: string; onNavLabelChange: (slug: string, label: string) => void }) {
  const [local, setLocal] = useState(navLabel)
  const [focused, setFocused] = useState(false)
  const display = focused ? local : navLabel
  const { debouncedCommit, flushCommit } = useDebouncedCommit((v: string) => onNavLabelChange(slug, v), 400)

  return (
    <div className="property-panel-page-section">
      <div className="property-panel-block-name">Page</div>
      <div className="property-field">
        <div className="property-field-label"><span>Nav label for {slug}</span></div>
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
