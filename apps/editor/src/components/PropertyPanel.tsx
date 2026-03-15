import { useState, type ChangeEvent, type CSSProperties } from "react"
import { getAllBlockMeta, type FieldMeta, type ListFieldMeta } from "@ai-site-editor/shared"

type Props = {
  style?: CSSProperties
  blockId: string | undefined
  blockType: string | undefined
  props: Record<string, unknown> | null
  status: "idle" | "loading" | "ready" | "error"
  onFieldChange: (fieldPath: string, value: string) => void
}

export function PropertyPanel({ style, blockId, blockType, props, status, onFieldChange }: Props) {
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
          {Object.entries(meta.fields).map(([key, field]) => (
            <FieldEditor
              key={key}
              fieldKey={key}
              field={field}
              value={props[key]}
              onCommit={(value) => onFieldChange(key, value)}
            />
          ))}
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
                  />
                )
              })
            : null}
        </div>
      ) : null}
    </div>
  )
}

function ListFieldSection({
  listKey,
  listField,
  items,
  onFieldChange
}: {
  listKey: string
  listField: ListFieldMeta
  items: Record<string, unknown>[]
  onFieldChange: (fieldPath: string, value: string) => void
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
                {Object.entries(listField.itemFields).map(([fieldKey, field]) => (
                  <FieldEditor
                    key={fieldKey}
                    fieldKey={fieldKey}
                    field={field}
                    value={item[fieldKey]}
                    onCommit={(value) => onFieldChange(`${listKey}[${index}].${fieldKey}`, value)}
                  />
                ))}
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

  const useTextarea = field.kind === "richtext" || fieldKey === "body" || fieldKey === "description"
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
