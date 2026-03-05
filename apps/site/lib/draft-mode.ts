export type DraftSecretValidationResult =
  | { ok: true }
  | { ok: false; reason: "missing_config" | "missing_secret" | "invalid_secret" }

export function getConfiguredDraftSecret(env: Record<string, string | undefined> = process.env) {
  const raw = env.DRAFT_MODE_SECRET?.trim()
  return raw && raw.length > 0 ? raw : null
}

export function validateDraftSecret(
  receivedSecret: string | null | undefined,
  env: Record<string, string | undefined> = process.env
): DraftSecretValidationResult {
  const configured = getConfiguredDraftSecret(env)
  if (!configured) return { ok: false, reason: "missing_config" }
  if (!receivedSecret || receivedSecret.trim().length === 0) return { ok: false, reason: "missing_secret" }
  if (receivedSecret !== configured) return { ok: false, reason: "invalid_secret" }
  return { ok: true }
}

export function getSafeInternalRedirectPath(value: string | null) {
  if (!value) return "/"
  const trimmed = value.trim()
  if (!trimmed) return "/"

  const decoded = (() => {
    try {
      return decodeURIComponent(trimmed)
    } catch {
      return trimmed
    }
  })()
  if (!decoded.startsWith("/")) return "/"
  if (decoded.startsWith("//")) return "/"
  return decoded
}
