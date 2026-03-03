import { useEffect, useMemo, useState } from "react"
import type { RestoreSnapshot, SiteConfig } from "../lib/editor-types"
import {
  DEFAULT_SITE_HOSTING,
  SITE_LIST_STORAGE_KEY,
  loadSiteListFromStorage,
  orchestrator,
  sanitizeSiteId,
  siteNameFromId
} from "../lib/editor-utils"

export function useSiteList(siteId: string, session: string) {
  const [siteList, setSiteList] = useState<SiteConfig[]>(() => loadSiteListFromStorage(siteId))
  const [newSiteName, setNewSiteName] = useState("")
  const [newSitePurpose, setNewSitePurpose] = useState("")
  const [newSiteTone, setNewSiteTone] = useState("")
  const [newSiteConstraints, setNewSiteConstraints] = useState("")
  const [newSiteHosting, setNewSiteHosting] = useState(DEFAULT_SITE_HOSTING)
  const [showSiteModal, setShowSiteModal] = useState(false)
  const [configSiteId, setConfigSiteId] = useState<string | null>(null)
  const [restoreSiteId, setRestoreSiteId] = useState<string | null>(null)
  const [restoreOptions, setRestoreOptions] = useState<RestoreSnapshot[]>([])
  const [restoreCommit, setRestoreCommit] = useState("")
  const [isLoadingRestoreOptions, setIsLoadingRestoreOptions] = useState(false)
  const [isRestoringSnapshot, setIsRestoringSnapshot] = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [siteTileRefreshToken, setSiteTileRefreshToken] = useState(0)

  useEffect(() => {
    if (typeof window === "undefined") return
    try {
      window.localStorage.setItem(SITE_LIST_STORAGE_KEY, JSON.stringify(siteList))
    } catch {
      // Ignore storage failures.
    }
  }, [siteList])

  const activeSiteConfig = useMemo(() => {
    const match = siteList.find((site) => site.id === siteId)
    if (match) return match
    return {
      id: siteId,
      name: siteNameFromId(siteId) || "Site",
      purpose: "",
      hosting: DEFAULT_SITE_HOSTING,
      tone: "",
      constraints: []
    } satisfies SiteConfig
  }, [siteId, siteList])

  const openEditorForSite = (targetSiteId: string) => {
    const url = new URL("/", window.location.origin)
    url.searchParams.set("siteId", targetSiteId)
    window.location.href = url.toString()
  }

  const openRestoreModal = async (targetSiteId: string) => {
    setRestoreSiteId(targetSiteId)
    setRestoreError(null)
    setIsLoadingRestoreOptions(true)
    setRestoreOptions([])
    setRestoreCommit("")
    try {
      const res = await fetch(`${orchestrator}/restore/snapshots?limit=30`)
      const data = (await res.json()) as { snapshots?: RestoreSnapshot[]; error?: string }
      if (!res.ok) {
        setRestoreError(data.error ?? "Failed to load snapshots.")
        return
      }
      const options = Array.isArray(data.snapshots) ? data.snapshots : []
      setRestoreOptions(options)
      setRestoreCommit(options[0]?.commit ?? "")
      if (options.length === 0) {
        setRestoreError("No snapshots available yet.")
      }
    } catch {
      setRestoreError("Failed to load snapshots.")
    } finally {
      setIsLoadingRestoreOptions(false)
    }
  }

  const restoreSnapshotForSite = async () => {
    if (!restoreSiteId || !restoreCommit) return
    setRestoreError(null)
    setIsRestoringSnapshot(true)
    try {
      const res = await fetch(`${orchestrator}/restore/snapshot`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commit: restoreCommit,
          session,
          siteId: restoreSiteId
        })
      })
      const data = (await res.json()) as { error?: string }
      if (!res.ok) {
        setRestoreError(data.error ?? "Failed to restore snapshot.")
        return
      }
      setSiteTileRefreshToken((prev) => prev + 1)
      setRestoreSiteId(null)
      setRestoreCommit("")
      setRestoreOptions([])
    } catch {
      setRestoreError("Failed to restore snapshot.")
    } finally {
      setIsRestoringSnapshot(false)
    }
  }

  const addSiteFromName = () => {
    const name = newSiteName.trim()
    if (!name) return
    const baseId = sanitizeSiteId(name) || "site"
    const takenIds = new Set(siteList.map((site) => site.id))
    let nextId = baseId
    let suffix = 2
    while (takenIds.has(nextId)) {
      nextId = `${baseId}-${suffix}`
      suffix += 1
    }
    const parsedConstraints = newSiteConstraints
      .split(/\n|,/g)
      .map((item) => item.trim())
      .filter(Boolean)
    setSiteList((prev) => [
      ...prev,
      {
        id: nextId,
        name,
        purpose: newSitePurpose.trim(),
        hosting: newSiteHosting.trim() || DEFAULT_SITE_HOSTING,
        tone: newSiteTone.trim(),
        constraints: parsedConstraints
      }
    ])
    setNewSiteName("")
    setNewSitePurpose("")
    setNewSiteTone("")
    setNewSiteConstraints("")
    setNewSiteHosting(DEFAULT_SITE_HOSTING)
    setShowSiteModal(false)
  }

  const configSite = useMemo(() => {
    if (!configSiteId) return null
    return siteList.find((site) => site.id === configSiteId) ?? null
  }, [configSiteId, siteList])

  const updateConfigSite = (patch: Partial<Pick<SiteConfig, "name" | "purpose" | "hosting" | "tone" | "constraints">>) => {
    if (!configSiteId) return
    setSiteList((prev) =>
      prev.map((site) =>
        site.id === configSiteId
          ? {
              ...site,
              ...(patch.name !== undefined ? { name: patch.name } : {}),
              ...(patch.purpose !== undefined ? { purpose: patch.purpose } : {}),
              ...(patch.hosting !== undefined ? { hosting: patch.hosting } : {}),
              ...(patch.tone !== undefined ? { tone: patch.tone } : {}),
              ...(patch.constraints !== undefined ? { constraints: patch.constraints } : {})
            }
          : site
      )
    )
  }

  return {
    siteList,
    activeSiteConfig,
    newSiteName,
    setNewSiteName,
    newSitePurpose,
    setNewSitePurpose,
    newSiteTone,
    setNewSiteTone,
    newSiteConstraints,
    setNewSiteConstraints,
    newSiteHosting,
    setNewSiteHosting,
    showSiteModal,
    setShowSiteModal,
    configSiteId,
    setConfigSiteId,
    configSite,
    restoreSiteId,
    setRestoreSiteId,
    restoreOptions,
    restoreCommit,
    setRestoreCommit,
    isLoadingRestoreOptions,
    isRestoringSnapshot,
    restoreError,
    siteTileRefreshToken,
    addSiteFromName,
    openEditorForSite,
    openRestoreModal,
    restoreSnapshotForSite,
    updateConfigSite
  }
}

export type UseSiteListReturn = ReturnType<typeof useSiteList>
