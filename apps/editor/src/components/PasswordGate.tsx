import { useState, useEffect, type ReactNode } from "react"
import { useT } from "@/i18n"
import {
  ACCESS_GRANTED_STORAGE_KEY,
  clearStoredAccessToken,
  getStoredAccessToken,
  setStoredAccessToken
} from "@/lib/access-auth"

const ORCHESTRATOR_URL = import.meta.env.VITE_ORCHESTRATOR_URL as string

export function PasswordGate({ children }: { children: ReactNode }) {
  const { t } = useT()
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [password, setPassword] = useState("")
  const [error, setError] = useState(false)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    fetch(`${ORCHESTRATOR_URL}/auth/status`)
      .then((r) => r.json())
      .then((data) => {
        if (!data.gateEnabled) {
          clearStoredAccessToken()
          setAuthorized(true)
        } else {
          const hasGrant = Boolean(localStorage.getItem(ACCESS_GRANTED_STORAGE_KEY))
          const hasToken = getStoredAccessToken().length > 0
          setAuthorized(hasGrant && hasToken)
        }
      })
      .catch(() => {
        // Can't reach orchestrator — let through (local dev / orchestrator down)
        setAuthorized(true)
      })
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setChecking(true)
    setError(false)
    try {
      const res = await fetch(`${ORCHESTRATOR_URL}/auth/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: password.trim() }),
      })
      const data = (await res.json().catch(() => ({}))) as { accessToken?: string }
      if (res.ok) {
        localStorage.setItem(ACCESS_GRANTED_STORAGE_KEY, "1")
        setStoredAccessToken(data.accessToken ?? "")
        setAuthorized(true)
      } else {
        clearStoredAccessToken()
        setError(true)
      }
    } catch {
      clearStoredAccessToken()
      setError(true)
    }
    setChecking(false)
  }

  if (authorized === null) return null
  if (authorized) return <>{children}</>

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0a0a0a",
        fontFamily: "system-ui, sans-serif",
        zIndex: 99999,
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          width: 320,
          padding: 32,
          borderRadius: 12,
          background: "#18181b",
          border: "1px solid #27272a",
        }}
      >
        <h2 style={{ margin: 0, color: "#fafafa", fontSize: 18 }}>
          {t("password.title")}
        </h2>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t("password.placeholder")}
          autoFocus
          style={{
            padding: "10px 12px",
            borderRadius: 8,
            border: error ? "1px solid #ef4444" : "1px solid #3f3f46",
            background: "#09090b",
            color: "#fafafa",
            fontSize: 14,
            outline: "none",
          }}
        />
        {error && (
          <span style={{ color: "#ef4444", fontSize: 13 }}>
            {t("password.incorrect")}
          </span>
        )}
        <button
          type="submit"
          disabled={checking || !password.trim()}
          style={{
            padding: "10px 16px",
            borderRadius: 8,
            border: "none",
            background: "#3b82f6",
            color: "#fff",
            fontSize: 14,
            fontWeight: 500,
            cursor: "pointer",
            opacity: checking || !password.trim() ? 0.5 : 1,
          }}
        >
          {checking ? t("password.checking") : t("password.continue")}
        </button>
      </form>
    </div>
  )
}
