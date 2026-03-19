import { useEffect, useMemo, useState } from "react"
import { editorComponentsManifestSchema, validateManifestDefaultProps } from "@ai-site-editor/shared"
import { SiteTileDesktopPreview } from "./SiteTileDesktopPreview"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { buildSiteDraftEnableUrl, LEGACY_AVOCADO_SITE_ID, orchestrator, resolveSiteOrigin } from "../lib/editor-utils"
import type { UseSiteListReturn } from "../hooks/useSiteList"

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
  const [addAiTab, setAddAiTab] = useState<"overview" | "tone" | "constraints">("overview")
  const [configAiTab, setConfigAiTab] = useState<"overview" | "tone" | "constraints">("overview")
  const [driveValidation, setDriveValidation] = useState<{ status: "loading" | "ok" | "error"; message?: string } | null>(null)
  useEffect(() => { if (!sites.configSiteId) setDriveValidation(null) }, [sites.configSiteId])

  const dedupedSites = useMemo(() => sites.siteList
    .filter((site, index, all) => all.findIndex((row) => row.id === site.id) === index)
    .sort((a, b) => {
      const aLegacy = a.id === LEGACY_AVOCADO_SITE_ID ? 1 : 0
      const bLegacy = b.id === LEGACY_AVOCADO_SITE_ID ? 1 : 0
      return aLegacy - bLegacy
    }), [sites.siteList])

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
        loadingMap[site.id] = { status: "loading", summary: "Checking manifest..." }
      }
      if (active) setCapabilityBySiteId(loadingMap)

      await Promise.all(
        dedupedSites.map(async (site) => {
          const url = new URL(`${resolveSiteOrigin(site)}/api/editor/components`)
          url.searchParams.set("siteId", site.id)
          try {
            const res = await fetch(url.toString())
            if (!res.ok) {
              if (!active) return
              setCapabilityBySiteId((prev) => ({
                ...prev,
                [site.id]: {
                  status: "degraded",
                  summary: "Limited editing",
                  reason: `Manifest endpoint returned ${res.status}`
                }
              }))
              return
            }
            const json = (await res.json()) as unknown
            const parsed = editorComponentsManifestSchema.safeParse(json)
            if (!parsed.success) {
              if (!active) return
              setCapabilityBySiteId((prev) => ({
                ...prev,
                [site.id]: {
                  status: "degraded",
                  summary: "Limited editing",
                  reason: "Manifest response shape is invalid"
                }
              }))
              return
            }
            const defaultsError = validateManifestDefaultProps(parsed.data.components)
            if (defaultsError) {
              if (!active) return
              setCapabilityBySiteId((prev) => ({
                ...prev,
                [site.id]: {
                  status: "degraded",
                  summary: "Limited editing",
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
                summary: `${parsed.data.components.length} components found`
              }
            }))
          } catch (error) {
            if (!active) return
            setCapabilityBySiteId((prev) => ({
              ...prev,
              [site.id]: {
                status: "degraded",
                summary: "Limited editing",
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

  return (
    <main className="sites-page">
      <header className="sites-header">
        <div>
          <h1>Sites</h1>
          <p>Choose a site to edit.</p>
        </div>
        <div className="sites-header-actions">
          <button
            type="button"
            className="primary-btn"
            onClick={() => {
              sites.resetNewSiteForm()
              setAddAiTab("overview")
              sites.setShowSiteModal(true)
            }}
          >
            Add site
          </button>
        </div>
      </header>
      <section className="sites-grid" aria-label="Site tiles">
        {dedupedSites.map((site) => {
          const capability = capabilityBySiteId[site.id]
          const previewSrc = buildSiteDraftEnableUrl("/", {
            session,
            siteId: site.id,
            __tile: "1",
            __refresh: String(sites.siteTileRefreshToken)
          }, resolveSiteOrigin(site))
          return (
            <article key={site.id} className="site-tile">
              <SiteTileDesktopPreview title={`${site.name} home preview`} src={previewSrc} />
              <div className="site-tile-meta">
                <h2>{site.name}</h2>
                {site.purpose ? <p className="site-purpose">{compactPurposeText(site.purpose)}</p> : null}
                {capability ? (
                  <p
                    className={
                      capability.status === "ready"
                        ? "site-capability site-capability-ready"
                        : capability.status === "degraded"
                          ? "site-capability site-capability-degraded"
                          : "site-capability"
                    }
                    title={capability.reason}
                  >
                    {capability.summary}
                  </p>
                ) : null}
                <div className="site-tile-actions">
                  <button type="button" className="secondary-btn site-config-btn" onClick={() => sites.setConfigSiteId(site.id)} aria-label={`Configure ${site.name}`}>
                    <svg viewBox="0 0 20 20" aria-hidden="true">
                      <path d="M8.8 2h2.4l.5 2.1a6.7 6.7 0 0 1 1.5.6l1.9-1.1 1.7 1.7-1.1 1.9c.2.5.4 1 .5 1.5l2.1.5v2.4l-2.1.5a6.7 6.7 0 0 1-.6 1.5l1.1 1.9-1.7 1.7-1.9-1.1a6.7 6.7 0 0 1-1.5.6L11.2 18H8.8l-.5-2.1a6.7 6.7 0 0 1-1.5-.6l-1.9 1.1-1.7-1.7 1.1-1.9a6.7 6.7 0 0 1-.6-1.5L2 11.2V8.8l2.1-.5c.1-.5.3-1 .6-1.5L3.6 4.9l1.7-1.7 1.9 1.1c.5-.2 1-.4 1.5-.5L8.8 2z" />
                      <circle cx="10" cy="10" r="2.4" />
                    </svg>
                    <span>Settings</span>
                  </button>
                  <button type="button" className="secondary-btn site-config-btn" onClick={() => void sites.openRestoreModal(site.id)} aria-label={`Version history for ${site.name}`}>
                    <span>Version history</span>
                  </button>
                  <button type="button" className="primary-btn" onClick={() => sites.openEditorForSite(site.id)}>
                    <span>Open editor</span>
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
          <section className="sites-modal" role="dialog" aria-modal="true" aria-label="Add site" onClick={(event) => event.stopPropagation()}>
            <header className="sites-modal-header">
              <h2>Add Site</h2>
              <button type="button" className="settings-close-btn" onClick={() => sites.setShowSiteModal(false)} aria-label="Close">
                ×
              </button>
            </header>
            <div className="sites-modal-body">
              <div className="sites-form-grid">
                <p className="sites-form-section-title">Core settings</p>
                <label className="sites-form-field">
                  <span>Site name</span>
                  <input
                    type="text"
                    value={sites.newSiteForm.name}
                    placeholder="Adventure Arena"
                    onChange={(event) => sites.updateNewSiteForm({ name: event.target.value })}
                  />
                </label>
                <p className="sites-form-section-title">Editorial brief</p>
                <div className="sites-form-field sites-form-field-wide">
                  <div className="sites-ai-tabs" role="tablist" aria-label="Editorial brief tabs">
                    <button type="button" className={addAiTab === "overview" ? "sites-ai-tab active" : "sites-ai-tab"} onClick={() => setAddAiTab("overview")}>
                      Overview
                    </button>
                    <button type="button" className={addAiTab === "tone" ? "sites-ai-tab active" : "sites-ai-tab"} onClick={() => setAddAiTab("tone")}>
                      Tone
                    </button>
                    <button type="button" className={addAiTab === "constraints" ? "sites-ai-tab active" : "sites-ai-tab"} onClick={() => setAddAiTab("constraints")}>
                      Constraints
                    </button>
                  </div>
                  {addAiTab === "overview" ? (
                    <label className="sites-form-field">
                      <span>Overview</span>
                      <textarea
                        value={sites.newSiteForm.purpose}
                        placeholder="What this site is for."
                        onChange={(event) => sites.updateNewSiteForm({ purpose: event.target.value })}
                        rows={8}
                      />
                    </label>
                  ) : null}
                  {addAiTab === "tone" ? (
                    <label className="sites-form-field">
                      <span>Preferred tone</span>
                      <textarea
                        value={sites.newSiteForm.tone}
                        placeholder="How the writing should sound."
                        onChange={(event) => sites.updateNewSiteForm({ tone: event.target.value })}
                        rows={8}
                      />
                    </label>
                  ) : null}
                  {addAiTab === "constraints" ? (
                    <label className="sites-form-field">
                      <span>Writing constraints</span>
                      <textarea
                        value={sites.newSiteForm.constraints}
                        placeholder={"Rules for content output.\nOne per line."}
                        onChange={(event) => sites.updateNewSiteForm({ constraints: event.target.value })}
                        rows={8}
                      />
                    </label>
                  ) : null}
                </div>
                <p className="sites-form-section-title">Settings</p>
                <div className="sites-form-field sites-form-field-wide">
                  <div className="sites-settings-grid">
                    <label className="sites-form-field">
                      <span>Hosting</span>
                      <input
                        type="text"
                        value={sites.newSiteForm.hosting}
                        placeholder="Vercel production site (single shared project)"
                        onChange={(event) => sites.updateNewSiteForm({ hosting: event.target.value })}
                      />
                    </label>
                    <label className="sites-form-field">
                      <span>Vercel project ID</span>
                      <input
                        type="text"
                        value={sites.newSiteForm.vercelProjectId}
                        placeholder="prj_..."
                        onChange={(event) => sites.updateNewSiteForm({ vercelProjectId: event.target.value })}
                      />
                    </label>
                    <label className="sites-form-field">
                      <span>Vercel team ID</span>
                      <input
                        type="text"
                        value={sites.newSiteForm.vercelTeamId}
                        placeholder="team_..."
                        onChange={(event) => sites.updateNewSiteForm({ vercelTeamId: event.target.value })}
                      />
                    </label>
                    <label className="sites-form-field">
                      <span>Vercel production URL</span>
                      <input
                        type="url"
                        value={sites.newSiteForm.vercelProductionUrl}
                        placeholder="https://example.vercel.app"
                        onChange={(event) => sites.updateNewSiteForm({ vercelProductionUrl: event.target.value })}
                      />
                    </label>
                    <label className="sites-form-field sites-form-field-wide">
                      <span>Vercel deploy hook URL</span>
                      <input
                        type="url"
                        value={sites.newSiteForm.vercelDeployHookUrl}
                        placeholder="https://api.vercel.com/v1/integrations/deploy/..."
                        onChange={(event) => sites.updateNewSiteForm({ vercelDeployHookUrl: event.target.value })}
                      />
                    </label>
                  </div>
                </div>
              </div>
            </div>
            <footer className="sites-modal-footer">
              <button type="button" className="secondary-btn" onClick={() => sites.setShowSiteModal(false)}>
                Cancel
              </button>
              <button type="button" className="primary-btn" onClick={sites.addSiteFromName}>
                Create
              </button>
            </footer>
          </section>
        </div>
      ) : null}
      <Sheet open={!!sites.configSite} onOpenChange={(open) => { if (!open) sites.setConfigSiteId(null) }}>
        <SheetContent side="right" className="w-full sm:max-w-lg gap-0 p-0 font-sans text-foreground text-sm">
          <SheetHeader className="px-5 pt-4 pb-3 border-b border-border">
            <SheetTitle className="text-base font-bold tracking-tight">Site Config</SheetTitle>
          </SheetHeader>
          {sites.configSite ? (
            <div className="sites-modal-body">
              <div className="sites-form-grid">
                <p className="sites-form-section-title">Core settings</p>
                <label className="sites-form-field">
                  <span>Site name</span>
                  <input
                    type="text"
                    value={sites.configSite.name}
                    placeholder="Site name"
                    onChange={(event) => sites.updateConfigSite({ name: event.target.value })}
                  />
                </label>
                <p className="sites-form-section-title">Editorial brief</p>
                <div className="sites-form-field sites-form-field-wide">
                  <div className="sites-ai-tabs" role="tablist" aria-label="Editorial brief tabs">
                    <button type="button" className={configAiTab === "overview" ? "sites-ai-tab active" : "sites-ai-tab"} onClick={() => setConfigAiTab("overview")}>
                      Overview
                    </button>
                    <button type="button" className={configAiTab === "tone" ? "sites-ai-tab active" : "sites-ai-tab"} onClick={() => setConfigAiTab("tone")}>
                      Tone
                    </button>
                    <button type="button" className={configAiTab === "constraints" ? "sites-ai-tab active" : "sites-ai-tab"} onClick={() => setConfigAiTab("constraints")}>
                      Constraints
                    </button>
                  </div>
                  {configAiTab === "overview" ? (
                    <label className="sites-form-field">
                      <span>Overview</span>
                      <textarea
                        value={sites.configSite.purpose}
                        placeholder="What this site is for."
                        onChange={(event) => sites.updateConfigSite({ purpose: event.target.value })}
                        rows={8}
                      />
                    </label>
                  ) : null}
                  {configAiTab === "tone" ? (
                    <label className="sites-form-field">
                      <span>Preferred tone</span>
                      <textarea
                        value={sites.configSite.tone ?? ""}
                        placeholder="How the writing should sound."
                        onChange={(event) => sites.updateConfigSite({ tone: event.target.value })}
                        rows={8}
                      />
                    </label>
                  ) : null}
                  {configAiTab === "constraints" ? (
                    <label className="sites-form-field">
                      <span>Writing constraints</span>
                      <textarea
                        value={(sites.configSite.constraints ?? []).join("\n")}
                        placeholder={"Rules for content output.\nOne per line."}
                        onChange={(event) =>
                          sites.updateConfigSite({
                            constraints: event.target.value
                              .split(/\n|,/g)
                              .map((item) => item.trim())
                              .filter(Boolean)
                          })
                        }
                        rows={8}
                      />
                    </label>
                  ) : null}
                </div>
                <p className="sites-form-section-title">Settings</p>
                <div className="sites-form-field sites-form-field-wide">
                  <div className="sites-settings-grid">
                    <label className="sites-form-field">
                      <span>Hosting</span>
                      <input
                        type="text"
                        value={sites.configSite.hosting}
                        placeholder="Vercel production site (single shared project)"
                        onChange={(event) => sites.updateConfigSite({ hosting: event.target.value })}
                      />
                    </label>
                    <label className="sites-form-field">
                      <span>Vercel project ID</span>
                      <input
                        type="text"
                        value={sites.configSite.vercelProjectId ?? ""}
                        placeholder="prj_..."
                        onChange={(event) => sites.updateConfigSite({ vercelProjectId: event.target.value })}
                      />
                    </label>
                    <label className="sites-form-field">
                      <span>Vercel team ID</span>
                      <input
                        type="text"
                        value={sites.configSite.vercelTeamId ?? ""}
                        placeholder="team_..."
                        onChange={(event) => sites.updateConfigSite({ vercelTeamId: event.target.value })}
                      />
                    </label>
                    <label className="sites-form-field">
                      <span>Vercel production URL</span>
                      <input
                        type="url"
                        value={sites.configSite.vercelProductionUrl ?? ""}
                        placeholder="https://example.vercel.app"
                        onChange={(event) => sites.updateConfigSite({ vercelProductionUrl: event.target.value })}
                      />
                    </label>
                    <label className="sites-form-field sites-form-field-wide">
                      <span>Vercel deploy hook URL</span>
                      <input
                        type="url"
                        value={sites.configSite.vercelDeployHookUrl ?? ""}
                        placeholder="https://api.vercel.com/v1/integrations/deploy/..."
                        onChange={(event) => sites.updateConfigSite({ vercelDeployHookUrl: event.target.value })}
                      />
                    </label>
                    <label className="sites-form-field sites-form-field-wide">
                      <span>Google Drive folder ID</span>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <input
                          type="text"
                          value={sites.configSite.gdriveFolderId ?? ""}
                          placeholder="e.g. 1aBcDeFgHiJkLmNoPqRsTuVwXyZ"
                          onChange={(event) => {
                            sites.updateConfigSite({ gdriveFolderId: event.target.value })
                            setDriveValidation(null)
                          }}
                          style={{ flex: 1 }}
                        />
                        <button
                          type="button"
                          className="secondary-btn"
                          style={{ whiteSpace: "nowrap", padding: "6px 12px", fontSize: 13 }}
                          disabled={!sites.configSite.gdriveFolderId?.trim() || driveValidation?.status === "loading"}
                          onClick={async () => {
                            const folderId = sites.configSite!.gdriveFolderId?.trim()
                            if (!folderId) return
                            setDriveValidation({ status: "loading" })
                            try {
                              const res = await fetch(`${orchestrator}/gdrive/images?folderId=${encodeURIComponent(folderId)}&limit=1`)
                              if (res.ok) {
                                const data = (await res.json()) as { items: unknown[] }
                                setDriveValidation({ status: "ok", message: `Connected (${data.items.length > 0 ? "images found" : "folder empty"})` })
                              } else {
                                const data = (await res.json().catch(() => ({}))) as { error?: string }
                                setDriveValidation({ status: "error", message: data.error ?? `HTTP ${res.status}` })
                              }
                            } catch {
                              setDriveValidation({ status: "error", message: "Could not reach orchestrator" })
                            }
                          }}
                        >
                          {driveValidation?.status === "loading" ? "Testing..." : "Test"}
                        </button>
                      </div>
                      {driveValidation && driveValidation.status !== "loading" && (
                        <span style={{ fontSize: 12, marginTop: 4, color: driveValidation.status === "ok" ? "#4ade80" : "#f87171" }}>
                          {driveValidation.message}
                        </span>
                      )}
                    </label>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
      {sites.restoreState.siteId ? (
        <div className="sites-modal-backdrop" onClick={() => sites.updateRestoreState({ siteId: null })}>
          <section className="sites-modal" role="dialog" aria-modal="true" aria-label="Version history" onClick={(event) => event.stopPropagation()}>
            <header className="sites-modal-header">
              <h2>Version History</h2>
              <button type="button" className="settings-close-btn" onClick={() => sites.updateRestoreState({ siteId: null })} aria-label="Close">
                ×
              </button>
            </header>
            <div className="sites-modal-body">
              <p className="site-purpose">Restore a previous published snapshot into <strong>{sites.restoreState.siteId}</strong>.</p>
              <label className="sites-form-field">
                <span>Snapshot version</span>
                <select
                  value={sites.restoreState.commit}
                  onChange={(event) => sites.updateRestoreState({ commit: event.target.value })}
                  disabled={sites.restoreState.isLoading || sites.restoreState.isRestoring || sites.restoreState.options.length === 0}
                >
                  {sites.restoreState.options.map((option) => {
                    const dateLabel = new Date(option.committedAt).toLocaleString()
                    const label = `${option.commit} · ${option.pageCount} pages · ${option.homeHeading} · ${dateLabel}`
                    return (
                      <option key={option.commit} value={option.commit}>
                        {label}
                      </option>
                    )
                  })}
                </select>
              </label>
              {sites.restoreState.error ? <p className="site-purpose">{sites.restoreState.error}</p> : null}
            </div>
            <footer className="sites-modal-footer">
              <button type="button" className="secondary-btn" onClick={() => sites.updateRestoreState({ siteId: null })} disabled={sites.restoreState.isRestoring}>
                Cancel
              </button>
              <button
                type="button"
                className="primary-btn"
                onClick={() => void sites.restoreSnapshotForSite()}
                disabled={sites.restoreState.isLoading || sites.restoreState.isRestoring || !sites.restoreState.commit}
              >
                {sites.restoreState.isRestoring ? "Restoring..." : "Restore"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </main>
  )
}
