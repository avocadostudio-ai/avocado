import { siteOrigin } from "../../lib/editor-utils"

function resolvePreviewImageUrl(url: string): string {
  if (!url) return ""
  if (/^(https?:\/\/|data:|blob:)/i.test(url)) return url
  if (url.startsWith("/")) return `${siteOrigin}${url}`
  return url
}

export function PuckImageFieldControl({
  value,
  readOnly,
  onChoose,
  onClear,
}: {
  value: string
  readOnly: boolean
  onChoose: () => void
  onClear: () => void
}) {
  const hasValue = value.trim().length > 0
  const previewUrl = hasValue ? resolvePreviewImageUrl(value) : ""

  return (
    <div className="puck-poc-image-field">
      <div className="puck-poc-image-field__preview">
        {hasValue ? (
          <>
            <img src={previewUrl} alt="" />
            <span>{value}</span>
          </>
        ) : (
          <span className="puck-poc-image-field__placeholder">No image selected</span>
        )}
      </div>
      <div className="puck-poc-image-field__actions">
        <button type="button" onClick={onChoose} disabled={readOnly}>Choose image</button>
        <button type="button" onClick={onClear} disabled={readOnly || !hasValue}>Clear</button>
      </div>
    </div>
  )
}
