import { extensionFromMimeType, orchestrator } from "../lib/editor-utils"

export function useMediaInput() {
  async function transcribeAudio(blob: Blob, mimeType: string) {
    const fileExt = extensionFromMimeType(mimeType)
    const file = new File([blob], `recording.${fileExt}`, {
      type: mimeType || blob.type || "audio/webm"
    })
    const form = new FormData()
    form.append("audio", file)

    const res = await fetch(`${orchestrator}/audio/transcribe`, {
      method: "POST",
      body: form
    })

    const data = (await res.json()) as { text?: string; error?: string; detail?: string }
    if (!res.ok) throw new Error(data.error ?? data.detail ?? "Transcription failed.")
    const text = (data.text ?? "").trim()
    if (!text) throw new Error("No speech detected. Try speaking more clearly or recording longer.")
    return text
  }

  async function interpretPastedImage(blob: Blob, mimeType: string) {
    const ext = extensionFromMimeType(mimeType)
    const file = new File([blob], `pasted-image.${ext}`, {
      type: mimeType || blob.type || "image/png"
    })
    const form = new FormData()
    form.append("image", file)

    const res = await fetch(`${orchestrator}/image/interpret`, {
      method: "POST",
      body: form
    })

    const data = (await res.json()) as { text?: string; error?: string; detail?: string }
    if (!res.ok) throw new Error(data.error ?? data.detail ?? "Image analysis failed.")
    const text = (data.text ?? "").trim()
    if (!text) throw new Error("Image analysis returned empty text.")
    return text
  }

  async function uploadPastedImage(blob: Blob, mimeType: string) {
    const ext = extensionFromMimeType(mimeType)
    const file = new File([blob], `pasted-image.${ext}`, {
      type: mimeType || blob.type || "image/png"
    })
    const form = new FormData()
    form.append("image", file)

    const res = await fetch(`${orchestrator}/image/upload`, {
      method: "POST",
      body: form
    })

    const data = (await res.json()) as { url?: string; error?: string; detail?: string }
    if (!res.ok) throw new Error(data.error ?? data.detail ?? "Image upload failed.")
    const url = (data.url ?? "").trim()
    if (!url) throw new Error("Image upload returned an empty URL.")
    return url
  }

  return { transcribeAudio, interpretPastedImage, uploadPastedImage }
}
