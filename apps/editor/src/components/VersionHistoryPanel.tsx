import { useState, useEffect, useCallback } from "react"
import { ChevronDown } from "lucide-react"
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

type PublishStatus = "triggered" | "success" | "failed"

type PublishEntry = {
  id: string
  siteId: string
  target: string
  status: PublishStatus
  at: string
  updatedAt: string
  summary: string
  pageCount: number
  slugs: string[]
  commit?: string
  deploymentId?: string
  deploymentUrl?: string
  inspectUrl?: string
  error?: string
}

type LogItem =
  | { kind: "version"; sortAt: string; entry: VersionEntry }
  | { kind: "publish"; sortAt: string; entry: PublishEntry }

type VersionHistoryPanelProps = {
  session: string
  siteId: string
  slug: string
  visible: boolean
  onRestore?: (targetVersion: number) => void
  isRestoring?: boolean
}

const SOURCE_LABELS: Record<string, string> = {
  chat: "AI",
  direct: "Edit",
  undo: "Revert",
  redo: "Revert",
  bootstrap: "Sync",
  restore: "Restore"
}

function formatOpType(opType: string): string {
  return opType.replace(/_/g, " ")
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

export function VersionHistoryPanel({ session, siteId, slug, visible, onRestore, isRestoring }: VersionHistoryPanelProps) {
  const { t } = useT()
  const [items, setItems] = useState<LogItem[]>([])
  const [currentVersion, setCurrentVersion] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const fetchLog = useCallback(async () => {
    setIsLoading(true)
    try {
      const sessionQ = encodeURIComponent(session)
      const siteQ = encodeURIComponent(siteId)
      const [historyRes, publishRes] = await Promise.all([
        fetch(`${orchestrator}/history/log?session=${sessionQ}&siteId=${siteQ}&limit=50`),
        // Best-effort: publish log is independent — a 404/500 here must not
        // break the version-history view.
        fetch(`${orchestrator}/publish/log?session=${sessionQ}&siteId=${siteQ}&limit=50`).catch(
          () => null
        ),
      ])

      const historyItems: LogItem[] = []
      let nextCurrent = 0
      if (historyRes.ok) {
        const data = (await historyRes.json()) as { entries: VersionEntry[]; currentVersion: number }
        nextCurrent = data.currentVersion
        for (const entry of data.entries) {
          historyItems.push({ kind: "version", sortAt: entry.at, entry })
        }
      }

      const publishItems: LogItem[] = []
      if (publishRes && publishRes.ok) {
        const data = (await publishRes.json()) as { entries: PublishEntry[] }
        for (const entry of data.entries) {
          // Sort publishes by updatedAt so a transition to Live bubbles them
          // up next to the user's most recent action.
          publishItems.push({ kind: "publish", sortAt: entry.updatedAt || entry.at, entry })
        }
      }

      const merged = [...historyItems, ...publishItems].sort((a, b) =>
        a.sortAt.localeCompare(b.sortAt)
      )
      setItems(merged)
      setCurrentVersion(nextCurrent)
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
        {isLoading && items.length === 0 ? (
          <div className="version-history-empty">{t("history.loading")}</div>
        ) : items.length === 0 ? (
          <div className="version-history-empty">{t("history.empty")}</div>
        ) : (
          <ul className="version-history-list">
            {[...items].reverse().map((item, idx) => {
              if (item.kind === "publish") {
                return (
                  <PublishItemRow
                    key={`pub-${item.entry.id}`}
                    entry={item.entry}
                    expanded={expanded.has(`pub-${item.entry.id}`)}
                    onToggleExpanded={() => toggleExpanded(`pub-${item.entry.id}`)}
                    t={t}
                  />
                )
              }
              const entry = item.entry
              const hasDetails = entry.opTypes.length > 0
              const expandKey = `ver-${entry.version}`
              const isExpanded = expanded.has(expandKey)
              return (
                <li
                  key={`${entry.version}-${idx}`}
                  className={`version-history-item ${entry.version === currentVersion ? "is-current" : ""}`}
                >
                  <div className="version-history-item-header">
                    <span className={`version-history-source version-history-source--${entry.source}`}>
                      {SOURCE_LABELS[entry.source] ?? entry.source}
                    </span>
                    <span className="version-history-time">{formatTime(entry.at)}</span>
                    {entry.version === currentVersion ? (
                      <span className="version-history-current-label">{t("history.current")}</span>
                    ) : onRestore ? (
                      <button
                        type="button"
                        className="version-history-restore-btn"
                        disabled={isRestoring}
                        onClick={() => onRestore(entry.version)}
                      >
                        {isRestoring ? t("history.restoring") : t("history.restore")}
                      </button>
                    ) : null}
                  </div>
                  {entry.source !== "undo" && entry.source !== "redo" ? (
                    <div className="version-history-summary">{renderFinalMarkdown(entry.summary)}</div>
                  ) : null}
                  {entry.opCount > 0 ? (
                    <div className="version-history-meta-row">
                      <span className="version-history-meta">
                        {entry.opCount} {entry.opCount === 1 ? t("history.operation") : t("history.operations")}
                        {entry.slug !== "/" ? ` · ${entry.slug}` : ""}
                      </span>
                      {hasDetails ? (
                        <button
                          type="button"
                          className={`version-history-expand-btn ${isExpanded ? "is-open" : ""}`}
                          onClick={() => toggleExpanded(expandKey)}
                          aria-expanded={isExpanded}
                          aria-label={isExpanded ? t("history.hideDetails") : t("history.showDetails")}
                          title={isExpanded ? t("history.hideDetails") : t("history.showDetails")}
                        >
                          <ChevronDown size={14} aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {hasDetails && isExpanded ? (
                    <dl className="version-history-details">
                      <dt>{t("history.version")}</dt>
                      <dd>v{entry.version}</dd>
                      <dt>{t("history.page")}</dt>
                      <dd>{entry.slug}</dd>
                      <dt>{t("history.changes")}</dt>
                      <dd>
                        <ul className="version-history-op-list">
                          {entry.opTypes.map((opType, i) => (
                            <li key={`${opType}-${i}`}>{formatOpType(opType)}</li>
                          ))}
                        </ul>
                      </dd>
                    </dl>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Publish-entry row
// ---------------------------------------------------------------------------
type TFunction = ReturnType<typeof useT>["t"]

function publishStatusLabel(status: PublishStatus, t: TFunction): string {
  if (status === "success") return t("history.live")
  if (status === "failed") return t("history.deployFailed")
  return t("history.deploying")
}

function PublishItemRow({
  entry,
  expanded,
  onToggleExpanded,
  t,
}: {
  entry: PublishEntry
  expanded: boolean
  onToggleExpanded: () => void
  t: TFunction
}) {
  const link = entry.inspectUrl || entry.deploymentUrl
  const showExpand = Boolean(entry.error)
  return (
    <li className="version-history-item version-history-item--publish">
      <div className="version-history-item-header">
        <span className="version-history-source version-history-source--publish">
          {t("history.publish")}
        </span>
        <span
          className={`version-history-publish-status version-history-publish-status--${entry.status}`}
        >
          {publishStatusLabel(entry.status, t)}
        </span>
        <span className="version-history-time">{formatTime(entry.updatedAt || entry.at)}</span>
        {link ? (
          <a
            className="version-history-deploy-link"
            href={link}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("history.viewDeploy")}
          </a>
        ) : null}
      </div>
      <div className="version-history-summary">{entry.summary}</div>
      <div className="version-history-meta-row">
        <span className="version-history-meta">
          {entry.pageCount === 1
            ? t("history.pagePublished")
            : t("history.pagesPublished", { count: String(entry.pageCount) })}
          {entry.commit ? ` · ${entry.commit.slice(0, 7)}` : ""}
        </span>
        {showExpand ? (
          <button
            type="button"
            className={`version-history-expand-btn ${expanded ? "is-open" : ""}`}
            onClick={onToggleExpanded}
            aria-expanded={expanded}
            aria-label={expanded ? t("history.hideDetails") : t("history.showDetails")}
            title={expanded ? t("history.hideDetails") : t("history.showDetails")}
          >
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {showExpand && expanded ? (
        <dl className="version-history-details">
          <dt>{t("history.deployFailed")}</dt>
          <dd>{entry.error}</dd>
        </dl>
      ) : null}
    </li>
  )
}
