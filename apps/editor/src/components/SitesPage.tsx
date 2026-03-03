import { SiteTileDesktopPreview } from "./SiteTileDesktopPreview"
import { DEFAULT_SITE_HOSTING, LEGACY_AVOCADO_SITE_ID, siteOrigin } from "../lib/editor-utils"
import type { UseSiteListReturn } from "../hooks/useSiteList"

export function SitesPage({ sites, session }: { sites: UseSiteListReturn; session: string }) {
  const dedupedSites = sites.siteList
    .filter((site, index, all) => all.findIndex((row) => row.id === site.id) === index)
    .sort((a, b) => {
      const aLegacy = a.id === LEGACY_AVOCADO_SITE_ID ? 1 : 0
      const bLegacy = b.id === LEGACY_AVOCADO_SITE_ID ? 1 : 0
      return aLegacy - bLegacy
    })

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
              sites.setNewSiteName("")
              sites.setNewSitePurpose("")
              sites.setNewSiteTone("")
              sites.setNewSiteConstraints("")
              sites.setNewSiteHosting(DEFAULT_SITE_HOSTING)
              sites.setShowSiteModal(true)
            }}
          >
            Add site
          </button>
        </div>
      </header>
      <section className="sites-grid" aria-label="Site tiles">
        {dedupedSites.map((site) => {
          const previewSrc = new URL(`${siteOrigin}/`, window.location.origin)
          previewSrc.searchParams.set("session", session)
          previewSrc.searchParams.set("siteId", site.id)
          previewSrc.searchParams.set("siteName", site.name)
          previewSrc.searchParams.set("__tile", "1")
          previewSrc.searchParams.set("__refresh", String(sites.siteTileRefreshToken))
          return (
            <article key={site.id} className="site-tile">
              <SiteTileDesktopPreview title={`${site.name} home preview`} src={previewSrc.toString()} />
              <div className="site-tile-meta">
                <h2>{site.name}</h2>
                {site.purpose ? <p className="site-purpose">{site.purpose}</p> : null}
                <div className="site-tile-actions">
                  <button type="button" className="secondary-btn site-config-btn" onClick={() => sites.setConfigSiteId(site.id)} aria-label={`Configure ${site.name}`}>
                    <svg viewBox="0 0 20 20" aria-hidden="true">
                      <path d="M8.8 2h2.4l.5 2.1a6.7 6.7 0 0 1 1.5.6l1.9-1.1 1.7 1.7-1.1 1.9c.2.5.4 1 .5 1.5l2.1.5v2.4l-2.1.5a6.7 6.7 0 0 1-.6 1.5l1.1 1.9-1.7 1.7-1.9-1.1a6.7 6.7 0 0 1-1.5.6L11.2 18H8.8l-.5-2.1a6.7 6.7 0 0 1-1.5-.6l-1.9 1.1-1.7-1.7 1.1-1.9a6.7 6.7 0 0 1-.6-1.5L2 11.2V8.8l2.1-.5c.1-.5.3-1 .6-1.5L3.6 4.9l1.7-1.7 1.9 1.1c.5-.2 1-.4 1.5-.5L8.8 2z" />
                      <circle cx="10" cy="10" r="2.4" />
                    </svg>
                    <span>Settings</span>
                  </button>
                  <button type="button" className="secondary-btn site-config-btn" onClick={() => void sites.openRestoreModal(site.id)} aria-label={`Restore snapshot for ${site.name}`}>
                    <span>Restore snapshot</span>
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
                    value={sites.newSiteName}
                    placeholder="Adventure Arena"
                    onChange={(event) => sites.setNewSiteName(event.target.value)}
                  />
                </label>
                <label className="sites-form-field">
                  <span>Hosting</span>
                  <input
                    type="text"
                    value={sites.newSiteHosting}
                    placeholder="Vercel production site (single shared project)"
                    onChange={(event) => sites.setNewSiteHosting(event.target.value)}
                  />
                </label>
                <p className="sites-form-section-title">AI guidance</p>
                <label className="sites-form-field sites-form-field-wide">
                  <span>Site purpose</span>
                  <textarea
                    value={sites.newSitePurpose}
                    placeholder="Describe business goals, audiences, and conversion intent."
                    onChange={(event) => sites.setNewSitePurpose(event.target.value)}
                    rows={5}
                  />
                </label>
                <label className="sites-form-field sites-form-field-wide">
                  <span>Preferred tone</span>
                  <textarea
                    value={sites.newSiteTone}
                    placeholder="Bold, dynamic, motivating. Short paragraphs. Strong verbs."
                    onChange={(event) => sites.setNewSiteTone(event.target.value)}
                    rows={3}
                  />
                </label>
                <label className="sites-form-field sites-form-field-wide">
                  <span>AI constraints</span>
                  <textarea
                    value={sites.newSiteConstraints}
                    placeholder={"Use active voice.\nAvoid generic phrases.\nAlways include a clear CTA suggestion."}
                    onChange={(event) => sites.setNewSiteConstraints(event.target.value)}
                    rows={5}
                  />
                </label>
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
      {sites.configSite ? (
        <div className="sites-modal-backdrop" onClick={() => sites.setConfigSiteId(null)}>
          <section className="sites-modal" role="dialog" aria-modal="true" aria-label="Site config" onClick={(event) => event.stopPropagation()}>
            <header className="sites-modal-header">
              <h2>Site Config</h2>
              <button type="button" className="settings-close-btn" onClick={() => sites.setConfigSiteId(null)} aria-label="Close">
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
                    value={sites.configSite.name}
                    placeholder="Site name"
                    onChange={(event) => sites.updateConfigSite({ name: event.target.value })}
                  />
                </label>
                <label className="sites-form-field">
                  <span>Hosting</span>
                  <input
                    type="text"
                    value={sites.configSite.hosting}
                    placeholder="Hosting configuration"
                    onChange={(event) => sites.updateConfigSite({ hosting: event.target.value })}
                  />
                </label>
                <p className="sites-form-section-title">AI guidance</p>
                <label className="sites-form-field sites-form-field-wide">
                  <span>Site purpose</span>
                  <textarea
                    value={sites.configSite.purpose}
                    placeholder="Site purpose for AI context"
                    onChange={(event) => sites.updateConfigSite({ purpose: event.target.value })}
                    rows={5}
                  />
                </label>
                <label className="sites-form-field sites-form-field-wide">
                  <span>Preferred tone</span>
                  <textarea
                    value={sites.configSite.tone ?? ""}
                    placeholder="Preferred tone for AI"
                    onChange={(event) => sites.updateConfigSite({ tone: event.target.value })}
                    rows={3}
                  />
                </label>
                <label className="sites-form-field sites-form-field-wide">
                  <span>AI constraints</span>
                  <textarea
                    value={(sites.configSite.constraints ?? []).join("\n")}
                    placeholder="AI constraints (one per line)"
                    onChange={(event) =>
                      sites.updateConfigSite({
                        constraints: event.target.value
                          .split(/\n|,/g)
                          .map((item) => item.trim())
                          .filter(Boolean)
                      })
                    }
                    rows={5}
                  />
                </label>
              </div>
            </div>
            <footer className="sites-modal-footer">
              <button type="button" className="primary-btn" onClick={() => sites.setConfigSiteId(null)}>
                Done
              </button>
            </footer>
          </section>
        </div>
      ) : null}
      {sites.restoreSiteId ? (
        <div className="sites-modal-backdrop" onClick={() => sites.setRestoreSiteId(null)}>
          <section className="sites-modal" role="dialog" aria-modal="true" aria-label="Restore snapshot" onClick={(event) => event.stopPropagation()}>
            <header className="sites-modal-header">
              <h2>Restore Snapshot</h2>
              <button type="button" className="settings-close-btn" onClick={() => sites.setRestoreSiteId(null)} aria-label="Close">
                ×
              </button>
            </header>
            <div className="sites-modal-body">
              <p className="site-purpose">Restore a previous published snapshot into <strong>{sites.restoreSiteId}</strong>.</p>
              <label className="sites-form-field">
                <span>Snapshot version</span>
                <select
                  value={sites.restoreCommit}
                  onChange={(event) => sites.setRestoreCommit(event.target.value)}
                  disabled={sites.isLoadingRestoreOptions || sites.isRestoringSnapshot || sites.restoreOptions.length === 0}
                >
                  {sites.restoreOptions.map((option) => {
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
              {sites.restoreError ? <p className="site-purpose">{sites.restoreError}</p> : null}
            </div>
            <footer className="sites-modal-footer">
              <button type="button" className="secondary-btn" onClick={() => sites.setRestoreSiteId(null)} disabled={sites.isRestoringSnapshot}>
                Cancel
              </button>
              <button
                type="button"
                className="primary-btn"
                onClick={() => void sites.restoreSnapshotForSite()}
                disabled={sites.isLoadingRestoreOptions || sites.isRestoringSnapshot || !sites.restoreCommit}
              >
                {sites.isRestoringSnapshot ? "Restoring..." : "Restore"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </main>
  )
}
