export type DraftSecretValidationResult =
  | { ok: true; reason: null }
  | { ok: false; reason: "missing_config" | "invalid_secret" }

const DEFAULT_DRAFT_SECRET_KEYS = ["DRAFT_MODE_SECRET", "NEXT_DRAFT_MODE_SECRET"] as const

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

