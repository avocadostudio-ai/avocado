import {
  getConfiguredDraftSecret as resolveConfiguredSecret,
  getSafeInternalRedirectPath,
  validateDraftSecret
} from "../../../lib/draft-mode.ts"

export function getConfiguredDraftSecret(env: Record<string, string | undefined> = process.env) {
  return resolveConfiguredSecret(env)
}

export function isValidDraftSecret(receivedSecret: string | null | undefined, env: Record<string, string | undefined> = process.env) {
  return validateDraftSecret(receivedSecret, env)
}

export function getSafeRedirectPath(value: string | null) {
  return getSafeInternalRedirectPath(value)
}
