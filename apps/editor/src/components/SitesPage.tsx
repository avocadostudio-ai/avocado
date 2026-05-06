import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Bot, Trash2, X } from "lucide-react"
import { blockManifestSchema, validateManifestDefaultProps } from "@ai-site-editor/shared"
import { SiteTileDesktopPreview } from "./SiteTileDesktopPreview"
import { SitesAgentChat } from "./SitesAgentChat"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { SiteConfigDrawer } from "./SiteConfigDrawer"
import { buildSiteDraftEnableUrl, LEGACY_AVOCADO_SITE_ID, resolveSiteOrigin } from "../lib/editor-utils"
import { useT, LOCALE_LABELS, type Locale } from "@/i18n"
import { useSitesAgent } from "../hooks/useSitesAgent"
import type { UseSiteListReturn } from "../hooks/useSiteList"
import type { SiteConfig } from "../lib/editor-types"

function compactPurposeText(value: string) {
  const normalized = value
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*/g, " ")
    .trim()
  if (!normalized) return ""
  const firstSentence = normalized.match(/^(.{1,220}?[.!?])(?:\s|$)/)?.[1] ?? normalized
  if (firstSentence.length <= 220) return firstSentence
  return `${firstSentence.slice(0, 217).trimEnd()}...`
}

export function SitesPage({ sites, session }: { sites: UseSiteListReturn; session: string }) {
  const { t, locale, setLocale } = useT()
  const localeEntries = Object.entries(LOCALE_LABELS) as [Locale, string][]
  const [addAiTab, setAddAiTab] = useState<"overview" | "tone" | "constraints">("overview")

  const handleSiteCreated = useCallback((config: SiteConfig) => {
    sites.addSiteFromConfig(config)
  }, [sites.addSiteFromConfig])

  const agent = useSitesAgent({ session, locale, onSiteCreated: handleSiteCreated })

  const dedupedSites = useMemo(() => sites.siteList
    .filter((site, index, all) => all.findIndex((row) => row.id === site.id) === index)
    .sort((a, b) => {
      const aLegacy = a.id === LEGACY_AVOCADO_SITE_ID ? 1 : 0
      const bLegacy = b.id === LEGACY_AVOCADO_SITE_ID ? 1 : 0
      return aLegacy - bLegacy
    }), [sites.siteList])

  const [showAllSites, setShowAllSites] = useState(false)
  const [agentOpen, setAgentOpen] = useState(() => {
    if (typeof window === "undefined") return false
    return new URLSearchParams(window.location.search).get("agent") === "1"
  })

  // Strip the ?agent=1 hint from the URL once consumed so reloads don't re-open it.
  useEffect(() => {
    if (typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    if (params.get("agent") !== "1") return
    params.delete("agent")
    const search = params.toString()
    const next = window.location.pathname + (search ? `?${search}` : "") + window.location.hash
    window.history.replaceState({}, "", next)
  }, [])
  const [pendingDeleteSiteId, setPendingDeleteSiteId] = useState<string | null>(null)
  const pendingDeleteSite = dedupedSites.find((s) => s.id === pendingDeleteSiteId) ?? null

  // Auto-open sidebar when agent starts streaming (assistant-ui openOnRunStart pattern)
  const wasStreamingRef = useRef(false)
  useEffect(() => {
    if (agent.isStreaming && !wasStreamingRef.current) {
      setAgentOpen(true)
    }
    wasStreamingRef.current = agent.isStreaming
  }, [agent.isStreaming])

  const [capabilityBySiteId, setCapabilityBySiteId] = useState<Record<string, {
    status: "loading" | "ready" | "degraded"
    summary: string
    reason?: string
  }>>({})

  useEffect(() => {
    let active = true
    const run = async () => {
      const loadingMap: Record<string, { status: "loading"; summary: string }> = {}
      for (const site of dedupedSites) {
        loadingMap[site.id] = { status: "loading", summary: t("sites.checkingManifest") }
      }
      if (active) setCapabilityBySiteId(loadingMap)

      await Promise.all(
        dedupedSites.map(async (site) => {
          const url = new URL(`${resolveSiteOrigin(site)}/api/editor/blocks`)
          url.searchParams.set("siteId", site.id)
          try {
            const res = await fetch(url.toString())
            if (!res.ok) {
              if (!active) return
              setCapabilityBySiteId((prev) => ({
                ...prev,
                [site.id]: {
                  status: "degraded",
                  summary: t("sites.limitedEditing"),
                  reason: `Manifest endpoint returned ${res.status}`
                }
              }))
              return
            }
            const json = (await res.json()) as unknown
            const parsed = blockManifestSchema.safeParse(json)
            if (!parsed.success) {
              if (!active) return
              setCapabilityBySiteId((prev) => ({
                ...prev,
                [site.id]: {
                  status: "degraded",
                  summary: t("sites.limitedEditing"),
                  reason: "Manifest response shape is invalid"
                }
              }))
              return
            }
            const defaultsError = validateManifestDefaultProps(parsed.data.blocks)
            if (defaultsError) {
              if (!active) return
              setCapabilityBySiteId((prev) => ({
                ...prev,
                [site.id]: {
                  status: "degraded",
                  summary: t("sites.limitedEditing"),
                  reason: defaultsError
                }
              }))
              return
            }
            if (!active) return
            setCapabilityBySiteId((prev) => ({
              ...prev,
              [site.id]: {
                status: "ready",
                summary: `${parsed.data.blocks.length} blocks found`
              }
            }))
          } catch (error) {
            if (!active) return
            setCapabilityBySiteId((prev) => ({
              ...prev,
              [site.id]: {
                status: "degraded",
                summary: t("sites.limitedEditing"),
                reason: error instanceof Error ? error.message : "Manifest fetch failed"
              }
            }))
          }
        })
      )
    }
    void run()
    return () => {
      active = false
    }
  }, [dedupedSites])

  const allChecked = Object.keys(capabilityBySiteId).length === dedupedSites.length
  const offlineCount = allChecked ? dedupedSites.filter(s => capabilityBySiteId[s.id]?.status !== "ready").length : 0
  const visibleSites = showAllSites ? dedupedSites : dedupedSites.filter(s => {
    const cap = capabilityBySiteId[s.id]
    // Show while still loading (checking), hide only confirmed offline
    return !cap || cap.status === "loading" || cap.status === "ready"
  })

  return (
    <div className="sites-layout">
    {agentOpen && (
      <div className="sites-agent-sidebar">
        <button type="button" className="sites-agent-sidebar-close" onClick={() => setAgentOpen(false)}>
          <X size={16} />
        </button>
        <SitesAgentChat agent={agent} />
      </div>
    )}
    {!agentOpen && (
      <button type="button" className="sites-agent-fab" onClick={() => setAgentOpen(true)} title={t("sitesAgent.title")}>
        <Bot size={20} />
      </button>
    )}
    <main className="sites-page">
      <header className="sites-header">
        <div>
          <h1>{t("sites.title")}</h1>
          <p>{t("sites.subtitle")}</p>
        </div>
        <div className="sites-header-actions">
          <select
            className="sites-locale-select"
            value={locale}
            onChange={(e) => setLocale(e.target.value as Locale)}
            aria-label={t("settings.language")}
          >
            {localeEntries.map(([code, label]) => (
              <option key={code} value={code}>{label}</option>
            ))}
          </select>
          <button
            type="button"
            className="primary-btn"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            onClick={() => {
              sites.resetNewSiteForm()
              setAddAiTab("overview")
              sites.setShowSiteModal(true)
            }}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" style={{ stroke: "currentColor", fill: "none", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }}>
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {t("sites.addSite")}
          </button>
        </div>
      </header>
      {offlineCount > 0 && (
        <div className="sites-offline-toggle">
          <Switch id="show-offline" checked={showAllSites} onCheckedChange={setShowAllSites} />
          <Label htmlFor="show-offline">Show {offlineCount} offline site{offlineCount > 1 ? "s" : ""}</Label>
        </div>
      )}
      {dedupedSites.length > 0 && visibleSites.length === 0 ? (
        <div className="sites-empty-state" role="status" style={{ padding: "32px 16px", textAlign: "center" }}>
          <h2 style={{ marginBottom: 8 }}>{t("sites.allOffline")}</h2>
          <p style={{ marginBottom: 16, color: "var(--muted-foreground, #888)" }}>{t("sites.allOfflineHint")}</p>
          <button type="button" className="secondary-btn" onClick={() => setShowAllSites(true)}>
            Show {dedupedSites.length} offline site{dedupedSites.length > 1 ? "s" : ""}
          </button>
        </div>
      ) : null}
      <section className="sites-grid" aria-label="Site tiles">
        {visibleSites.map((site) => {
          const capability = capabilityBySiteId[site.id]
          const previewSrc = buildSiteDraftEnableUrl("/", {
            session,
            siteId: site.id,
            __refresh: String(sites.siteTileRefreshToken)
          }, resolveSiteOrigin(site))
          return (
            <article key={site.id} className="site-tile">
              <button
                type="button"
                className="site-tile-delete-btn"
                onClick={() => setPendingDeleteSiteId(site.id)}
                aria-label={`${t("sites.deleteSite")} ${site.name}`}
              >
                <Trash2 size={14} />
              </button>
              <SiteTileDesktopPreview title={`${site.name} home preview`} src={previewSrc} onClick={() => sites.openEditorForSite(site.id)} />
              <div className="site-tile-meta">
                <h2>
                  {site.name}
                  {capability ? (
                    <span
                      className={
                        capability.status === "ready"
                          ? "site-status-dot site-status-dot-ready"
                          : capability.status === "degraded"
                            ? "site-status-dot site-status-dot-degraded"
                            : "site-status-dot"
                      }
                      title={capability.status === "ready" ? t("sites.editingReady") : capability.status === "degraded" ? `${t("sites.limitedEditing")}: ${capability.reason}` : t("sites.checking")}
                    />
                  ) : null}
                </h2>
                <p className="site-local-url">{resolveSiteOrigin(site)}</p>
                {site.purpose ? <p className="site-purpose">{compactPurposeText(site.purpose)}</p> : null}
                <div className="site-tile-actions">
                  <button type="button" className="secondary-btn site-config-btn" onClick={() => sites.setConfigSiteId(site.id)} aria-label={`Configure ${site.name}`} title={t("sites.settings")}>
                    <svg viewBox="0 0 20 20" aria-hidden="true">
                      <path d="M8.8 2h2.4l.5 2.1a6.7 6.7 0 0 1 1.5.6l1.9-1.1 1.7 1.7-1.1 1.9c.2.5.4 1 .5 1.5l2.1.5v2.4l-2.1.5a6.7 6.7 0 0 1-.6 1.5l1.1 1.9-1.7 1.7-1.9-1.1a6.7 6.7 0 0 1-1.5.6L11.2 18H8.8l-.5-2.1a6.7 6.7 0 0 1-1.5-.6l-1.9 1.1-1.7-1.7 1.1-1.9a6.7 6.7 0 0 1-.6-1.5L2 11.2V8.8l2.1-.5c.1-.5.3-1 .6-1.5L3.6 4.9l1.7-1.7 1.9 1.1c.5-.2 1-.4 1.5-.5L8.8 2z" />
                      <circle cx="10" cy="10" r="2.4" />
                    </svg>
                  </button>
                  <button type="button" className="secondary-btn site-config-btn" onClick={() => void sites.openRestoreModal(site.id)} aria-label={`Version history for ${site.name}`} title={t("sites.versionHistory")}>
                    <svg viewBox="0 0 20 20" aria-hidden="true">
                      <path d="M10 2a8 8 0 1 0 8 8 8 8 0 0 0-8-8zm0 14a6 6 0 1 1 6-6 6 6 0 0 1-6 6z" />
                      <path d="M10 6v4l3 2" />
                    </svg>
                  </button>
                  <button type="button" className="primary-btn" onClick={() => sites.openEditorForSite(site.id)}>
                    <span>{t("sites.openEditor")}</span>
                    <svg viewBox="0 0 20 20" aria-hidden="true">
                      <path d="M7 5h8v8" />
                      <path d="m7 13 8-8" />
                    </svg>
                  </button>
                </div>
              </div>
            </article>
          )
        })}
      </section>
      {sites.showSiteModal ? (
        <div className="sites-modal-backdrop" onClick={() => sites.setShowSiteModal(false)}>
          <section className="sites-modal" role="dialog" aria-modal="true" aria-label={t("sites.addSite")} onClick={(event) => event.stopPropagation()}>
            <header className="sites-modal-header">
              <h2>{t("sites.addSiteTitle")}</h2>
              <button type="button" className="settings-close-btn" onClick={() => sites.setShowSiteModal(false)} aria-label={t("sites.close")}>
                ×
              </button>
            </header>
            <div className="sites-modal-body">
              <div className="sites-form-grid">
                <p className="sites-form-section-title">{t("sites.coreSettings")}</p>
                <label className="sites-form-field">
                  <span>{t("sites.siteName")}</span>
                  <input
                    type="text"
                    value={sites.newSiteForm.name}
                    placeholder={t("sites.siteNamePlaceholder")}
                    onChange={(event) => sites.updateNewSiteForm({ name: event.target.value })}
                  />
                </label>
                <label className="sites-form-field">
                  <span>{t("sites.previewUrl")}</span>
                  <input
                    type="url"
                    value={sites.newSiteForm.previewUrl}
                    placeholder={t("sites.previewUrlPlaceholder")}
                    onChange={(event) => sites.updateNewSiteForm({ previewUrl: event.target.value })}
                  />
                </label>
                <p className="sites-form-section-title">{t("sites.editorialBrief")}</p>
                <div className="sites-form-field sites-form-field-wide">
                  <div className="sites-ai-tabs" role="tablist" aria-label={t("sites.editorialBrief")}>
                    <button type="button" className={addAiTab === "overview" ? "sites-ai-tab active" : "sites-ai-tab"} onClick={() => setAddAiTab("overview")}>
                      {t("sites.overview")}
                    </button>
                    <button type="button" className={addAiTab === "tone" ? "sites-ai-tab active" : "sites-ai-tab"} onClick={() => setAddAiTab("tone")}>
                      {t("sites.tone")}
                    </button>
                    <button type="button" className={addAiTab === "constraints" ? "sites-ai-tab active" : "sites-ai-tab"} onClick={() => setAddAiTab("constraints")}>
                      {t("sites.constraints")}
                    </button>
                  </div>
                  {addAiTab === "overview" ? (
                    <label className="sites-form-field">
                      <span>{t("sites.overview")}</span>
                      <textarea
                        value={sites.newSiteForm.purpose}
                        placeholder={t("sites.overviewPlaceholder")}
                        onChange={(event) => sites.updateNewSiteForm({ purpose: event.target.value })}
                        rows={8}
                      />
                    </label>
                  ) : null}
                  {addAiTab === "tone" ? (
                    <label className="sites-form-field">
                      <span>{t("sites.tone")}</span>
                      <textarea
                        value={sites.newSiteForm.tone}
                        placeholder={t("sites.tonePlaceholder")}
                        onChange={(event) => sites.updateNewSiteForm({ tone: event.target.value })}
                        rows={8}
                      />
                    </label>
                  ) : null}
                  {addAiTab === "constraints" ? (
                    <label className="sites-form-field">
                      <span>{t("sites.constraints")}</span>
                      <textarea
                        value={sites.newSiteForm.constraints}
                        placeholder={t("sites.constraintsPlaceholder")}
                        onChange={(event) => sites.updateNewSiteForm({ constraints: event.target.value })}
                        rows={8}
                      />
                    </label>
                  ) : null}
                </div>
                <p className="sites-form-section-title">{t("sites.hosting")}</p>
                <div className="sites-form-field sites-form-field-wide">
                  <div className="sites-settings-grid">
                    <label className="sites-form-field">
                      <span>{t("sites.hosting")}</span>
                      <input
                        type="text"
                        value={sites.newSiteForm.hosting}
                        placeholder={t("sites.hostingPlaceholder")}
                        onChange={(event) => sites.updateNewSiteForm({ hosting: event.target.value })}
                      />
                    </label>
                    <label className="sites-form-field">
                      <span>{t("sites.vercelProjectId")}</span>
                      <input
                        type="text"
                        value={sites.newSiteForm.vercelProjectId}
                        placeholder={t("sites.vercelProjectIdPlaceholder")}
                        onChange={(event) => sites.updateNewSiteForm({ vercelProjectId: event.target.value })}
                      />
                    </label>
                    <label className="sites-form-field">
                      <span>{t("sites.vercelTeamId")}</span>
                      <input
                        type="text"
                        value={sites.newSiteForm.vercelTeamId}
                        placeholder={t("sites.vercelTeamIdPlaceholder")}
                        onChange={(event) => sites.updateNewSiteForm({ vercelTeamId: event.target.value })}
                      />
                    </label>
                    <label className="sites-form-field">
                      <span>{t("sites.vercelProductionUrl")}</span>
                      <input
                        type="url"
                        value={sites.newSiteForm.vercelProductionUrl}
                        placeholder={t("sites.vercelProductionUrlPlaceholder")}
                        onChange={(event) => sites.updateNewSiteForm({ vercelProductionUrl: event.target.value })}
                      />
                    </label>
                    <label className="sites-form-field sites-form-field-wide">
                      <span>{t("sites.vercelDeployHook")}</span>
                      <input
                        type="url"
                        value={sites.newSiteForm.vercelDeployHookUrl}
                        placeholder={t("sites.vercelDeployHookPlaceholder")}
                        onChange={(event) => sites.updateNewSiteForm({ vercelDeployHookUrl: event.target.value })}
                      />
                    </label>
                  </div>
                </div>
              </div>
            </div>
            <footer className="sites-modal-footer">
              <button type="button" className="secondary-btn" onClick={() => sites.setShowSiteModal(false)}>
                {t("sites.cancel")}
              </button>
              <button type="button" className="primary-btn" onClick={sites.addSiteFromName}>
                {t("sites.create")}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
      <SiteConfigDrawer sites={sites} />
      {pendingDeleteSite ? (
        <div className="sites-modal-backdrop" onClick={() => setPendingDeleteSiteId(null)}>
          <section
            className="sites-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-delete-title"
            onClick={(event) => event.stopPropagation()}
            style={{ maxWidth: 440, height: "auto" }}
          >
            <header className="sites-modal-header">
              <h2 id="confirm-delete-title">{t("sites.confirmDeleteTitle")}</h2>
              <button type="button" className="settings-close-btn" onClick={() => setPendingDeleteSiteId(null)} aria-label={t("sites.close")}>
                ×
              </button>
            </header>
            <div className="sites-modal-body">
              <p>{t("sites.confirmDeleteBody", { name: pendingDeleteSite.name })}</p>
            </div>
            <footer className="sites-modal-footer">
              <button type="button" className="secondary-btn" onClick={() => setPendingDeleteSiteId(null)}>
                {t("sites.cancel")}
              </button>
              <button
                type="button"
                className="primary-btn"
                onClick={() => {
                  sites.removeSite(pendingDeleteSite.id)
                  setPendingDeleteSiteId(null)
                }}
              >
                {t("sites.deleteSite")}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
      {sites.restoreState.siteId ? (
        <div className="sites-modal-backdrop" onClick={() => sites.updateRestoreState({ siteId: null })}>
          <section className="sites-modal sites-modal-wide" role="dialog" aria-modal="true" aria-label={t("sites.versionHistory")} onClick={(event) => event.stopPropagation()}>
            <header className="sites-modal-header">
              <h2>{t("sites.versionHistory")}</h2>
              <button type="button" className="settings-close-btn" onClick={() => sites.updateRestoreState({ siteId: null })} aria-label={t("sites.close")}>
                ×
              </button>
            </header>
            <div className="sites-modal-body">
              <p className="site-purpose">{t("sites.restoreDescription")} <strong>{sites.restoreState.siteId}</strong>.</p>
              {sites.restoreState.isLoading ? (
                <div className="sites-restore-loading">
                  <span className="sites-restore-spinner" />
                  <span>{t("sites.loadingSnapshots")}</span>
                </div>
              ) : sites.restoreState.options.length === 0 ? (
                <p className="site-purpose">{t("sites.noSnapshots")}</p>
              ) : (
                <div className="sites-snapshot-table-wrap">
                  <table className="sites-snapshot-table">
                    <thead>
                      <tr>
                        <th>{t("sites.snapshotCommit")}</th>
                        <th>{t("sites.snapshotPages")}</th>
                        <th>{t("sites.snapshotHeading")}</th>
                        <th>{t("sites.snapshotDate")}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {sites.restoreState.options.map((option) => (
                        <tr key={option.commit} className={sites.restoreState.commit === option.commit ? "sites-snapshot-row-selected" : ""}>
                          <td className="sites-snapshot-commit">{option.commit}</td>
                          <td>{option.pageCount}</td>
                          <td className="sites-snapshot-heading">{option.homeHeading}</td>
                          <td className="sites-snapshot-date">{new Date(option.committedAt).toLocaleString()}</td>
                          <td className="sites-snapshot-actions">
                            <button
                              type="button"
                              className="primary-btn sites-snapshot-restore-btn"
                              onClick={() => void sites.restoreSnapshotForSite(option.commit)}
                              disabled={sites.restoreState.isRestoring}
                            >
                              {t("sites.restore")}
                            </button>
                            <button
                              type="button"
                              className="secondary-btn sites-snapshot-delete-btn"
                              onClick={() => void sites.deleteSnapshot(option.commit)}
                              disabled={sites.restoreState.isRestoring}
                              aria-label={`Delete ${option.commit}`}
                            >
                              <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
                                <path d="M6 2h8M3 5h14M5 5l1 12a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2l1-12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {sites.restoreState.error ? <p className="site-purpose" style={{ color: "#f87171" }}>{sites.restoreState.error}</p> : null}
            </div>
            <footer className="sites-modal-footer">
              <button type="button" className="secondary-btn" onClick={() => sites.updateRestoreState({ siteId: null })} disabled={sites.restoreState.isRestoring}>
                {t("sites.close")}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </main>
    </div>
  )
}
