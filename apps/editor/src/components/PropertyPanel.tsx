import { useState, type ChangeEvent, type CSSProperties, type ReactNode } from "react"
import { getAllBlockMeta, type FieldMeta, type ListFieldMeta } from "@ai-site-editor/shared"

type Props = {
  style?: CSSProperties
  blockId: string | undefined
  blockType: string | undefined
  props: Record<string, unknown> | null
  status: "idle" | "loading" | "ready" | "error"
  onFieldChange: (fieldPath: string, value: string) => void
  onImageClick?: (fieldPath: string, currentUrl: string) => void
}

export function PropertyPanel({ style, blockId, blockType, props, status, onFieldChange, onImageClick }: Props) {
  if (!blockId || !blockType) {
    return (
      <div className="property-panel" style={style}>
        <div className="property-panel-empty">Select a block to edit its properties</div>
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
      <div className="property-panel-header">
        <div className="property-panel-title">Properties</div>
        <div className="property-panel-block-name">{meta.displayName}</div>
      </div>
      {status === "loading" && !props ? (
        <div className="property-panel-empty">Loading...</div>
      ) : status === "error" ? (
        <div className="property-panel-empty">Failed to load block properties</div>
      ) : props ? (
        <div className="property-panel-fields">
          {renderFieldEntries(Object.entries(meta.fields), props, "", onFieldChange, onImageClick)}
          {meta.listFields
            ? Object.entries(meta.listFields).map(([key, listField]) => {
                const items = Array.isArray(props[key]) ? (props[key] as Record<string, unknown>[]) : []
                return (
                  <ListFieldSection
                    key={key}
                    listKey={key}
                    listField={listField}
                    items={items}
                    onFieldChange={onFieldChange}
                    onImageClick={onImageClick}
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
  onFieldChange: (fieldPath: string, value: string) => void,
  onImageClick?: (fieldPath: string, currentUrl: string) => void
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
        />
      )
    } else {
      nodes.push(
        <FieldEditor
          key={key}
          fieldKey={key}
          field={field}
          value={data[key]}
          onCommit={(value) => onFieldChange(pathPrefix + key, value)}
        />
      )
    }
  }

  return nodes
}

function ImageFieldWidget({
  label,
  imageUrl,
  altText,
  onChangeClick,
  onAltCommit
}: {
  label: string
  imageUrl: string
  altText?: string
  onChangeClick: () => void
  onAltCommit?: (value: string) => void
}) {
  const [altLocal, setAltLocal] = useState(altText ?? "")
  const [altFocused, setAltFocused] = useState(false)
  const displayAlt = altFocused ? altLocal : (altText ?? "")

  return (
    <div className="property-field">
      <label className="property-field-label">{label}</label>
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
            <label className="property-field-image-alt-label">Image description</label>
            <input
              type="text"
              className="property-field-image-alt"
              placeholder="Describe what's in this image"
              value={displayAlt}
              onFocus={() => { setAltLocal(altText ?? ""); setAltFocused(true) }}
              onChange={(e) => setAltLocal(e.target.value)}
              onBlur={() => {
                setAltFocused(false)
                if (altLocal !== (altText ?? "")) onAltCommit(altLocal)
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
  onFieldChange,
  onImageClick
}: {
  listKey: string
  listField: ListFieldMeta
  items: Record<string, unknown>[]
  onFieldChange: (fieldPath: string, value: string) => void
  onImageClick?: (fieldPath: string, currentUrl: string) => void
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
                  onFieldChange,
                  onImageClick
                )}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function FieldEditor({
  fieldKey,
  field,
  value,
  onCommit
}: {
  fieldKey: string
  field: FieldMeta
  value: unknown
  onCommit: (value: string) => void
}) {
  const stringValue = value == null ? "" : String(value)
  const [localValue, setLocalValue] = useState(stringValue)
  const [focused, setFocused] = useState(false)

  // Sync from props when not focused
  const displayValue = focused ? localValue : stringValue

  const label = field.label ?? fieldKey

  const handleFocus = () => {
    setLocalValue(stringValue)
    setFocused(true)
  }

  const handleBlur = () => {
    setFocused(false)
    if (localValue !== stringValue) {
      onCommit(localValue)
    }
  }

  if (field.kind === "image") {
    return (
      <div className="property-field">
        <label className="property-field-label">{label}</label>
        <div className="property-field-image-url" title={stringValue}>
          {stringValue || "(empty)"}
        </div>
      </div>
    )
  }

  if (field.kind === "enum" && field.options) {
    return (
      <div className="property-field">
        <label className="property-field-label">{label}</label>
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
        <label className="property-field-label">{label}</label>
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
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setLocalValue(e.target.value),
    onBlur: handleBlur
  } as const

  return (
    <div className="property-field">
      <label className="property-field-label">{label}</label>
      {useTextarea ? (
        <textarea className="property-field-textarea" rows={3} {...sharedProps} />
      ) : (
        <input type={inputType} className="property-field-input" {...sharedProps} />
      )}
    </div>
  )
}
