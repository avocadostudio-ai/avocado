/**
 * Lightweight validation / parsing helpers for unknown values coming from
 * JSON, localStorage, postMessage payloads, etc.
 */

/** Return trimmed string when `value` is a non-empty string, `fallback` otherwise. */
export function parseString(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

/**
 * Like `parseString` but returns `undefined` instead of a fallback when the
 * value is missing or empty.  Handy for optional fields.
 */
export function parseOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Filters + trims an unknown value into a `string[]`.
 * Keeps only non-empty trimmed strings.  Returns `fallback` when the input is
 * not an array or every element is empty.
 */
export function parseArrayOfStrings(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) return fallback
  const result = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
  return result.length > 0 ? result : fallback
}
