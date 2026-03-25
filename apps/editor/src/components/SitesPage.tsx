import { useEffect, useMemo, useState } from "react"
import { blockManifestSchema, validateManifestDefaultProps } from "@ai-site-editor/shared"
import { SiteTileDesktopPreview } from "./SiteTileDesktopPreview"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { buildSiteDraftEnableUrl, LEGACY_AVOCADO_SITE_ID, orchestrator, resolveSiteOrigin } from "../lib/editor-utils"
import { useT, LOCALE_LABELS, type Locale } from "@/i18n"
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
  const { t, locale, setLocale } = useT()
  const localeEntries = Object.entries(LOCALE_LABELS) as [Locale, string][]
  const [addAiTab, setAddAiTab] = useState<"overview" | "tone" | "constraints">("overview")
  const [configAiTab, setConfigAiTab] = useState<"overview" | "tone" | "constraints">("overview")
  const [configTab, setConfigTab] = useState<"general" | "media" | "hosting">("general")
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

  return (
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
      <section className="sites-grid" aria-label="Site tiles">
        {dedupedSites.map((site) => {
          const capability = capabilityBySiteId[site.id]
          const previewSrc = buildSiteDraftEnableUrl("/", {
            session,
            siteId: site.id,
            __refresh: String(sites.siteTileRefreshToken)
          }, resolveSiteOrigin(site))
          return (
            <article key={site.id} className="site-tile">
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
                  <button type="button" className="secondary-btn site-config-btn" onClick={() => sites.setConfigSiteId(site.id)} aria-label={`Configure ${site.name}`}>
                    <svg viewBox="0 0 20 20" aria-hidden="true">
                      <path d="M8.8 2h2.4l.5 2.1a6.7 6.7 0 0 1 1.5.6l1.9-1.1 1.7 1.7-1.1 1.9c.2.5.4 1 .5 1.5l2.1.5v2.4l-2.1.5a6.7 6.7 0 0 1-.6 1.5l1.1 1.9-1.7 1.7-1.9-1.1a6.7 6.7 0 0 1-1.5.6L11.2 18H8.8l-.5-2.1a6.7 6.7 0 0 1-1.5-.6l-1.9 1.1-1.7-1.7 1.1-1.9a6.7 6.7 0 0 1-.6-1.5L2 11.2V8.8l2.1-.5c.1-.5.3-1 .6-1.5L3.6 4.9l1.7-1.7 1.9 1.1c.5-.2 1-.4 1.5-.5L8.8 2z" />
                      <circle cx="10" cy="10" r="2.4" />
                    </svg>
                    <span>{t("sites.settings")}</span>
                  </button>
                  <button type="button" className="secondary-btn site-config-btn" onClick={() => void sites.openRestoreModal(site.id)} aria-label={`Version history for ${site.name}`}>
                    <span>{t("sites.versionHistory")}</span>
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
      <Sheet open={!!sites.configSite} onOpenChange={(open) => { if (!open) sites.setConfigSiteId(null) }}>
        <SheetContent side="right" className="w-full sm:max-w-lg gap-0 p-0 font-sans text-foreground text-sm">
          <SheetHeader className="px-5 pt-4 pb-3 border-b border-border">
            <SheetTitle className="text-base font-bold tracking-tight">{t("sites.siteConfig")}</SheetTitle>
          </SheetHeader>
          {sites.configSite ? (
            <div className="sites-modal-body">
              <div className="sites-form-grid">
                <div className="sites-form-field sites-form-field-wide">
                  <div className="sites-ai-tabs" role="tablist" aria-label="Config tabs">
                    <button type="button" className={configTab === "general" ? "sites-ai-tab active" : "sites-ai-tab"} onClick={() => setConfigTab("general")}>{t("sites.general")}</button>
                    <button type="button" className={configTab === "media" ? "sites-ai-tab active" : "sites-ai-tab"} onClick={() => setConfigTab("media")}>{t("sites.media")}</button>
                    <button type="button" className={configTab === "hosting" ? "sites-ai-tab active" : "sites-ai-tab"} onClick={() => setConfigTab("hosting")}>{t("sites.hosting")}</button>
                  </div>
                </div>
                {configTab === "general" ? (<>
                <p className="sites-form-section-title">{t("sites.coreSettings")}</p>
                <label className="sites-form-field">
                  <span>{t("sites.siteName")}</span>
                  <input
                    type="text"
                    value={sites.configSite.name}
                    placeholder={t("sites.siteName")}
                    onChange={(event) => sites.updateConfigSite({ name: event.target.value })}
                  />
                </label>
                <label className="sites-form-field">
                  <span>{t("sites.previewUrl")}</span>
                  <input
                    type="url"
                    value={sites.configSite.previewUrl ?? ""}
                    placeholder={t("sites.previewUrlPlaceholder")}
                    onChange={(event) => sites.updateConfigSite({ previewUrl: event.target.value })}
                  />
                </label>
                <p className="sites-form-section-title">{t("sites.editorialBrief")}</p>
                <div className="sites-form-field sites-form-field-wide">
                  <div className="sites-ai-tabs" role="tablist" aria-label={t("sites.editorialBrief")}>
                    <button type="button" className={configAiTab === "overview" ? "sites-ai-tab active" : "sites-ai-tab"} onClick={() => setConfigAiTab("overview")}>
                      {t("sites.overview")}
                    </button>
                    <button type="button" className={configAiTab === "tone" ? "sites-ai-tab active" : "sites-ai-tab"} onClick={() => setConfigAiTab("tone")}>
                      {t("sites.tone")}
                    </button>
                    <button type="button" className={configAiTab === "constraints" ? "sites-ai-tab active" : "sites-ai-tab"} onClick={() => setConfigAiTab("constraints")}>
                      {t("sites.constraints")}
                    </button>
                  </div>
                  {configAiTab === "overview" ? (
                    <label className="sites-form-field">
                      <span>{t("sites.overview")}</span>
                      <textarea
                        value={sites.configSite.purpose}
                        placeholder={t("sites.overviewPlaceholder")}
                        onChange={(event) => sites.updateConfigSite({ purpose: event.target.value })}
                        rows={8}
                      />
                    </label>
                  ) : null}
                  {configAiTab === "tone" ? (
                    <label className="sites-form-field">
                      <span>{t("sites.tone")}</span>
                      <textarea
                        value={sites.configSite.tone ?? ""}
                        placeholder={t("sites.tonePlaceholder")}
                        onChange={(event) => sites.updateConfigSite({ tone: event.target.value })}
                        rows={8}
                      />
                    </label>
                  ) : null}
                  {configAiTab === "constraints" ? (
                    <label className="sites-form-field">
                      <span>{t("sites.constraints")}</span>
                      <textarea
                        value={(sites.configSite.constraints ?? []).join("\n")}
                        placeholder={t("sites.constraintsPlaceholder")}
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
                </>) : null}
                {configTab === "hosting" ? (<>
                <p className="sites-form-section-title">{t("sites.hosting")}</p>
                <div className="sites-form-field sites-form-field-wide">
                  <div className="sites-settings-grid">
                    <label className="sites-form-field">
                      <span>{t("sites.hosting")}</span>
                      <input
                        type="text"
                        value={sites.configSite.hosting}
                        placeholder={t("sites.hostingPlaceholder")}
                        onChange={(event) => sites.updateConfigSite({ hosting: event.target.value })}
                      />
                    </label>
                    <label className="sites-form-field">
                      <span>{t("sites.vercelProjectId")}</span>
                      <input
                        type="text"
                        value={sites.configSite.vercelProjectId ?? ""}
                        placeholder={t("sites.vercelProjectIdPlaceholder")}
                        onChange={(event) => sites.updateConfigSite({ vercelProjectId: event.target.value })}
                      />
                    </label>
                    <label className="sites-form-field">
                      <span>{t("sites.vercelTeamId")}</span>
                      <input
                        type="text"
                        value={sites.configSite.vercelTeamId ?? ""}
                        placeholder={t("sites.vercelTeamIdPlaceholder")}
                        onChange={(event) => sites.updateConfigSite({ vercelTeamId: event.target.value })}
                      />
                    </label>
                    <label className="sites-form-field">
                      <span>{t("sites.vercelProductionUrl")}</span>
                      <input
                        type="url"
                        value={sites.configSite.vercelProductionUrl ?? ""}
                        placeholder={t("sites.vercelProductionUrlPlaceholder")}
                        onChange={(event) => sites.updateConfigSite({ vercelProductionUrl: event.target.value })}
                      />
                    </label>
                    <label className="sites-form-field sites-form-field-wide">
                      <span>{t("sites.vercelDeployHook")}</span>
                      <input
                        type="url"
                        value={sites.configSite.vercelDeployHookUrl ?? ""}
                        placeholder={t("sites.vercelDeployHookPlaceholder")}
                        onChange={(event) => sites.updateConfigSite({ vercelDeployHookUrl: event.target.value })}
                      />
                    </label>
                  </div>
                </div>
                </>) : null}
                {configTab === "media" ? (<>
                <p className="sites-form-section-title">{t("sites.googleDrive")}</p>
                <div className="sites-form-field sites-form-field-wide">
                  <div className="sites-settings-grid">
                    <label className="sites-form-field sites-form-field-wide">
                      <span>{t("sites.googleDriveFolderId")}</span>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <input
                          type="text"
                          value={sites.configSite.gdriveFolderId ?? ""}
                          placeholder={t("sites.googleDrivePlaceholder")}
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
                                setDriveValidation({ status: "ok", message: data.items.length > 0 ? t("sites.driveConnectedImages") : t("sites.driveConnectedEmpty") })
                              } else {
                                const data = (await res.json().catch(() => ({}))) as { error?: string }
                                setDriveValidation({ status: "error", message: data.error ?? `HTTP ${res.status}` })
                              }
                            } catch {
                              setDriveValidation({ status: "error", message: t("sites.driveError") })
                            }
                          }}
                        >
                          {driveValidation?.status === "loading" ? t("sites.testing") : t("sites.test")}
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
                <p className="sites-form-section-title">{t("sites.cmsMedia")}</p>
                <div className="sites-form-field sites-form-field-wide">
                  <div className="sites-settings-grid">
                    <label className="sites-form-field">
                      <span>{t("sites.provider")}</span>
                      <select
                        value={sites.configSite.cmsMedia?.provider ?? ""}
                        onChange={(event) => {
                          const provider = event.target.value as "" | "contentful" | "sanity" | "strapi"
                          if (!provider) {
                            sites.updateConfigSite({ cmsMedia: undefined })
                          } else if (provider === "contentful") {
                            sites.updateConfigSite({ cmsMedia: { provider: "contentful", spaceId: "", deliveryToken: "" } })
                          } else if (provider === "sanity") {
                            sites.updateConfigSite({ cmsMedia: { provider: "sanity", projectId: "" } })
                          } else if (provider === "strapi") {
                            sites.updateConfigSite({ cmsMedia: { provider: "strapi", url: "" } })
                          }
                        }}
                      >
                        <option value="">{t("sites.none")}</option>
                        <option value="contentful">Contentful</option>
                        <option value="sanity">Sanity</option>
                        <option value="strapi">Strapi</option>
                      </select>
                    </label>
                    {sites.configSite.cmsMedia?.provider === "contentful" && (
                      <>
                        <label className="sites-form-field">
                          <span>{t("sites.spaceId")}</span>
                          <input type="text" value={(sites.configSite.cmsMedia as { spaceId: string }).spaceId} placeholder={t("sites.spaceIdPlaceholder")} onChange={(e) => sites.updateConfigSite({ cmsMedia: { ...sites.configSite!.cmsMedia!, spaceId: e.target.value } as typeof sites.configSite.cmsMedia })} />
                        </label>
                        <label className="sites-form-field">
                          <span>{t("sites.deliveryToken")}</span>
                          <textarea rows={2} value={(sites.configSite.cmsMedia as { deliveryToken: string }).deliveryToken} placeholder={t("sites.deliveryTokenPlaceholder")} onChange={(e) => sites.updateConfigSite({ cmsMedia: { ...sites.configSite!.cmsMedia!, deliveryToken: e.target.value } as typeof sites.configSite.cmsMedia })} />
                        </label>
                      </>
                    )}
                    {sites.configSite.cmsMedia?.provider === "sanity" && (
                      <>
                        <label className="sites-form-field">
                          <span>{t("sites.projectId")}</span>
                          <input type="text" value={(sites.configSite.cmsMedia as { projectId: string }).projectId} placeholder={t("sites.spaceIdPlaceholder")} onChange={(e) => sites.updateConfigSite({ cmsMedia: { ...sites.configSite!.cmsMedia!, projectId: e.target.value } as typeof sites.configSite.cmsMedia })} />
                        </label>
                        <label className="sites-form-field">
                          <span>{t("sites.dataset")}</span>
                          <input type="text" value={(sites.configSite.cmsMedia as { dataset?: string }).dataset ?? ""} placeholder={t("sites.datasetPlaceholder")} onChange={(e) => sites.updateConfigSite({ cmsMedia: { ...sites.configSite!.cmsMedia!, dataset: e.target.value || undefined } as typeof sites.configSite.cmsMedia })} />
                        </label>
                      </>
                    )}
                    {sites.configSite.cmsMedia?.provider === "strapi" && (
                      <>
                        <label className="sites-form-field">
                          <span>{t("sites.strapiUrl")}</span>
                          <input type="url" value={(sites.configSite.cmsMedia as { url: string }).url} placeholder={t("sites.strapiUrlPlaceholder")} onChange={(e) => sites.updateConfigSite({ cmsMedia: { ...sites.configSite!.cmsMedia!, url: e.target.value } as typeof sites.configSite.cmsMedia })} />
                        </label>
                        <label className="sites-form-field">
                          <span>{t("sites.apiToken")}</span>
                          <textarea rows={2} value={(sites.configSite.cmsMedia as { token?: string }).token ?? ""} placeholder={t("sites.apiTokenPlaceholder")} onChange={(e) => sites.updateConfigSite({ cmsMedia: { ...sites.configSite!.cmsMedia!, token: e.target.value || undefined } as typeof sites.configSite.cmsMedia })} />
                        </label>
                      </>
                    )}
                  </div>
                </div>
                </>) : null}
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
      {sites.restoreState.siteId ? (
        <div className="sites-modal-backdrop" onClick={() => sites.updateRestoreState({ siteId: null })}>
          <section className="sites-modal" role="dialog" aria-modal="true" aria-label={t("sites.versionHistory")} onClick={(event) => event.stopPropagation()}>
            <header className="sites-modal-header">
              <h2>{t("sites.versionHistory")}</h2>
              <button type="button" className="settings-close-btn" onClick={() => sites.updateRestoreState({ siteId: null })} aria-label={t("sites.close")}>
                ×
              </button>
            </header>
            <div className="sites-modal-body">
              <p className="site-purpose">{t("sites.restoreDescription")} <strong>{sites.restoreState.siteId}</strong>.</p>
              <label className="sites-form-field">
                <span>{t("sites.snapshotVersion")}</span>
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
                {t("sites.cancel")}
              </button>
              <button
                type="button"
                className="primary-btn"
                onClick={() => void sites.restoreSnapshotForSite()}
                disabled={sites.restoreState.isLoading || sites.restoreState.isRestoring || !sites.restoreState.commit}
              >
                {sites.restoreState.isRestoring ? t("sites.restoring") : t("sites.restore")}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </main>
  )
}
