import { useState, useEffect, useCallback } from "react"
import { orchestrator } from "../lib/editor-utils"
import { renderFinalMarkdown } from "../lib/markdown-renderer"
import { useT } from "../i18n"

type VersionEntry = {
  version: number
  slug: string
  summary: string
  opTypes: string[]
  opCount: number
  at: string
  source: "chat" | "direct" | "undo" | "redo" | "bootstrap" | "restore"
}

type VersionHistoryPanelProps = {
  session: string
  siteId: string
  slug: string
  visible: boolean
}

const SOURCE_LABELS: Record<string, string> = {
  chat: "AI",
  direct: "Edit",
  undo: "Undo",
  redo: "Redo",
  bootstrap: "Sync",
  restore: "Restore"
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  if (diffMs < 60_000) return "just now"
  if (diffMs < 3600_000) return `${Math.floor(diffMs / 60_000)}m ago`
  if (diffMs < 86400_000) return `${Math.floor(diffMs / 3600_000)}h ago`
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

export function VersionHistoryPanel({ session, siteId, slug, visible }: VersionHistoryPanelProps) {
  const { t } = useT()
  const [entries, setEntries] = useState<VersionEntry[]>([])
  const [currentVersion, setCurrentVersion] = useState(0)
  const [isLoading, setIsLoading] = useState(false)

  const fetchLog = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await fetch(
        `${orchestrator}/history/log?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(siteId)}&limit=50`
      )
      if (res.ok) {
        const data = (await res.json()) as { entries: VersionEntry[]; currentVersion: number }
        setEntries(data.entries)
        setCurrentVersion(data.currentVersion)
      }
    } catch {
      // Best-effort
    } finally {
      setIsLoading(false)
    }
  }, [session, siteId])

  useEffect(() => {
    if (visible) void fetchLog()
  }, [visible, slug, fetchLog])

  if (!visible) return null

  return (
    <div className="version-history-panel">
      <div className="version-history-header">
        <h3>{t("history.title")}</h3>
        <span className="version-history-version">v{currentVersion}</span>
      </div>
      <div className="version-history-body">
        {isLoading && entries.length === 0 ? (
          <div className="version-history-empty">{t("history.loading")}</div>
        ) : entries.length === 0 ? (
          <div className="version-history-empty">{t("history.empty")}</div>
        ) : (
          <ul className="version-history-list">
            {[...entries].reverse().map((entry, idx) => (
              <li
                key={`${entry.version}-${idx}`}
                className={`version-history-item ${entry.version === currentVersion ? "is-current" : ""}`}
              >
                <div className="version-history-item-header">
                  <span className={`version-history-source version-history-source--${entry.source}`}>
                    {SOURCE_LABELS[entry.source] ?? entry.source}
                  </span>
                  <span className="version-history-time">{formatTime(entry.at)}</span>
                </div>
                <div className="version-history-summary">{renderFinalMarkdown(entry.summary)}</div>
                {entry.opCount > 0 ? (
                  <div className="version-history-meta">
                    {entry.opCount} {entry.opCount === 1 ? t("history.operation") : t("history.operations")}
                    {entry.slug !== "/" ? ` \u00b7 ${entry.slug}` : ""}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
