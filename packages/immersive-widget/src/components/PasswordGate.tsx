/**
 * Simple password prompt shown when the orchestrator requires auth
 * and no valid token exists.
 */

import { useState } from "react"
import { verifyPassword } from "../lib/access-auth"

type PasswordGateProps = {
  orchestratorUrl: string
  onAuthenticated: () => void
  onClose: () => void
}

export function PasswordGate({ orchestratorUrl, onAuthenticated, onClose }: PasswordGateProps) {
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async () => {
    if (!password.trim() || loading) return
    setLoading(true)
    setError(null)
    const ok = await verifyPassword(orchestratorUrl, password.trim())
    setLoading(false)
    if (ok) {
      onAuthenticated()
    } else {
      setError("Incorrect password")
    }
  }

  return (
    <div className="iw-panel">
      <div className="iw-panel-header">
        <span className="iw-panel-title">Authentication Required</span>
        <button type="button" className="iw-panel-close" onClick={onClose} aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m7 7 10 10" />
            <path d="M17 7 7 17" />
          </svg>
        </button>
      </div>
      <div className="iw-panel-messages" style={{ justifyContent: "center", alignItems: "center" }}>
        <div style={{ textAlign: "center", maxWidth: 260 }}>
          <p style={{ color: "#6b7280", fontSize: 13, marginBottom: 16 }}>
            Enter the editor password to start editing.
          </p>
          <input
            type="password"
            className="iw-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSubmit() }}
            placeholder="Password"
            disabled={loading}
            autoFocus
            style={{ width: "100%", marginBottom: 12 }}
          />
          {error && (
            <p style={{ color: "#ef4444", fontSize: 12, marginBottom: 8 }}>{error}</p>
          )}
          <button
            type="button"
            className="iw-send"
            onClick={handleSubmit}
            disabled={!password.trim() || loading}
            style={{ width: "100%", borderRadius: 12, height: 40 }}
          >
            {loading ? "Verifying..." : "Continue"}
          </button>
        </div>
      </div>
    </div>
  )
}
