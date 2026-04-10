import { useEffect, useState } from "react"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useT } from "@/i18n"
import { useEditorStore } from "../store"
import { orchestrator } from "../lib/editor-utils"
import type { UseSiteListReturn } from "../hooks/useSiteList"

type DriveValidation = { status: "loading" | "ok" | "error"; message?: string } | null

export interface SiteConfigDrawerProps {
  sites: UseSiteListReturn
  /** Called after successful edits that should trigger a live preview refresh. Optional — only the editor page passes this. */
  onPreviewRefresh?: () => void
}

/**
 * Unified Site Config side drawer used by both `/sites` (site list) and
 * `/editor` (active-site editor). Tab state lives in the Zustand store so
 * both mounts stay in sync.
 */
export function SiteConfigDrawer({ sites, onPreviewRefresh }: SiteConfigDrawerProps) {
  const { t } = useT()
  const configModalTab = useEditorStore((s) => s.configModalTab)
  const setConfigModalTab = useEditorStore((s) => s.setConfigModalTab)
  const siteConfigTab = useEditorStore((s) => s.siteConfigTab)
  const setSiteConfigTab = useEditorStore((s) => s.setSiteConfigTab)
  const [driveValidation, setDriveValidation] = useState<DriveValidation>(null)

  // Reset transient drive-validation banner + brief sub-tab when the drawer closes.
  useEffect(() => {
    if (!sites.configSiteId) {
      setDriveValidation(null)
      setSiteConfigTab("overview")
    }
  }, [sites.configSiteId, setSiteConfigTab])

  const configSite = sites.configSite

  return (
    <Sheet open={!!configSite} onOpenChange={(open) => { if (!open) sites.setConfigSiteId(null) }}>
      <SheetContent side="right" className="w-full sm:max-w-lg gap-0 p-0 font-sans text-foreground text-sm">
        <SheetHeader className="px-5 pt-4 pb-3 border-b border-border">
          <SheetTitle className="text-base font-bold tracking-tight">{t("sites.siteConfig")}</SheetTitle>
        </SheetHeader>
        {configSite ? (
          <>
            <nav className="panel-tabs">
              <button type="button" className={`panel-tab ${configModalTab === "general" ? "is-active" : ""}`} onClick={() => setConfigModalTab("general")}>{t("sites.general")}</button>
              <button type="button" className={`panel-tab ${configModalTab === "brief" ? "is-active" : ""}`} onClick={() => setConfigModalTab("brief")}>{t("sites.brief")}</button>
              <button type="button" className={`panel-tab ${configModalTab === "deploy" ? "is-active" : ""}`} onClick={() => setConfigModalTab("deploy")}>{t("sites.deploy")}</button>
            </nav>
            <div className="sites-modal-body">
              {configModalTab === "general" ? (
                <div className="sites-form-grid">
                  <label className="sites-form-field">
                    <span>{t("sites.siteName")}</span>
                    <input
                      type="text"
                      value={configSite.name}
                      placeholder={t("sites.siteNamePlaceholder")}
                      onChange={(e) => sites.updateConfigSite({ name: e.target.value })}
                    />
                  </label>
                  <label className="sites-form-field">
                    <span>{t("sites.previewUrl")}</span>
                    <input
                      type="url"
                      value={configSite.previewUrl ?? ""}
                      placeholder={t("sites.previewUrlPlaceholder")}
                      onChange={(e) => sites.updateConfigSite({ previewUrl: e.target.value })}
                    />
                  </label>
                  <label className="sites-form-field sites-form-field-inline">
                    <input
                      type="checkbox"
                      checked={configSite.enablePuck ?? false}
                      onChange={(e) => sites.updateConfigSite({ enablePuck: e.target.checked })}
                    />
                    <span>{t("sites.enablePuck")}</span>
                  </label>
                  <p className="sites-form-section-title">{t("sites.header")}</p>
                  <label className="sites-form-field">
                    <span>{t("sites.siteHeaderName")}</span>
                    <input
                      type="text"
                      value={sites.headerConfig.name ?? ""}
                      placeholder={t("sites.siteHeaderName")}
                      onBlur={(e) => {
                        void sites.updateHeaderConfig({ name: e.target.value })
                        onPreviewRefresh?.()
                      }}
                      onChange={(e) => sites.updateHeaderConfig({ name: e.target.value })}
                    />
                  </label>
                  <label className="sites-form-field">
                    <span>{t("sites.logoUrl")}</span>
                    <input
                      type="text"
                      value={sites.headerConfig.logo ?? ""}
                      placeholder={t("sites.logoUrlPlaceholder")}
                      onBlur={(e) => {
                        void sites.updateHeaderConfig({ logo: e.target.value })
                        onPreviewRefresh?.()
                      }}
                      onChange={(e) => sites.updateHeaderConfig({ logo: e.target.value })}
                    />
                  </label>
                </div>
              ) : null}

              {configModalTab === "brief" ? (
                <div className="sites-form-grid">
                  <div className="sites-form-field sites-form-field-wide">
                    <div className="sites-ai-tabs" role="tablist" aria-label={t("sites.editorialBrief")}>
                      <button type="button" className={siteConfigTab === "overview" ? "sites-ai-tab active" : "sites-ai-tab"} onClick={() => setSiteConfigTab("overview")}>{t("sites.overview")}</button>
                      <button type="button" className={siteConfigTab === "tone" ? "sites-ai-tab active" : "sites-ai-tab"} onClick={() => setSiteConfigTab("tone")}>{t("sites.tone")}</button>
                      <button type="button" className={siteConfigTab === "constraints" ? "sites-ai-tab active" : "sites-ai-tab"} onClick={() => setSiteConfigTab("constraints")}>{t("sites.constraints")}</button>
                      <button type="button" className={siteConfigTab === "templates" ? "sites-ai-tab active" : "sites-ai-tab"} onClick={() => setSiteConfigTab("templates")}>{t("sites.templates")}</button>
                    </div>
                    {siteConfigTab === "overview" ? (
                      <label className="sites-form-field">
                        <span>{t("sites.overview")}</span>
                        <textarea
                          value={configSite.purpose}
                          placeholder={t("sites.overviewPlaceholder")}
                          onChange={(e) => sites.updateConfigSite({ purpose: e.target.value })}
                          rows={8}
                        />
                      </label>
                    ) : null}
                    {siteConfigTab === "tone" ? (
                      <label className="sites-form-field">
                        <span>{t("sites.tone")}</span>
                        <textarea
                          value={configSite.tone ?? ""}
                          placeholder={t("sites.tonePlaceholder")}
                          onChange={(e) => sites.updateConfigSite({ tone: e.target.value })}
                          rows={8}
                        />
                      </label>
                    ) : null}
                    {siteConfigTab === "constraints" ? (
                      <label className="sites-form-field">
                        <span>{t("sites.constraints")}</span>
                        <textarea
                          value={(configSite.constraints ?? []).join("\n")}
                          placeholder={t("sites.constraintsPlaceholder")}
                          onChange={(e) =>
                            sites.updateConfigSite({
                              constraints: e.target.value
                                .split(/\n|,/g)
                                .map((s) => s.trim())
                                .filter(Boolean)
                            })
                          }
                          rows={8}
                        />
                      </label>
                    ) : null}
                    {siteConfigTab === "templates" ? (
                      <div className="sites-form-field">
                        <span>{t("sites.pageTemplates")}</span>
                        <p className="sites-form-hint">{t("sites.pageTemplatesHint")}</p>
                        {(configSite.pageTemplates ?? []).map((tpl, idx) => (
                          <div key={idx} className="sites-template-entry">
                            <input
                              type="text"
                              value={tpl.name}
                              placeholder={t("sites.templateName")}
                              onChange={(e) => {
                                const updated = [...(configSite.pageTemplates ?? [])]
                                updated[idx] = { ...updated[idx], name: e.target.value }
                                sites.updateConfigSite({ pageTemplates: updated })
                              }}
                            />
                            <textarea
                              value={tpl.description}
                              placeholder={t("sites.templateDescription")}
                              rows={3}
                              onChange={(e) => {
                                const updated = [...(configSite.pageTemplates ?? [])]
                                updated[idx] = { ...updated[idx], description: e.target.value }
                                sites.updateConfigSite({ pageTemplates: updated })
                              }}
                            />
                            <button
                              type="button"
                              className="sites-template-remove"
                              onClick={() => {
                                const updated = (configSite.pageTemplates ?? []).filter((_, i) => i !== idx)
                                sites.updateConfigSite({ pageTemplates: updated.length > 0 ? updated : undefined })
                              }}
                            >{t("sites.removeTemplate")}</button>
                          </div>
                        ))}
                        <button
                          type="button"
                          className="sites-template-add"
                          onClick={() => sites.updateConfigSite({ pageTemplates: [...(configSite.pageTemplates ?? []), { name: "", description: "" }] })}
                        >{t("sites.addTemplate")}</button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {configModalTab === "deploy" ? (
                <div className="sites-form-grid">
                  <p className="sites-form-section-title">{t("sites.hosting")}</p>
                  <div className="sites-form-field sites-form-field-wide">
                    <div className="sites-settings-grid">
                      <label className="sites-form-field">
                        <span>{t("sites.hosting")}</span>
                        <input
                          type="text"
                          value={configSite.hosting}
                          placeholder={t("sites.hostingPlaceholder")}
                          onChange={(e) => sites.updateConfigSite({ hosting: e.target.value })}
                        />
                      </label>
                      <label className="sites-form-field">
                        <span>{t("sites.vercelProjectId")}</span>
                        <input
                          type="text"
                          value={configSite.vercelProjectId ?? ""}
                          placeholder={t("sites.vercelProjectIdPlaceholder")}
                          onChange={(e) => sites.updateConfigSite({ vercelProjectId: e.target.value })}
                        />
                      </label>
                      <label className="sites-form-field">
                        <span>{t("sites.vercelTeamId")}</span>
                        <input
                          type="text"
                          value={configSite.vercelTeamId ?? ""}
                          placeholder={t("sites.vercelTeamIdPlaceholder")}
                          onChange={(e) => sites.updateConfigSite({ vercelTeamId: e.target.value })}
                        />
                      </label>
                      <label className="sites-form-field">
                        <span>{t("sites.vercelProductionUrl")}</span>
                        <input
                          type="url"
                          value={configSite.vercelProductionUrl ?? ""}
                          placeholder={t("sites.vercelProductionUrlPlaceholder")}
                          onChange={(e) => sites.updateConfigSite({ vercelProductionUrl: e.target.value })}
                        />
                      </label>
                      <label className="sites-form-field sites-form-field-wide">
                        <span>{t("sites.vercelDeployHook")}</span>
                        <input
                          type="url"
                          value={configSite.vercelDeployHookUrl ?? ""}
                          placeholder={t("sites.vercelDeployHookPlaceholder")}
                          onChange={(e) => sites.updateConfigSite({ vercelDeployHookUrl: e.target.value })}
                        />
                      </label>
                    </div>
                  </div>

                  <p className="sites-form-section-title">{t("sites.googleDrive")}</p>
                  <div className="sites-form-field sites-form-field-wide">
                    <div className="sites-settings-grid">
                      <label className="sites-form-field sites-form-field-wide">
                        <span>{t("sites.googleDriveFolderId")}</span>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <input
                            type="text"
                            value={configSite.gdriveFolderId ?? ""}
                            placeholder={t("sites.googleDrivePlaceholder")}
                            onChange={(e) => {
                              sites.updateConfigSite({ gdriveFolderId: e.target.value })
                              setDriveValidation(null)
                            }}
                            style={{ flex: 1 }}
                          />
                          <button
                            type="button"
                            className="secondary-btn"
                            style={{ whiteSpace: "nowrap", padding: "6px 12px", fontSize: 13 }}
                            disabled={!configSite.gdriveFolderId?.trim() || driveValidation?.status === "loading"}
                            onClick={async () => {
                              const folderId = configSite.gdriveFolderId?.trim()
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
                          value={configSite.cmsMedia?.provider ?? ""}
                          onChange={(e) => {
                            const provider = e.target.value as "" | "contentful" | "sanity" | "strapi"
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
                      {configSite.cmsMedia?.provider === "contentful" && (
                        <>
                          <label className="sites-form-field">
                            <span>{t("sites.spaceId")}</span>
                            <input
                              type="text"
                              value={configSite.cmsMedia.spaceId}
                              placeholder={t("sites.spaceIdPlaceholder")}
                              onChange={(e) => sites.updateConfigSite({ cmsMedia: { ...configSite.cmsMedia!, spaceId: e.target.value } as typeof configSite.cmsMedia })}
                            />
                          </label>
                          <label className="sites-form-field">
                            <span>{t("sites.deliveryToken")}</span>
                            <textarea
                              rows={2}
                              value={configSite.cmsMedia.deliveryToken}
                              placeholder={t("sites.deliveryTokenPlaceholder")}
                              onChange={(e) => sites.updateConfigSite({ cmsMedia: { ...configSite.cmsMedia!, deliveryToken: e.target.value } as typeof configSite.cmsMedia })}
                            />
                          </label>
                        </>
                      )}
                      {configSite.cmsMedia?.provider === "sanity" && (
                        <>
                          <label className="sites-form-field">
                            <span>{t("sites.projectId")}</span>
                            <input
                              type="text"
                              value={configSite.cmsMedia.projectId}
                              placeholder={t("sites.spaceIdPlaceholder")}
                              onChange={(e) => sites.updateConfigSite({ cmsMedia: { ...configSite.cmsMedia!, projectId: e.target.value } as typeof configSite.cmsMedia })}
                            />
                          </label>
                          <label className="sites-form-field">
                            <span>{t("sites.dataset")}</span>
                            <input
                              type="text"
                              value={configSite.cmsMedia.dataset ?? ""}
                              placeholder={t("sites.datasetPlaceholder")}
                              onChange={(e) => sites.updateConfigSite({ cmsMedia: { ...configSite.cmsMedia!, dataset: e.target.value || undefined } as typeof configSite.cmsMedia })}
                            />
                          </label>
                        </>
                      )}
                      {configSite.cmsMedia?.provider === "strapi" && (
                        <>
                          <label className="sites-form-field">
                            <span>{t("sites.strapiUrl")}</span>
                            <input
                              type="url"
                              value={configSite.cmsMedia.url}
                              placeholder={t("sites.strapiUrlPlaceholder")}
                              onChange={(e) => sites.updateConfigSite({ cmsMedia: { ...configSite.cmsMedia!, url: e.target.value } as typeof configSite.cmsMedia })}
                            />
                          </label>
                          <label className="sites-form-field">
                            <span>{t("sites.apiToken")}</span>
                            <textarea
                              rows={2}
                              value={configSite.cmsMedia.token ?? ""}
                              placeholder={t("sites.apiTokenPlaceholder")}
                              onChange={(e) => sites.updateConfigSite({ cmsMedia: { ...configSite.cmsMedia!, token: e.target.value || undefined } as typeof configSite.cmsMedia })}
                            />
                          </label>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
