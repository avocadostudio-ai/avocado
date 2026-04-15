import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { RestoreSnapshot, SiteConfig } from "../lib/editor-types"
import {
  DEFAULT_SITE_HOSTING,
  SITE_LIST_STORAGE_KEY,
  loadSiteListFromStorage,
  orchestrator,
  sanitizeSiteId,
  siteNameFromId,
  resolveEditorPreviewUrl
} from "../lib/editor-utils"
import { isPresetId, markPresetDeleted, unmarkPresetDeleted } from "../lib/site-presets"
import { useEditorStore } from "../store"
import { showSiteSwitchOverlay } from "../lib/site-switch-overlay"
import { getT, resolveLocale } from "@/i18n"

/** Orchestrator-side site header config (name, logo, navLabels). */
export interface HeaderConfig {
  name?: string
  logo?: string
  navLabels?: Record<string, string>
}

/** Form fields for creating a new site. */
export interface NewSiteFormState {
  name: string
  purpose: string
  tone: string
  constraints: string
  hosting: string
  previewUrl: string
  vercelProjectId: string
  vercelTeamId: string
  vercelProductionUrl: string
  vercelDeployHookUrl: string
}

const INITIAL_NEW_SITE_FORM: NewSiteFormState = {
  name: "",
  purpose: "",
  tone: "",
  constraints: "",
  hosting: DEFAULT_SITE_HOSTING,
  previewUrl: "",
  vercelProjectId: "",
  vercelTeamId: "",
  vercelProductionUrl: "",
  vercelDeployHookUrl: ""
}

/** State for the restore-snapshot modal. */
export interface RestoreState {
  siteId: string | null
  options: RestoreSnapshot[]
  commit: string
  isLoading: boolean
  isRestoring: boolean
  error: string | null
}

const INITIAL_RESTORE_STATE: RestoreState = {
  siteId: null,
  options: [],
  commit: "",
  isLoading: false,
  isRestoring: false,
  error: null
}

