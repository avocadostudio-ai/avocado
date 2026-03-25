export type DraftSecretValidationResult =
  | { ok: true; reason: null }
  | { ok: false; reason: "missing_config" | "invalid_secret" }

// Accept multiple env var names so the same secret works across site and editor.
// VITE_SITE_DRAFT_SECRET is the editor's name; accepting it here means you can
// set one var in a shared .env and it works for both site and editor.
const DEFAULT_DRAFT_SECRET_KEYS = ["DRAFT_MODE_SECRET", "VITE_SITE_DRAFT_SECRET", "NEXT_DRAFT_MODE_SECRET"] as const

export function getConfiguredDraftSecret(
  env: Record<string, string | undefined>,
  keys: readonly string[] = DEFAULT_DRAFT_SECRET_KEYS
) {
  for (const key of keys) {
    const value = env[key]?.trim()
    if (value) return value
  }
  return null
}

export function validateDraftSecret(
  receivedSecret: string | null | undefined,
  env: Record<string, string | undefined>,
  keys: readonly string[] = DEFAULT_DRAFT_SECRET_KEYS
): DraftSecretValidationResult {
  const configuredSecret = getConfiguredDraftSecret(env, keys)
  const normalizedReceived = receivedSecret?.trim() ?? ""
  if (!configuredSecret) return { ok: false, reason: "missing_config" }
  if (!normalizedReceived || normalizedReceived !== configuredSecret) return { ok: false, reason: "invalid_secret" }
  return { ok: true, reason: null }
}

export function getSafeInternalRedirectPath(value: string | null) {
  if (!value) return "/"
  const decoded = decodeURIComponent(value).trim()
  if (!decoded.startsWith("/") || decoded.startsWith("//")) return "/"
  return decoded
}

