import { orchestrator } from "./site-urls"

export const ACCESS_GRANTED_STORAGE_KEY = "editor-access-granted"
export const ACCESS_TOKEN_STORAGE_KEY = "editor-access-token"
export const ACCESS_INVALIDATED_EVENT = "editor-access-invalidated"

function isBrowser() {
  return typeof window !== "undefined"
}

export function getStoredAccessToken() {
  if (!isBrowser()) return ""
  return sessionStorage.getItem(ACCESS_TOKEN_STORAGE_KEY)?.trim() ?? ""
}

export function setStoredAccessToken(token: string) {
  if (!isBrowser()) return
  const normalized = token.trim()
  if (!normalized) {
    sessionStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY)
    return
  }
  sessionStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, normalized)
}

export function clearStoredAccessToken() {
  if (!isBrowser()) return
  sessionStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY)
}

export function clearStoredAccessGrant() {
  if (!isBrowser()) return
  sessionStorage.removeItem(ACCESS_GRANTED_STORAGE_KEY)
  sessionStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY)
}

function isOrchestratorRequestUrl(value: string) {
  if (!isBrowser()) return false
  try {
    return new URL(value, window.location.href).origin === new URL(orchestrator).origin
  } catch {
    return false
  }
}

function withAccessTokenHeader(headers: HeadersInit | undefined, token: string) {
  const next = new Headers(headers ?? {})
  if (!next.has("x-access-token")) next.set("x-access-token", token)
  return next
}

let installed = false

export function installOrchestratorFetchAuthShim() {
  if (!isBrowser() || installed) return
  const originalFetch = window.fetch.bind(window)

  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const token = getStoredAccessToken()
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

    const isOrchestratorRequest = isOrchestratorRequestUrl(rawUrl)
    const requestPromise = (() => {
      if (!token || !isOrchestratorRequest) {
        return originalFetch(input, init)
      }
      if (input instanceof Request) {
        const mergedHeaders = withAccessTokenHeader(init?.headers ?? input.headers, token)
        return originalFetch(input, { ...(init ?? {}), headers: mergedHeaders })
      }
      return originalFetch(input, {
        ...(init ?? {}),
        headers: withAccessTokenHeader(init?.headers, token)
      })
    })()

    return requestPromise.then((response) => {
      if (!isOrchestratorRequest || response.status !== 401) return response
      void response
        .clone()
        .json()
        .then((body: unknown) => {
          const error = typeof body === "object" && body !== null ? String((body as { error?: unknown }).error ?? "") : ""
          if (error.toLowerCase() !== "unauthorized") return
          clearStoredAccessGrant()
          window.dispatchEvent(new Event(ACCESS_INVALIDATED_EVENT))
        })
        .catch(() => {})
      return response
    })
  }) as typeof fetch

  installed = true
}

export function withAccessTokenQuery(url: string) {
  if (!isBrowser()) return url
  const token = getStoredAccessToken()
  if (!token) return url

  try {
    const parsed = new URL(url, window.location.href)
    parsed.searchParams.set("accessToken", token)
    return parsed.toString()
  } catch {
    return url
  }
}