export function useSiteList(siteId: string, session: string) {
  const [siteList, setSiteList] = useState<SiteConfig[]>(() => loadSiteListFromStorage(siteId))
  const [newSiteForm, setNewSiteForm] = useState<NewSiteFormState>(INITIAL_NEW_SITE_FORM)
  const [showSiteModal, setShowSiteModal] = useState(false)
  const [configSiteId, setConfigSiteId] = useState<string | null>(null)
  const [restoreState, setRestoreState] = useState<RestoreState>(INITIAL_RESTORE_STATE)
  const [siteTileRefreshToken, setSiteTileRefreshToken] = useState(0)
  const [headerConfig, setHeaderConfig] = useState<HeaderConfig>({})
  const [draftSlugs, setDraftSlugs] = useState<string[]>([])
  const headerConfigDirty = useRef(false)

  /** Update one or more fields of the new-site form. */
  const updateNewSiteForm = useCallback(
    (patch: Partial<NewSiteFormState>) =>
      setNewSiteForm((prev) => ({ ...prev, ...patch })),
    []
  )

  /** Reset the new-site form to defaults. */
  const resetNewSiteForm = useCallback(
    () => setNewSiteForm(INITIAL_NEW_SITE_FORM),
    []
  )

  /** Update one or more fields of the restore state. */
  const updateRestoreState = useCallback(
    (patch: Partial<RestoreState>) =>
      setRestoreState((prev) => ({ ...prev, ...patch })),
    []
  )

  useEffect(() => {
    if (typeof window === "undefined") return
    try {
      window.localStorage.setItem(SITE_LIST_STORAGE_KEY, JSON.stringify(siteList))
    } catch {
      // Ignore storage failures.
    }
  }, [siteList])

  // On mount, fetch the orchestrator's site registry and merge any sites we
  // don't already know about into the local list. This is how sites registered
  // out-of-band (e.g. via the `@ai-site-editor/site-sdk register` bin script
  // or an external coding agent calling POST /sites/register) auto-appear in
  // the dashboard without forcing the user to click "Add Site".
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`${orchestrator}/sites?session=${encodeURIComponent(session)}`)
        if (!res.ok || cancelled) return
        const data = (await res.json()) as { sites?: Array<Partial<SiteConfig> & { id?: string }> }
        if (!Array.isArray(data.sites) || data.sites.length === 0) return
        const isProduction = typeof window !== "undefined" && !window.location.hostname.includes("localhost")
        setSiteList((prev) => {
          const known = new Set(prev.map((s) => s.id))
          const additions: SiteConfig[] = []
          for (const incoming of data.sites!) {
            if (!incoming.id || known.has(incoming.id)) continue
            // Skip localhost-based sites on production deployments
            if (isProduction && incoming.previewUrl && /localhost|127\.0\.0\.1/i.test(incoming.previewUrl)) continue
            // Coerce partial orchestrator-side config into the editor's SiteConfig shape
            additions.push({
              id: incoming.id,
              name: incoming.name ?? siteNameFromId(incoming.id) ?? "Site",
              purpose: incoming.purpose ?? "",
              hosting: incoming.hosting ?? DEFAULT_SITE_HOSTING,
              previewUrl: incoming.previewUrl,
              tone: incoming.tone,
              constraints: incoming.constraints,
              vercelProjectId: incoming.vercelProjectId,
              vercelTeamId: incoming.vercelTeamId,
              vercelProductionUrl: incoming.vercelProductionUrl,
              vercelDeployHookUrl: incoming.vercelDeployHookUrl,
              gdriveFolderId: incoming.gdriveFolderId,
              cmsMedia: incoming.cmsMedia,
              enablePuck: incoming.enablePuck,
              pageTemplates: incoming.pageTemplates,
            })
          }
          if (additions.length === 0) return prev
          return [...prev, ...additions]
        })
      } catch { /* offline / orchestrator down — fall back to localStorage */ }
    })()
    return () => { cancelled = true }
  }, [session])

  // Fetch orchestrator-side header config on mount and when config modal opens
  const fetchHeaderConfig = useCallback(async (targetSiteId: string) => {
    const qs = `session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(targetSiteId)}`
    try {
      const [configRes, slugsRes] = await Promise.all([
        fetch(`${orchestrator}/draft/site-config?${qs}`),
        fetch(`${orchestrator}/draft/slugs?${qs}`)
      ])
      if (configRes.ok) {
        const data = (await configRes.json()) as HeaderConfig
        setHeaderConfig(data)
      }
      if (slugsRes.ok) {
        const data = (await slugsRes.json()) as { slugs: string[] }
        setDraftSlugs(data.slugs ?? [])
      }
    } catch { /* ignore */ }
  }, [session])

  // Initial fetch for the active site
  useEffect(() => {
    void fetchHeaderConfig(siteId)
  }, [siteId, fetchHeaderConfig])

  // Re-fetch when config modal opens (may be a different site)
  useEffect(() => {
    if (!configSiteId) return
    void fetchHeaderConfig(configSiteId)
  }, [configSiteId, fetchHeaderConfig])

  const updateHeaderConfig = useCallback(
    async (patch: Partial<HeaderConfig>) => {
      const targetSiteId = configSiteId ?? siteId
      const merged = {
        ...headerConfig,
        ...patch,
        ...(patch.navLabels ? { navLabels: { ...(headerConfig.navLabels ?? {}), ...patch.navLabels } } : {})
      }
      setHeaderConfig(merged)
      headerConfigDirty.current = true
      try {
        await fetch(`${orchestrator}/draft/site-config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session, siteId: targetSiteId, config: merged })
        })
      } catch { /* ignore */ }
    },
    [headerConfig, session, configSiteId, siteId]
  )

  const queryPreviewUrl = resolveEditorPreviewUrl()

  const activeSiteConfig = useMemo(() => {
    const match = siteList.find((site) => site.id === siteId)
    if (match) {
      // Query-param previewUrl overrides the stored config
      if (queryPreviewUrl && !match.previewUrl) return { ...match, previewUrl: queryPreviewUrl }
      return match
    }
    return {
      id: siteId,
      name: siteNameFromId(siteId) || "Site",
      purpose: "",
      hosting: DEFAULT_SITE_HOSTING,
      vercelProjectId: "",
      vercelTeamId: "",
      vercelProductionUrl: "",
      vercelDeployHookUrl: "",
      tone: "",
      constraints: [],
      ...(queryPreviewUrl ? { previewUrl: queryPreviewUrl } : {}),
    } satisfies SiteConfig
  }, [siteId, siteList, queryPreviewUrl])

  const openEditorForSite = (targetSiteId: string, opts?: { skipDirtyCheck?: boolean }) => {
    const targetSite = siteList.find((s) => s.id === targetSiteId)
    const t = getT(resolveLocale())
    if (!opts?.skipDirtyCheck) {
      const inFlight = useEditorStore.getState().isLoading
      if (inFlight && !window.confirm(t("sites.switchInFlight"))) return
    }
    const editorPath = targetSite?.enablePuck ? "/editor/puck" : "/editor"
    const url = new URL(editorPath, window.location.origin)
    url.searchParams.set("siteId", targetSiteId)
    url.searchParams.delete("poc")
    showSiteSwitchOverlay(targetSite?.name ?? targetSiteId, t("sites.switchingTo"))
    window.location.href = url.toString()
  }

  const openRestoreModal = async (targetSiteId: string) => {
    setRestoreState({
      siteId: targetSiteId,
      error: null,
      isLoading: true,
      isRestoring: false,
      options: [],
      commit: ""
    })
    try {
      const res = await fetch(`${orchestrator}/restore/snapshots?limit=30&siteId=${encodeURIComponent(targetSiteId)}`)
      const data = (await res.json()) as { snapshots?: RestoreSnapshot[]; error?: string }
      if (!res.ok) {
        setRestoreState((prev) => ({ ...prev, error: data.error ?? "Failed to load snapshots.", isLoading: false }))
        return
      }
      const options = Array.isArray(data.snapshots) ? data.snapshots : []
      setRestoreState((prev) => ({
        ...prev,
        options,
        commit: options[0]?.commit ?? "",
        error: options.length === 0 ? "No snapshots available yet." : null,
        isLoading: false
      }))
    } catch {
      setRestoreState((prev) => ({ ...prev, error: "Failed to load snapshots.", isLoading: false }))
    }
  }

  const deleteSnapshot = async (commit: string) => {
    if (!restoreState.siteId) return
    setRestoreState((prev) => ({ ...prev, error: null }))
    try {
      const res = await fetch(`${orchestrator}/restore/snapshot`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commit })
      })
      const data = (await res.json()) as { error?: string }
      if (!res.ok) {
        setRestoreState((prev) => ({ ...prev, error: data.error ?? "Failed to delete snapshot." }))
        return
      }
      setRestoreState((prev) => {
        const options = prev.options.filter((o) => o.commit !== commit)
        return {
          ...prev,
          options,
          commit: prev.commit === commit ? (options[0]?.commit ?? "") : prev.commit
        }
      })
    } catch {
      setRestoreState((prev) => ({ ...prev, error: "Failed to delete snapshot." }))
    }
  }

  const restoreSnapshotForSite = async (commitOverride?: string) => {
    const commit = commitOverride ?? restoreState.commit
    if (!restoreState.siteId || !commit) return
    setRestoreState((prev) => ({ ...prev, error: null, isRestoring: true }))
    try {
      const res = await fetch(`${orchestrator}/restore/snapshot`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commit,
          session,
          siteId: restoreState.siteId
        })
      })
      const data = (await res.json()) as { error?: string }
      if (!res.ok) {
        setRestoreState((prev) => ({ ...prev, error: data.error ?? "Failed to restore snapshot.", isRestoring: false }))
        return
      }
      setSiteTileRefreshToken((prev) => prev + 1)
      openEditorForSite(restoreState.siteId, { skipDirtyCheck: true })
      setRestoreState(INITIAL_RESTORE_STATE)
    } catch {
      setRestoreState((prev) => ({ ...prev, error: "Failed to restore snapshot.", isRestoring: false }))
    }
  }

  const addSiteFromName = () => {
    const name = newSiteForm.name.trim()
    if (!name) return
    const baseId = sanitizeSiteId(name) || "site"
    const takenIds = new Set(siteList.map((site) => site.id))
    let nextId = baseId
    let suffix = 2
    while (takenIds.has(nextId)) {
      nextId = `${baseId}-${suffix}`
      suffix += 1
    }
    const parsedConstraints = newSiteForm.constraints
      .split(/\n|,/g)
      .map((item) => item.trim())
      .filter(Boolean)
    const previewUrl = newSiteForm.previewUrl.trim()
    // If the user is re-adding a preset they previously deleted, clear
    // the tombstone so mergePresets stops filtering it.
    if (isPresetId(nextId)) unmarkPresetDeleted(nextId)
    setSiteList((prev) => [
      ...prev,
      {
        id: nextId,
        name,
        purpose: newSiteForm.purpose.trim(),
        hosting: newSiteForm.hosting.trim() || DEFAULT_SITE_HOSTING,
        ...(previewUrl ? { previewUrl } : {}),
        vercelProjectId: newSiteForm.vercelProjectId.trim(),
        vercelTeamId: newSiteForm.vercelTeamId.trim(),
        vercelProductionUrl: newSiteForm.vercelProductionUrl.trim(),
        vercelDeployHookUrl: newSiteForm.vercelDeployHookUrl.trim(),
        tone: newSiteForm.tone.trim(),
        constraints: parsedConstraints
      }
    ])
    resetNewSiteForm()
    setShowSiteModal(false)
  }

  const configSite = useMemo(() => {
    if (!configSiteId) return null
    return siteList.find((site) => site.id === configSiteId) ?? null
  }, [configSiteId, siteList])

  const updateConfigSite = (
    patch: Partial<
      Pick<
        SiteConfig,
        "name" | "purpose" | "hosting" | "previewUrl" | "vercelProjectId" | "vercelTeamId" | "vercelProductionUrl" | "vercelDeployHookUrl" | "tone" | "constraints" | "pageTemplates" | "gdriveFolderId" | "cmsMedia" | "enablePuck"
      >
    >
  ) => {
    if (!configSiteId) return
    setSiteList((prev) =>
      prev.map((site) =>
        site.id === configSiteId
          ? {
              ...site,
              ...(patch.name !== undefined ? { name: patch.name } : {}),
              ...(patch.purpose !== undefined ? { purpose: patch.purpose } : {}),
              ...(patch.hosting !== undefined ? { hosting: patch.hosting } : {}),
              ...(patch.previewUrl !== undefined ? { previewUrl: patch.previewUrl } : {}),
              ...(patch.vercelProjectId !== undefined ? { vercelProjectId: patch.vercelProjectId } : {}),
              ...(patch.vercelTeamId !== undefined ? { vercelTeamId: patch.vercelTeamId } : {}),
              ...(patch.vercelProductionUrl !== undefined ? { vercelProductionUrl: patch.vercelProductionUrl } : {}),
              ...(patch.vercelDeployHookUrl !== undefined ? { vercelDeployHookUrl: patch.vercelDeployHookUrl } : {}),
              ...(patch.tone !== undefined ? { tone: patch.tone } : {}),
              ...(patch.constraints !== undefined ? { constraints: patch.constraints } : {}),
              ...(patch.pageTemplates !== undefined ? { pageTemplates: patch.pageTemplates } : {}),
              ...(patch.gdriveFolderId !== undefined ? { gdriveFolderId: patch.gdriveFolderId } : {}),
              ...(patch.cmsMedia !== undefined ? { cmsMedia: patch.cmsMedia } : {}),
              ...(patch.enablePuck !== undefined ? { enablePuck: patch.enablePuck } : {})
            }
          : site
      )
    )
  }

  const updateActiveSiteConfig = useCallback(
    (patch: Partial<Pick<SiteConfig, "name" | "purpose" | "hosting" | "tone" | "constraints" | "gdriveFolderId" | "vercelProjectId" | "vercelTeamId" | "vercelProductionUrl" | "vercelDeployHookUrl">>) => {
      setSiteList((prev) =>
        prev.map((site) =>
          site.id === siteId ? { ...site, ...patch } : site
        )
      )
    },
    [siteId]
  )

  return {
    siteList,
    activeSiteConfig,
    newSiteForm,
    updateNewSiteForm,
    resetNewSiteForm,
    showSiteModal,
    setShowSiteModal,
    configSiteId,
    setConfigSiteId,
    configSite,
    restoreState,
    updateRestoreState,
    siteTileRefreshToken,
    addSiteFromName,
    addSiteFromConfig: (config: SiteConfig) => {
      if (isPresetId(config.id)) unmarkPresetDeleted(config.id)
      setSiteList((prev) => {
        const existing = prev.find((s) => s.id === config.id)
        if (existing) {
          // Update existing entry with new config (e.g. previewUrl from migration)
          return prev.map((s) => s.id === config.id ? { ...s, ...config } : s)
        }
        return [...prev, config]
      })
    },
    removeSite: (id: string) => {
      setSiteList((prev) => prev.filter((s) => s.id !== id))
      if (configSiteId === id) setConfigSiteId(null)
      // Remember the deletion so the preset isn't re-added on the next
      // page load by mergePresets in loadSiteListFromStorage.
      if (isPresetId(id)) markPresetDeleted(id)
    },
    openEditorForSite,
    openRestoreModal,
    deleteSnapshot,
    restoreSnapshotForSite,
    updateConfigSite,
    updateActiveSiteConfig,
    headerConfig,
    updateHeaderConfig,
    headerConfigDirty,
    draftSlugs
  }
}

export type UseSiteListReturn = ReturnType<typeof useSiteList>
