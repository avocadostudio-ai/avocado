/**
 * Infrastructure singleton — the DAG leaf.
 *
 * Holds process-scoped, rarely-changing state that must be available
 * before React mounts and readable from anywhere without triggering
 * re-renders.  Imports nothing from the store or React.
 *
 * All access goes through getter/setter functions so the object itself
 * is never leaked.  Call `initSession()` once from App() before
 * EditorPage mounts.
 */

// ── The singleton — never exported ──────────────────────────────────
const SESSION = {
  sessionId: "dev",
  siteId: "",
  editorOrigin: "",
  orchestratorUrl: "",
}

// ── Getters ─────────────────────────────────────────────────────────
export function getSessionId(): string {
  return SESSION.sessionId
}

export function getSiteId(): string {
  return SESSION.siteId
}

export function getEditorOrigin(): string {
  return SESSION.editorOrigin
}

export function getOrchestratorUrl(): string {
  return SESSION.orchestratorUrl
}

// ── Setters ─────────────────────────────────────────────────────────
export function setSessionId(id: string): void {
  SESSION.sessionId = id
}

export function setSiteId(id: string): void {
  SESSION.siteId = id
}

export function setEditorOrigin(origin: string): void {
  SESSION.editorOrigin = origin
}

export function setOrchestratorUrl(url: string): void {
  SESSION.orchestratorUrl = url
}

// ── Bootstrap ───────────────────────────────────────────────────────
export function initSession(opts: {
  siteId: string
  editorOrigin: string
  orchestratorUrl: string
}): void {
  SESSION.siteId = opts.siteId
  SESSION.editorOrigin = opts.editorOrigin
  SESSION.orchestratorUrl = opts.orchestratorUrl
}
