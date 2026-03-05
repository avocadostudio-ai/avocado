export type DraftSecretValidationResult =
  | { ok: true; reason: null }
  | { ok: false; reason: "missing_config" | "invalid_secret" }

const DRAFT_SECRET_KEYS = ["DRAFT_MODE_SECRET", "NEXT_DRAFT_MODE_SECRET"] as const

export function getConfiguredDraftSecret(env: Record<string, string | undefined> = process.env) {
  for (const key of DRAFT_SECRET_KEYS) {
    const value = env[key]?.trim()
    if (value) return value
  }
  return null
}

export function validateDraftSecret(
  receivedSecret: string | null | undefined,
  env: Record<string, string | undefined> = process.env
): DraftSecretValidationResult {
  const configuredSecret = getConfiguredDraftSecret(env)
  const normalized = receivedSecret?.trim() ?? ""
  if (!configuredSecret) return { ok: false, reason: "missing_config" }
  if (!normalized || normalized !== configuredSecret) return { ok: false, reason: "invalid_secret" }
  return { ok: true, reason: null }
}

export function getSafeRedirectPath(value: string | null) {
  if (!value) return "/"
  const decoded = decodeURIComponent(value).trim()
  if (!decoded.startsWith("/") || decoded.startsWith("//")) return "/"
  return decoded
}

