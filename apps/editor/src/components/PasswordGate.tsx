import { useState, useEffect, type ReactNode } from "react"

const ORCHESTRATOR_URL = import.meta.env.VITE_ORCHESTRATOR_URL as string
const SESSION_KEY = "editor-access-granted"

export function PasswordGate({ children }: { children: ReactNode }) {
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [password, setPassword] = useState("")
  const [error, setError] = useState(false)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    if (sessionStorage.getItem(SESSION_KEY)) {
      setAuthorized(true)
      return
    }
    fetch(`${ORCHESTRATOR_URL}/auth/status`)
      .then((r) => r.json())
      .then((data) => {
        if (!data.gateEnabled) {
          setAuthorized(true)
        } else {
          setAuthorized(false)
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
      if (res.ok) {
        sessionStorage.setItem(SESSION_KEY, "1")
        setAuthorized(true)
      } else {
        setError(true)
      }
    } catch {
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
          Editor Access
        </h2>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
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
            Incorrect password
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
          {checking ? "Checking…" : "Continue"}
        </button>
      </form>
    </div>
  )
}
