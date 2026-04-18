/**
 * Lightweight chat state for the immersive widget.
 * Persisted in sessionStorage so it survives Next.js page navigations.
 */

export type WidgetChatEntry = {
  id: string
  role: "user" | "assistant"
  text: string
  changes?: string[]
  suggestions?: string[]
  timestamp: number
}

export type WidgetConfig = {
  orchestratorUrl: string
  session: string
  siteId: string
  /** Origin of the main editor (apps/editor). Enables the "Back" pill when present. */
  editorOrigin?: string
}

const STORAGE_PREFIX = "immersive-chat"

function storageKey(session: string, siteId: string): string {
  return `${STORAGE_PREFIX}:${session}:${siteId}`
}

export function loadChatHistory(session: string, siteId: string): WidgetChatEntry[] {
  try {
    const raw = sessionStorage.getItem(storageKey(session, siteId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as WidgetChatEntry[]
    return Array.isArray(parsed) ? parsed.slice(-50) : []
  } catch {
    return []
  }
}

export function saveChatHistory(session: string, siteId: string, entries: WidgetChatEntry[]): void {
  try {
    sessionStorage.setItem(storageKey(session, siteId), JSON.stringify(entries.slice(-50)))
  } catch {
    // sessionStorage full or unavailable
  }
}

let idCounter = 0
export function nextEntryId(): string {
  return `iw-${Date.now()}-${++idCounter}`
}
