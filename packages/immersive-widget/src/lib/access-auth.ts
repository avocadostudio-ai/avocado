/**
 * Access token management for the immersive widget.
 * Shares the same sessionStorage key as the editor app so tokens carry over.
 */

const ACCESS_TOKEN_KEY = "editor-access-token"

export function getAccessToken(): string {
  try {
    return sessionStorage.getItem(ACCESS_TOKEN_KEY)?.trim() ?? ""
  } catch {
    return ""
  }
}

export function setAccessToken(token: string): void {
  try {
    if (token.trim()) {
      sessionStorage.setItem(ACCESS_TOKEN_KEY, token.trim())
    } else {
      sessionStorage.removeItem(ACCESS_TOKEN_KEY)
    }
  } catch {
    // sessionStorage unavailable
  }
}

/**
 * Check if the orchestrator requires auth. If not, returns true.
 * If yes, checks if we have a valid token.
 */
export async function checkAuth(orchestratorUrl: string): Promise<{ needsAuth: boolean; hasValidToken: boolean }> {
  const token = getAccessToken()

  try {
    const res = await fetch(`${orchestratorUrl}/auth/check`, {
      headers: token ? { "x-access-token": token } : {},
    })
    const data = (await res.json()) as { required?: boolean; authenticated?: boolean }
    return {
      needsAuth: data.required !== false,
      hasValidToken: data.authenticated === true,
    }
  } catch {
    // If /auth/check doesn't exist or fails, try a simple ping
    return { needsAuth: true, hasValidToken: false }
  }
}

/**
 * Verify a password and store the returned access token.
 */
export async function verifyPassword(orchestratorUrl: string, password: string): Promise<boolean> {
  try {
    const res = await fetch(`${orchestratorUrl}/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    })
    if (!res.ok) return false
    const data = (await res.json()) as { ok?: boolean; accessToken?: string }
    if (data.ok && data.accessToken) {
      setAccessToken(data.accessToken)
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * Add access token header to a headers object.
 */
export function withAuthHeaders(headers: Record<string, string>): Record<string, string> {
  const token = getAccessToken()
  if (token) {
    return { ...headers, "x-access-token": token }
  }
  return headers
}
