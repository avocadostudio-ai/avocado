export type StreamingIndicatorStyle = "text" | "legacy"

function parseStreamingIndicatorStyle(value: string | undefined): StreamingIndicatorStyle | null {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return null
  if (normalized === "text") return "text"
  if (normalized === "legacy" || normalized === "sparkle" || normalized === "dots" || normalized === "sparkle-dots") return "legacy"
  return null
}

export function resolveStreamingIndicatorStyle(): StreamingIndicatorStyle {
  const fromEnv = parseStreamingIndicatorStyle(import.meta.env.VITE_STREAMING_INDICATOR_STYLE as string | undefined)
  if (fromEnv) return fromEnv
  return "text"
}
