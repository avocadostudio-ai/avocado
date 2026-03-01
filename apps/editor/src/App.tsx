import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import ClaudeStyleChatInput from "./components/claude-style-chat-input"
import Settings2Icon from "./components/settings2-icon"
import { COMPLEX_TASK_HEURISTICS } from "./config/complex-task-heuristics"
import { SharedBlockRenderer } from "@ai-site-editor/blocks"
import type { BlockInstance, ApplyPatchMessage, PatchAckMessage, Operation } from "@ai-site-editor/shared"

type ModelKey = "fast" | "balanced" | "reasoning" | "codex"
type PlannerSource = "openai" | "demo"
type PlannerBadgeState = PlannerSource | "checking" | "error"
type ChatExecutionMode = "auto" | "plan_only" | "apply_pending_plan" | "discard_pending_plan"

type AssistantResponse = {
  status?: string
  summary?: string
  changes?: string[]
  mentionedSlugs?: string[]
  previewVersion?: number
  validationErrors?: string[] | { fieldErrors?: Record<string, string[]>; formErrors?: string[] }
  modelUsed?: string
  modelKey?: string
  plannerSource?: PlannerSource
  pendingPlanId?: string
  focusBlockId?: string
  updatedSlug?: string
  suggestions?: string[]
  debug?: {
    traceId?: string
    promptHash?: string
    promptExcerpt?: string
    outcome?: string
    reasonCategory?: string
    intent?: string
    opTypes?: string[]
    opCount?: number
  }
  error?: string
}

type VariationOption = {
  id: string
  title: string
  summary: string
  patch: Record<string, unknown>
  changedKeys: string[]
}

type VariationResponse = {
  status?: string
  summary?: string
  blockId?: string
  blockType?: string
  pageSlug?: string
  baseProps?: Record<string, unknown>
  variations?: VariationOption[]
  plannerSource?: PlannerSource
  modelUsed?: string
  modelKey?: string
  error?: string
}

type SiteMessage =
  | {
      protocol: "site-editor/v1"
      type: "blockClicked" | "routeChanged" | "blockReordered" | "blockDeleteRequested" | "inlineTextCommitted"
      payload: Record<string, unknown>
    }
  | ({ source: "site-editor/v1" } & PatchAckMessage)

type ChatEntry = {
  id: string
  role: "user" | "assistant"
  text: string
  status?: string
  canUndo?: boolean
  wasUndone?: boolean
  changes?: string[]
  mentionedSlugs?: string[]
  suggestions?: string[]
  errors?: string[]
  meta?: string
  debug?: AssistantResponse["debug"]
  aiJustification?: string
  aiPerformanceNote?: string
  pendingPlanId?: string
}

type ApplyOpsResponse = {
  status?: string
  summary?: string
  changes?: string[]
  previewVersion?: number
  focusBlockId?: string
  updatedSlug?: string
  error?: string
}

type HistoryResponse = {
  status?: string
  previewVersion?: number
  error?: string
}

type PublishResponse = {
  status?: string
  session?: string
  slugs?: string[]
  branch?: string
  commitSha?: string
  message?: string
  reason?: string
  details?: string[]
  deployStatus?: number
  deployResponse?: string
  inspectUrl?: string
  deploymentId?: string
  vercelState?: string
  error?: string
}

type PublishStatus = {
  session?: string
  status?: string
  startedAt?: string
  updatedAt?: string
  slugs?: string[]
  deployStatus?: number
  inspectUrl?: string
  deploymentId?: string
  deploymentUrl?: string
  vercelState?: string
  lastCheckError?: string
}

type VariationModalState = {
  requestText: string
  blockId: string
  blockType: string
  pageSlug: string
  baseProps: Record<string, unknown>
  options: VariationOption[]
}

type PreviewWidthPreset = "desktop" | "tablet" | "mobile"
type SiteConfig = {
  id: string
  name: string
  purpose: string
  hosting: string
}

type RestoreSnapshot = {
  commit: string
  committedAt: string
  message: string
  pageCount: number
  homeHeading: string
}

const SITE_LIST_STORAGE_KEY = "editor-site-list-v1"
const DEFAULT_SITE_HOSTING = "Vercel production site (single shared project)"
const LEGACY_AVOCADO_SITE_ID = "avocado-stories"
const LEGACY_AVOCADO_SITE_NAME = "Avocado Stories"
const LEGACY_AVOCADO_SITE_PURPOSE = "Marketing site for Avocado Stories products, recipes, and sustainability messaging."
const AUTO_SITE_PRESETS: SiteConfig[] = [
  {
    id: "avocado-magic",
    name: "Avocado Magic",
    purpose: "Restored site snapshot: Discover the Magic of Avocados.",
    hosting: DEFAULT_SITE_HOSTING
  },
  {
    id: "avocado-odyssey",
    name: "Avocado Odyssey",
    purpose: "Restored site snapshot: Embark on an Avocado Odyssey.",
    hosting: DEFAULT_SITE_HOSTING
  }
]

function sanitizeSiteId(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function resolveEditorSiteId() {
  const fallback = sanitizeSiteId((import.meta.env.VITE_SITE_ID as string | undefined) ?? "") || "dev-site"
  if (typeof window === "undefined") return fallback
  const fromQuery = sanitizeSiteId(new URLSearchParams(window.location.search).get("siteId") ?? "")
  return fromQuery || fallback
}

function defaultSiteList(siteId: string): SiteConfig[] {
  const resolvedId = sanitizeSiteId(siteId) || "dev-site"
  return [
    {
      id: resolvedId,
      name: siteNameFromId(resolvedId) || "Site",
      purpose: "",
      hosting: DEFAULT_SITE_HOSTING
    }
  ]
}

function loadSiteListFromStorage(siteId: string) {
  if (typeof window === "undefined") return defaultSiteList(siteId)
  try {
    const raw = window.localStorage.getItem(SITE_LIST_STORAGE_KEY)
    if (!raw) return defaultSiteList(siteId)
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return defaultSiteList(siteId)
    const cleaned = parsed
      .filter((site): site is { id: string; name: string; purpose?: string; hosting?: string } => {
        return Boolean(
          site &&
            typeof site === "object" &&
            typeof (site as { id?: unknown }).id === "string" &&
            typeof (site as { name?: unknown }).name === "string"
        )
      })
      .map((site) => ({
        id: sanitizeSiteId(site.id),
        name: site.name.trim(),
        purpose: typeof site.purpose === "string" ? site.purpose.trim() : "",
        hosting: typeof site.hosting === "string" && site.hosting.trim().length > 0 ? site.hosting.trim() : DEFAULT_SITE_HOSTING
      }))
      .filter((site) => site.id.length > 0 && site.name.length > 0)
    const mergePresets = (list: SiteConfig[]) => {
      const existingIds = new Set(list.map((site) => site.id))
      const merged = [...list]
      for (const preset of AUTO_SITE_PRESETS) {
        if (existingIds.has(preset.id)) continue
        merged.push(preset)
      }
      return merged
    }

    if (cleaned.length > 0) {
      if (cleaned.length > 1) {
        const migrated = cleaned.filter((site) => {
          const isLegacyAvocado =
            site.id === LEGACY_AVOCADO_SITE_ID &&
            site.name === LEGACY_AVOCADO_SITE_NAME &&
            (site.purpose === "" || site.purpose === LEGACY_AVOCADO_SITE_PURPOSE) &&
            site.hosting === DEFAULT_SITE_HOSTING
          return !isLegacyAvocado
        })
        if (migrated.length > 0) return mergePresets(migrated)
      }
      return mergePresets(cleaned)
    }
    return mergePresets(defaultSiteList(siteId))
  } catch {
    return [...defaultSiteList(siteId), ...AUTO_SITE_PRESETS]
  }
}

function siteNameFromId(id: string) {
  return id
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function resolveOrigin(value: string | undefined, fallback: string) {
  const trimmed = value?.trim()
  if (!trimmed) return fallback
  return trimmed.replace(/\/+$/, "")
}

const siteOrigin = resolveOrigin(import.meta.env.VITE_SITE_ORIGIN as string | undefined, "http://localhost:3000")
const orchestrator = resolveOrigin(import.meta.env.VITE_ORCHESTRATOR_URL as string | undefined, "http://localhost:4200")
const publishToken = import.meta.env.VITE_PUBLISH_TOKEN as string | undefined
const enablePatchTransport = import.meta.env.VITE_ENABLE_PATCH_TRANSPORT === "1"
const AI_JUSTIFICATION_PREFIX = "__ai_justification__:"
const AI_PERFORMANCE_PREFIX = "__ai_performance__:"
const DEBUG_MODE_STORAGE_KEY = "editor-debug-mode-v1"

const previewPresetWidths: Record<PreviewWidthPreset, number> = {
  desktop: 1200,
  tablet: 834,
  mobile: 390
}

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function resolveDefaultDebugMode() {
  const envEnabled = /^(1|true|yes|on)$/i.test((import.meta.env.VITE_CHAT_DEBUG as string | undefined) ?? "")
  if (envEnabled) return true
  if (typeof window === "undefined") return false
  const stored = window.localStorage.getItem(DEBUG_MODE_STORAGE_KEY)
  return /^(1|true|yes|on)$/i.test(stored ?? "")
}

function slugLabel(route: string) {
  if (route === "/") return "Home (/)"
  const pretty = route
    .slice(1)
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[-_]/g, " "))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" / ")
  return `${pretty || route} (${route})`
}

function extensionFromMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes("webm")) return "webm"
  if (normalized.includes("wav")) return "wav"
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3"
  if (normalized.includes("mp4") || normalized.includes("m4a")) return "m4a"
  return "webm"
}

function isVariationRequest(message: string) {
  const lower = message.toLowerCase()
  const asksGenerate = lower.includes("generate") || lower.includes("create")
  const asksVariation = /variat/.test(lower)
  return asksGenerate && asksVariation
}

function isComplexTaskRequest(message: string) {
  const trimmed = message.trim()
  if (trimmed.length === 0) return false
  const lower = trimmed.toLowerCase()
  const actionPattern = new RegExp(`\\b(${COMPLEX_TASK_HEURISTICS.actionKeywords.join("|")})\\b`, "g")
  const connectorPattern = new RegExp(`\\b(${COMPLEX_TASK_HEURISTICS.connectorKeywords.join("|")})\\b`, "g")
  const actionMatches = (lower.match(actionPattern) ?? []).length
  const connectorMatches = (lower.match(connectorPattern) ?? []).length
  const clauseMatches = (trimmed.match(/[,.!?;]/g) ?? []).length
  if (trimmed.length >= COMPLEX_TASK_HEURISTICS.minCharsForComplex) return true
  if (actionMatches >= COMPLEX_TASK_HEURISTICS.minActionsWithConnector && connectorMatches >= COMPLEX_TASK_HEURISTICS.minConnectorsForActionRule) return true
  if (actionMatches >= COMPLEX_TASK_HEURISTICS.minActionsAny) return true
  return actionMatches >= COMPLEX_TASK_HEURISTICS.minActionsWithClauses && clauseMatches >= COMPLEX_TASK_HEURISTICS.minClausesForActionRule
}

function mergedVariationProps(baseProps: Record<string, unknown>, patch: Record<string, unknown>) {
  return { ...baseProps, ...patch }
}

function normalizeComparableText(value: string) {
  return value
    .toLowerCase()
    .replace(/["'`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function comparableTokens(value: string) {
  const stopwords = new Set([
    "the",
    "a",
    "an",
    "in",
    "on",
    "to",
    "for",
    "of",
    "and",
    "with",
    "by",
    "from",
    "that",
    "this",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "it",
    "its",
    "selected",
    "block"
  ])
  return normalizeComparableText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !stopwords.has(token))
}

function isRedundantChangeLine(summary: string | undefined, line: string) {
  const summaryNorm = normalizeComparableText(summary ?? "")
  const lineNorm = normalizeComparableText(line)
  if (!summaryNorm || !lineNorm) return false
  if (lineNorm === summaryNorm || lineNorm.includes(summaryNorm) || summaryNorm.includes(lineNorm)) return true

  const summaryTokens = new Set(comparableTokens(summaryNorm))
  const lineTokens = new Set(comparableTokens(lineNorm))
  if (summaryTokens.size === 0 || lineTokens.size === 0) return false

  let overlap = 0
  for (const token of lineTokens) {
    if (summaryTokens.has(token)) overlap += 1
  }

  const coverLine = overlap / lineTokens.size
  const coverSummary = overlap / summaryTokens.size
  return coverLine >= 0.55 || coverSummary >= 0.55
}

function splitAiInsightChanges(lines: string[] | undefined) {
  const raw = Array.isArray(lines) ? lines : []
  let aiJustification: string | undefined
  let aiPerformanceNote: string | undefined
  const changes: string[] = []

  for (const line of raw) {
    if (typeof line !== "string") continue
    if (line.startsWith(AI_JUSTIFICATION_PREFIX)) {
      const value = line.slice(AI_JUSTIFICATION_PREFIX.length).trim()
      if (value) aiJustification = value
      continue
    }
    if (line.startsWith(AI_PERFORMANCE_PREFIX)) {
      const value = line.slice(AI_PERFORMANCE_PREFIX.length).trim()
      if (value) aiPerformanceNote = value
      continue
    }
    changes.push(line)
  }

  return { changes, aiJustification, aiPerformanceNote }
}

function VariationScaledPreview(args: { block: BlockInstance; virtualWidth: number }) {
  const shellRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [shellWidth, setShellWidth] = useState(0)
  const [contentHeight, setContentHeight] = useState(240)

  useEffect(() => {
    if (!shellRef.current) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      setShellWidth(Math.max(0, width))
    })
    observer.observe(shellRef.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!canvasRef.current) return
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height ?? 240
      setContentHeight(Math.max(120, height))
    })
    observer.observe(canvasRef.current)
    return () => observer.disconnect()
  }, [args.block.id, args.block.type, args.block.props, args.virtualWidth])

  const scale = shellWidth > 0 ? Math.min(1, shellWidth / args.virtualWidth) : 1
  const scaledHeight = Math.max(170, Math.ceil(contentHeight * scale))

  return (
    <div className="variation-live-preview">
      <div ref={shellRef} className="variation-live-preview-shell" style={{ height: scaledHeight }}>
        <div
          ref={canvasRef}
          className="variation-live-preview-canvas"
          style={
            {
              width: `${args.virtualWidth}px`,
              transform: `scale(${scale})`,
              transformOrigin: "top left"
            } satisfies CSSProperties
          }
        >
          <SharedBlockRenderer block={args.block} />
        </div>
      </div>
    </div>
  )
}

function SiteTileDesktopPreview(args: { title: string; src: string }) {
  const shellRef = useRef<HTMLDivElement>(null)
  const [shellWidth, setShellWidth] = useState(0)
  const virtualWidth = 1200
  const virtualHeight = 760

  useEffect(() => {
    if (!shellRef.current) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      setShellWidth(Math.max(0, width))
    })
    observer.observe(shellRef.current)
    return () => observer.disconnect()
  }, [])

  const scale = shellWidth > 0 ? Math.min(1, shellWidth / virtualWidth) : 1
  const scaledHeight = Math.max(170, Math.ceil(virtualHeight * scale))

  return (
    <div ref={shellRef} className="site-tile-preview" style={{ height: scaledHeight }}>
      <iframe
        title={args.title}
        src={args.src}
        loading="lazy"
        style={{
          width: `${virtualWidth}px`,
          height: `${virtualHeight}px`,
          transform: `scale(${scale})`,
          transformOrigin: "top left"
        }}
      />
    </div>
  )
}

export function App() {
  const pathName = typeof window !== "undefined" ? window.location.pathname : "/"
  const isSitesPage = pathName === "/sites" || pathName === "/sites/"
  const editorOrigin = typeof window !== "undefined" ? window.location.origin : "http://localhost:4100"
  const [session] = useState("dev")
  const [siteId] = useState(() => resolveEditorSiteId())
  const [siteList, setSiteList] = useState<SiteConfig[]>(() => loadSiteListFromStorage(siteId))
  const [newSiteName, setNewSiteName] = useState("")
  const [newSitePurpose, setNewSitePurpose] = useState("")
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
  const [slug, setSlug] = useState("/")
  const [availableSlugs, setAvailableSlugs] = useState<string[]>(["/"])
  const [isLoadingSlugs, setIsLoadingSlugs] = useState(false)
  const [modelKey, setModelKey] = useState<ModelKey>("balanced")
  const [message, setMessage] = useState("")
  const [activeBlockId, setActiveBlockId] = useState<string | undefined>()
  const [activeBlockType, setActiveBlockType] = useState<string | undefined>()
  const [activeEditablePath, setActiveEditablePath] = useState<string | undefined>()
  const [isLoading, setIsLoading] = useState(false)
  const [isPublishing, setIsPublishing] = useState(false)
  const [publishStatus, setPublishStatus] = useState<PublishStatus | null>(null)
  const [useStreaming, setUseStreaming] = useState(true)
  const [showNestedLabels, setShowNestedLabels] = useState(false)
  const [showSettingsModal, setShowSettingsModal] = useState(false)
  const [showDebugDetails, setShowDebugDetails] = useState(() => resolveDefaultDebugMode())
  const [variationModal, setVariationModal] = useState<VariationModalState | null>(null)
  const [variationPreviewPreset, setVariationPreviewPreset] = useState<PreviewWidthPreset>("desktop")
  const [isApplyingVariation, setIsApplyingVariation] = useState(false)
  const [streamStatus, setStreamStatus] = useState<string | null>(null)
  const [streamTokenCount, setStreamTokenCount] = useState(0)
  const [plannerBadgeState, setPlannerBadgeState] = useState<PlannerBadgeState>("checking")
  const [pendingPlanId, setPendingPlanId] = useState<string | null>(null)
  const [pendingPlanMessage, setPendingPlanMessage] = useState<string | null>(null)
  const [composerHeight, setComposerHeight] = useState(124)
  const [settingsPopoverPos, setSettingsPopoverPos] = useState<{ top: number; left: number } | null>(null)
  const [undoInFlightEntryId, setUndoInFlightEntryId] = useState<string | null>(null)
  const [chatLog, setChatLog] = useState<ChatEntry[]>([
    {
      id: "welcome",
      role: "assistant",
      text: "Ask for any website change. Simple edits apply immediately; complex requests pause for plan approval with a stop option.",
      status: "ready"
    }
  ])

  const chatPanelRef = useRef<HTMLElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const chatThreadRef = useRef<HTMLElement>(null)
  const splitHandleRef = useRef<HTMLDivElement>(null)
  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  const activeBlockIdRef = useRef<string | undefined>(undefined)
  const activeBlockTypeRef = useRef<string | undefined>(undefined)
  const activeEditablePathRef = useRef<string | undefined>(undefined)
  const resizeStartRef = useRef<{ y: number; composerHeight: number } | null>(null)
  const lastConfirmedVersionBySlug = useRef<Map<string, number>>(new Map())
  const pendingTxBySlug = useRef<Map<string, { txId: string; timer: ReturnType<typeof setTimeout> }>>(new Map())

  useEffect(() => {
    if (typeof window === "undefined") return
    try {
      window.localStorage.setItem(SITE_LIST_STORAGE_KEY, JSON.stringify(siteList))
    } catch {
      // Ignore storage failures.
    }
  }, [siteList])

  useEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(DEBUG_MODE_STORAGE_KEY, showDebugDetails ? "1" : "0")
  }, [showDebugDetails])

  const activeSiteConfig = useMemo(() => {
    const match = siteList.find((site) => site.id === siteId)
    if (match) return match
    return {
      id: siteId,
      name: siteNameFromId(siteId) || "Site",
      purpose: "",
      hosting: DEFAULT_SITE_HOSTING
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
    setSiteList((prev) => [
      ...prev,
      {
        id: nextId,
        name,
        purpose: newSitePurpose.trim(),
        hosting: newSiteHosting.trim() || DEFAULT_SITE_HOSTING
      }
    ])
    setNewSiteName("")
    setNewSitePurpose("")
    setNewSiteHosting(DEFAULT_SITE_HOSTING)
    setShowSiteModal(false)
  }

  const configSite = useMemo(() => {
    if (!configSiteId) return null
    return siteList.find((site) => site.id === configSiteId) ?? null
  }, [configSiteId, siteList])

  const updateConfigSite = (patch: Partial<Pick<SiteConfig, "name" | "purpose" | "hosting">>) => {
    if (!configSiteId) return
    setSiteList((prev) =>
      prev.map((site) =>
        site.id === configSiteId
          ? {
              ...site,
              ...(patch.name !== undefined ? { name: patch.name } : {}),
              ...(patch.purpose !== undefined ? { purpose: patch.purpose } : {}),
              ...(patch.hosting !== undefined ? { hosting: patch.hosting } : {})
            }
          : site
      )
    )
  }

  if (isSitesPage) {
    const dedupedSites = siteList
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
                setNewSiteName("")
                setNewSitePurpose("")
                setNewSiteHosting(DEFAULT_SITE_HOSTING)
                setShowSiteModal(true)
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
            previewSrc.searchParams.set("__refresh", String(siteTileRefreshToken))
            return (
              <article key={site.id} className="site-tile">
                <SiteTileDesktopPreview title={`${site.name} home preview`} src={previewSrc.toString()} />
                <div className="site-tile-meta">
                  <h2>{site.name}</h2>
                  <p>{site.id} · {site.hosting}</p>
                  {site.purpose ? <p className="site-purpose">{site.purpose}</p> : null}
                  <div className="site-tile-actions">
                    <button type="button" className="secondary-btn site-config-btn" onClick={() => setConfigSiteId(site.id)} aria-label={`Configure ${site.name}`}>
                      <svg viewBox="0 0 20 20" aria-hidden="true">
                        <path d="M8.8 2h2.4l.5 2.1a6.7 6.7 0 0 1 1.5.6l1.9-1.1 1.7 1.7-1.1 1.9c.2.5.4 1 .5 1.5l2.1.5v2.4l-2.1.5a6.7 6.7 0 0 1-.6 1.5l1.1 1.9-1.7 1.7-1.9-1.1a6.7 6.7 0 0 1-1.5.6L11.2 18H8.8l-.5-2.1a6.7 6.7 0 0 1-1.5-.6l-1.9 1.1-1.7-1.7 1.1-1.9a6.7 6.7 0 0 1-.6-1.5L2 11.2V8.8l2.1-.5c.1-.5.3-1 .6-1.5L3.6 4.9l1.7-1.7 1.9 1.1c.5-.2 1-.4 1.5-.5L8.8 2z" />
                        <circle cx="10" cy="10" r="2.4" />
                      </svg>
                      <span>Config</span>
                    </button>
                    <button type="button" className="secondary-btn site-config-btn" onClick={() => void openRestoreModal(site.id)} aria-label={`Restore snapshot for ${site.name}`}>
                      <span>Restore snapshot</span>
                    </button>
                    <button type="button" className="primary-btn" onClick={() => openEditorForSite(site.id)}>
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
        {showSiteModal ? (
          <div className="sites-modal-backdrop" onClick={() => setShowSiteModal(false)}>
            <section className="sites-modal" role="dialog" aria-modal="true" aria-label="Add site" onClick={(event) => event.stopPropagation()}>
              <header className="sites-modal-header">
                <h2>Add Site</h2>
                <button type="button" className="settings-close-btn" onClick={() => setShowSiteModal(false)} aria-label="Close">
                  ×
                </button>
              </header>
              <div className="sites-modal-body">
                <input
                  type="text"
                  value={newSiteName}
                  placeholder="Site name"
                  onChange={(event) => setNewSiteName(event.target.value)}
                />
                <input
                  type="text"
                  value={newSiteHosting}
                  placeholder="Hosting configuration"
                  onChange={(event) => setNewSiteHosting(event.target.value)}
                />
                <textarea
                  value={newSitePurpose}
                  placeholder="Site purpose for AI context (e.g. lead gen for B2B SaaS founders)"
                  onChange={(event) => setNewSitePurpose(event.target.value)}
                  rows={3}
                />
              </div>
              <footer className="sites-modal-footer">
                <button type="button" className="secondary-btn" onClick={() => setShowSiteModal(false)}>
                  Cancel
                </button>
                <button type="button" className="primary-btn" onClick={addSiteFromName}>
                  Create
                </button>
              </footer>
            </section>
          </div>
        ) : null}
        {configSite ? (
          <div className="sites-modal-backdrop" onClick={() => setConfigSiteId(null)}>
            <section className="sites-modal" role="dialog" aria-modal="true" aria-label="Site config" onClick={(event) => event.stopPropagation()}>
              <header className="sites-modal-header">
                <h2>Site Config</h2>
                <button type="button" className="settings-close-btn" onClick={() => setConfigSiteId(null)} aria-label="Close">
                  ×
                </button>
              </header>
              <div className="sites-modal-body">
                <input
                  type="text"
                  value={configSite.name}
                  placeholder="Site name"
                  onChange={(event) => updateConfigSite({ name: event.target.value })}
                />
                <input
                  type="text"
                  value={configSite.hosting}
                  placeholder="Hosting configuration"
                  onChange={(event) => updateConfigSite({ hosting: event.target.value })}
                />
                <textarea
                  value={configSite.purpose}
                  placeholder="Site purpose for AI context"
                  onChange={(event) => updateConfigSite({ purpose: event.target.value })}
                  rows={3}
                />
              </div>
              <footer className="sites-modal-footer">
                <button type="button" className="primary-btn" onClick={() => setConfigSiteId(null)}>
                  Done
                </button>
              </footer>
            </section>
          </div>
        ) : null}
        {restoreSiteId ? (
          <div className="sites-modal-backdrop" onClick={() => setRestoreSiteId(null)}>
            <section className="sites-modal" role="dialog" aria-modal="true" aria-label="Restore snapshot" onClick={(event) => event.stopPropagation()}>
              <header className="sites-modal-header">
                <h2>Restore Snapshot</h2>
                <button type="button" className="settings-close-btn" onClick={() => setRestoreSiteId(null)} aria-label="Close">
                  ×
                </button>
              </header>
              <div className="sites-modal-body">
                <p className="site-purpose">Restore a previous published snapshot into <strong>{restoreSiteId}</strong>.</p>
                <select
                  value={restoreCommit}
                  onChange={(event) => setRestoreCommit(event.target.value)}
                  disabled={isLoadingRestoreOptions || isRestoringSnapshot || restoreOptions.length === 0}
                >
                  {restoreOptions.map((option) => {
                    const dateLabel = new Date(option.committedAt).toLocaleString()
                    const label = `${option.commit} · ${option.pageCount} pages · ${option.homeHeading} · ${dateLabel}`
                    return (
                      <option key={option.commit} value={option.commit}>
                        {label}
                      </option>
                    )
                  })}
                </select>
                {restoreError ? <p className="site-purpose">{restoreError}</p> : null}
              </div>
              <footer className="sites-modal-footer">
                <button type="button" className="secondary-btn" onClick={() => setRestoreSiteId(null)} disabled={isRestoringSnapshot}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary-btn"
                  onClick={() => void restoreSnapshotForSite()}
                  disabled={isLoadingRestoreOptions || isRestoringSnapshot || !restoreCommit}
                >
                  {isRestoringSnapshot ? "Restoring..." : "Restore"}
                </button>
              </footer>
            </section>
          </div>
        ) : null}
      </main>
    )
  }

  const clampComposerHeight = (value: number) => {
    const minComposer = 124
    const panel = chatPanelRef.current
    const thread = chatThreadRef.current
    if (!panel || !thread) return Math.max(minComposer, value)

    const minThread = 120
    const splitterHeight = 10
    const topRowsHeight = thread.offsetTop
    const maxComposer = Math.max(minComposer, panel.clientHeight - topRowsHeight - splitterHeight - minThread)
    return Math.min(maxComposer, Math.max(minComposer, value))
  }

  const handleComposerAutoHeight = useCallback((height: number) => {
    setComposerHeight((prev) => {
      const next = clampComposerHeight(height)
      return next === prev ? prev : next
    })
  }, [])

  useEffect(() => {
    activeBlockIdRef.current = activeBlockId
  }, [activeBlockId])

  useEffect(() => {
    activeBlockTypeRef.current = activeBlockType
  }, [activeBlockType])

  useEffect(() => {
    activeEditablePathRef.current = activeEditablePath
  }, [activeEditablePath])

  const previewSrc = useMemo(() => {
    const url = new URL(`${siteOrigin}${slug === "/" ? "" : slug}`)
    url.searchParams.set("__editor", "1")
    url.searchParams.set("session", session)
    url.searchParams.set("siteId", siteId)
    url.searchParams.set("siteName", activeSiteConfig.name)
    url.searchParams.set("editorOrigin", editorOrigin)
    return url.toString()
  }, [activeSiteConfig.name, editorOrigin, session, siteId, slug])

  const routeOptions = useMemo(() => {
    const raw = Array.from(new Set([...availableSlugs, slug].filter(Boolean)))
    return raw.includes("/") ? ["/", ...raw.filter((route) => route !== "/")] : raw
  }, [availableSlugs, slug])

  useEffect(() => {
    let active = true

    const checkPlannerStatus = async () => {
      const urls = [`${orchestrator}/status/planner`]
      if (orchestrator.includes("localhost")) {
        urls.push(`${orchestrator.replace("localhost", "127.0.0.1")}/status/planner`)
      }

      try {
        for (const url of urls) {
          const res = await fetch(url)
          if (!res.ok) continue

          const data = (await res.json()) as { plannerSource?: PlannerSource }
          if (!active) return

          if (data.plannerSource === "openai" || data.plannerSource === "demo") {
            setPlannerBadgeState(data.plannerSource)
            return
          }
        }
        if (active) setPlannerBadgeState("error")
      } catch {
        if (active) setPlannerBadgeState("error")
      }
    }

    void checkPlannerStatus()
    const timer = window.setInterval(() => {
      void checkPlannerStatus()
    }, 10000)

    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const thread = chatThreadRef.current
    if (!thread) return
    thread.scrollTo({ top: thread.scrollHeight, behavior: "smooth" })
  }, [chatLog, streamStatus])

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const started = resizeStartRef.current
      if (!started) return

      const deltaY = event.clientY - started.y
      const next = clampComposerHeight(started.composerHeight - deltaY)
      setComposerHeight(next)
    }

    const onPointerUp = () => {
      resizeStartRef.current = null
      document.body.style.userSelect = ""
    }

    window.addEventListener("pointermove", onPointerMove)
    window.addEventListener("pointerup", onPointerUp)
    return () => {
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerup", onPointerUp)
    }
  }, [])

  useEffect(() => {
    const onWindowResize = () => {
      setComposerHeight((prev) => clampComposerHeight(prev))
    }

    window.addEventListener("resize", onWindowResize)
    return () => window.removeEventListener("resize", onWindowResize)
  }, [])

  const postToSite = (
    type: "highlightBlock" | "draftUpdated" | "setNestedLabelsVisibility",
    payload: Record<string, unknown>
  ) => {
    iframeRef.current?.contentWindow?.postMessage(
      {
        protocol: "site-editor/v1",
        type,
        payload
      },
      siteOrigin
    )
  }

  const postPatchToSite = (op: Operation, fromVersion: number, toVersion: number, focusBlockId?: string) => {
    const txId = crypto.randomUUID()
    const msg: ApplyPatchMessage = { type: "applyPatch", txId, op, fromVersion, toVersion, focusBlockId }
    iframeRef.current?.contentWindow?.postMessage({ source: "site-editor/v1", ...msg }, siteOrigin)
    const pageSlug = "pageSlug" in op ? (op.pageSlug ?? "") : ""
    // Timeout fallback: if no ack within 3s, fall back to draftUpdated
    const timer = setTimeout(() => {
      pendingTxBySlug.current.delete(pageSlug)
      postToSite("draftUpdated", { focusBlockId: focusBlockId ?? null })
    }, 3000)
    pendingTxBySlug.current.set(pageSlug, { txId, timer })
    lastConfirmedVersionBySlug.current.set(pageSlug, toVersion)
    return txId
  }

  useEffect(() => {
    postToSite("setNestedLabelsVisibility", { visible: showNestedLabels })
  }, [showNestedLabels])

  useEffect(() => {
    const onMessage = (event: MessageEvent<SiteMessage>) => {
      if (event.origin !== siteOrigin) return
      const msg = event.data
      if (!msg) return

      // Handle patchAck from patch transport (uses source instead of protocol)
      if ("source" in msg && msg.source === "site-editor/v1" && msg.type === "patchAck") {
        const pending = [...pendingTxBySlug.current.entries()].find(([, v]) => v.txId === msg.txId)
        if (pending) {
          clearTimeout(pending[1].timer)
          pendingTxBySlug.current.delete(pending[0])
          if (!msg.accepted) {
            // version mismatch or apply error — fall back to full refresh
            postToSite("draftUpdated", {})
          }
        }
        return
      }

      if (!("protocol" in msg) || msg.protocol !== "site-editor/v1") return

      if (msg.type === "blockClicked") {
        setSlug(String(msg.payload.slug ?? "/"))
        const rawBlockId = msg.payload.blockId
        const rawBlockType = msg.payload.blockType
        const rawPath = msg.payload.editablePath

        const nextBlockId = typeof rawBlockId === "string" && rawBlockId.length > 0 ? rawBlockId : undefined
        const nextBlockType = typeof rawBlockType === "string" && rawBlockType.length > 0 ? rawBlockType : undefined
        const nextPath = typeof rawPath === "string" && rawPath.length > 0 ? rawPath : undefined

        activeBlockIdRef.current = nextBlockId
        activeBlockTypeRef.current = nextBlockType
        activeEditablePathRef.current = nextPath
        setActiveBlockId(nextBlockId)
        setActiveBlockType(nextBlockType)
        setActiveEditablePath(nextPath)
        if (nextBlockId) postToSite("highlightBlock", { blockId: nextBlockId, editablePath: nextPath ?? null })
      }

      if (msg.type === "routeChanged") {
        setSlug(String(msg.payload.slug ?? "/"))
        activeEditablePathRef.current = undefined
        setActiveEditablePath(undefined)
      }

      if (msg.type === "blockReordered") {
        const nextSlug = String(msg.payload.slug ?? slug)
        const blockId = typeof msg.payload.blockId === "string" ? msg.payload.blockId : ""
        const afterRaw = msg.payload.afterBlockId
        const afterBlockId = typeof afterRaw === "string" && afterRaw.length > 0 ? afterRaw : undefined
        if (nextSlug !== slug) setSlug(nextSlug)
        activeEditablePathRef.current = undefined
        setActiveEditablePath(undefined)
        void reorderBlock(nextSlug, blockId, afterBlockId)
      }

      if (msg.type === "blockDeleteRequested") {
        const nextSlug = String(msg.payload.slug ?? slug)
        const blockId = typeof msg.payload.blockId === "string" ? msg.payload.blockId : ""
        if (nextSlug !== slug) setSlug(nextSlug)
        activeEditablePathRef.current = undefined
        setActiveEditablePath(undefined)
        void deleteBlock(nextSlug, blockId)
      }

      if (msg.type === "inlineTextCommitted") {
        const nextSlug = String(msg.payload.slug ?? slug)
        const blockId = typeof msg.payload.blockId === "string" ? msg.payload.blockId : ""
        const editablePath = typeof msg.payload.editablePath === "string" ? msg.payload.editablePath : ""
        const value = typeof msg.payload.value === "string" ? msg.payload.value : ""
        if (nextSlug !== slug) setSlug(nextSlug)
        if (editablePath) {
          activeEditablePathRef.current = editablePath
          setActiveEditablePath(editablePath)
        }
        void inlineEditCommit(nextSlug, blockId, editablePath, value)
      }
    }

    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [slug])

  function normalizeValidationErrors(raw: AssistantResponse["validationErrors"]) {
    if (!raw) return []
    if (Array.isArray(raw)) return raw.map(String)
    const field = Object.values(raw.fieldErrors ?? {}).flat().map(String)
    const form = (raw.formErrors ?? []).map(String)
    return [...form, ...field]
  }

  function pushAssistantFromResult(data: AssistantResponse, options?: { canUndo?: boolean }) {
    const errors = normalizeValidationErrors(data.validationErrors)
    const parsedChanges = splitAiInsightChanges(data.changes)
    const entry: ChatEntry = {
      id: createId(),
      role: "assistant",
      text: data.summary ?? data.error ?? "Request failed.",
      status: data.status,
      canUndo: options?.canUndo ?? false,
      wasUndone: false,
      changes: parsedChanges.changes,
      mentionedSlugs: Array.isArray(data.mentionedSlugs) ? data.mentionedSlugs.filter((s): s is string => typeof s === "string") : [],
      suggestions: data.suggestions ?? [],
      errors,
      meta: data.modelUsed ? `${data.modelUsed}${data.modelKey ? ` (${data.modelKey})` : ""}` : undefined,
      debug: data.debug,
      aiJustification: parsedChanges.aiJustification,
      aiPerformanceNote: parsedChanges.aiPerformanceNote,
      pendingPlanId: typeof data.pendingPlanId === "string" ? data.pendingPlanId : undefined
    }

    setChatLog((prev) => {
      if (!entry.canUndo) return [...prev, entry]
      const withoutUndo = prev.map((row) => (row.canUndo ? { ...row, canUndo: false, wasUndone: false } : row))
      return [...withoutUndo, entry]
    })
  }

  function applyChatResult(data: AssistantResponse) {
    if (data.plannerSource === "openai" || data.plannerSource === "demo") {
      setPlannerBadgeState(data.plannerSource)
    }
    if (data.status === "plan_ready" && typeof data.pendingPlanId === "string" && data.pendingPlanId.length > 0) {
      setPendingPlanId(data.pendingPlanId)
    } else if (data.status === "applied" || data.status === "canceled") {
      setPendingPlanId(null)
      setPendingPlanMessage(null)
    }
    pushAssistantFromResult(data, { canUndo: data.status === "applied" })
    if (data.status === "applied") {
      const nextSlug = typeof data.updatedSlug === "string" && data.updatedSlug.length > 0 ? data.updatedSlug : slug
      if (nextSlug !== slug) {
        setSlug(nextSlug)
        activeBlockIdRef.current = undefined
        activeBlockTypeRef.current = undefined
        activeEditablePathRef.current = undefined
        setActiveBlockId(undefined)
        setActiveBlockType(undefined)
        setActiveEditablePath(undefined)
      }
      postToSite("draftUpdated", { focusBlockId: data.focusBlockId ?? null })
      if (data.focusBlockId) {
        activeBlockIdRef.current = data.focusBlockId
        setActiveBlockId(data.focusBlockId)
      }
      activeEditablePathRef.current = undefined
      setActiveEditablePath(undefined)
      void refreshRouteSlugs()
    }
  }

  async function refreshRouteSlugs() {
    setIsLoadingSlugs(true)
    try {
      const res = await fetch(`${orchestrator}/draft/slugs?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(siteId)}`)
      if (!res.ok) return routeOptions
      const data = (await res.json()) as { slugs?: unknown }
      const list = Array.isArray(data.slugs)
        ? data.slugs.filter((item): item is string => typeof item === "string" && item.length > 0)
        : []
      if (list.length > 0) {
        setAvailableSlugs(list)
        return list
      }
      return routeOptions
    } catch {
      return routeOptions
    } finally {
      setIsLoadingSlugs(false)
    }
  }

  async function reorderBlock(slugForOp: string, blockId: string, afterBlockId?: string) {
    if (!blockId) return
    const op: Record<string, unknown> = { op: "move_block", pageSlug: slugForOp, blockId }
    if (afterBlockId) op.afterBlockId = afterBlockId

    try {
      const res = await fetch(`${orchestrator}/ops`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session, siteId, ops: [op] })
      })
      const data = (await res.json()) as ApplyOpsResponse
      if (!res.ok || data.status !== "applied") {
        pushAssistantFromResult({
          status: "error",
          summary: data.error ?? data.summary ?? "Could not reorder blocks.",
          changes: data.changes ?? []
        })
        return
      }

      const focusBlockId = data.focusBlockId ?? blockId
      activeBlockIdRef.current = focusBlockId
      activeEditablePathRef.current = undefined
      setActiveBlockId(focusBlockId)
      if (enablePatchTransport && typeof data.previewVersion === "number") {
        const toVersion = data.previewVersion
        const fromVersion = toVersion - 1
        const typedOp = { op: "move_block" as const, pageSlug: slugForOp, blockId, ...(afterBlockId ? { afterBlockId } : {}) }
        postPatchToSite(typedOp, fromVersion, toVersion, focusBlockId)
      } else {
        postToSite("draftUpdated", { focusBlockId })
      }
    } catch {
      pushAssistantFromResult({
        status: "error",
        summary: "Could not reorder blocks.",
        changes: []
      })
    }
  }

  async function deleteBlock(slugForOp: string, blockId: string) {
    if (!blockId) return
    const op = { op: "remove_block", pageSlug: slugForOp, blockId }

    try {
      const res = await fetch(`${orchestrator}/ops`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session, siteId, ops: [op] })
      })
      const data = (await res.json()) as ApplyOpsResponse
      if (!res.ok || data.status !== "applied") {
        pushAssistantFromResult({
          status: "error",
          summary: data.error ?? data.summary ?? "Could not delete block.",
          changes: data.changes ?? []
        })
        return
      }

      activeBlockIdRef.current = undefined
      activeBlockTypeRef.current = undefined
      activeEditablePathRef.current = undefined
      setActiveBlockId(undefined)
      setActiveBlockType(undefined)
      setActiveEditablePath(undefined)
      if (enablePatchTransport && typeof data.previewVersion === "number") {
        const toVersion = data.previewVersion
        const fromVersion = toVersion - 1
        const typedOp = { op: "remove_block" as const, pageSlug: slugForOp, blockId }
        postPatchToSite(typedOp, fromVersion, toVersion)
      } else {
        postToSite("draftUpdated", { focusBlockId: null })
      }
    } catch {
      pushAssistantFromResult({
        status: "error",
        summary: "Could not delete block.",
        changes: []
      })
    }
  }

  async function inlineEditCommit(slugForOp: string, blockId: string, editablePath: string, value: string) {
    if (!blockId || !editablePath) return

    const indexedPath = /^([A-Za-z_][A-Za-z0-9_]*)\[([0-9]+)\]\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(editablePath)
    let op: Record<string, unknown> | null = null

    if (indexedPath) {
      const listKey = indexedPath[1]
      const index = Number(indexedPath[2])
      const fieldKey = indexedPath[3]
      op = {
        op: "update_item",
        pageSlug: slugForOp,
        blockId,
        listKey,
        index,
        patch: { [fieldKey]: value }
      }
    } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(editablePath)) {
      op = {
        op: "update_props",
        pageSlug: slugForOp,
        blockId,
        patch: { [editablePath]: value }
      }
    }

    if (!op) {
      pushAssistantFromResult({
        status: "error",
        summary: `Inline edit is not supported for "${editablePath}".`,
        changes: []
      })
      return
    }

    try {
      const res = await fetch(`${orchestrator}/ops`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session, siteId, ops: [op] })
      })
      const data = (await res.json()) as ApplyOpsResponse
      if (!res.ok || data.status !== "applied") {
        pushAssistantFromResult({
          status: "error",
          summary: data.error ?? data.summary ?? "Could not apply inline edit.",
          changes: data.changes ?? []
        })
        return
      }

      const focusBlockId = data.focusBlockId ?? blockId
      activeBlockIdRef.current = focusBlockId
      activeEditablePathRef.current = editablePath
      setActiveBlockId(focusBlockId)
      setActiveEditablePath(editablePath)
      if (enablePatchTransport && typeof data.previewVersion === "number") {
        const toVersion = data.previewVersion
        const fromVersion = toVersion - 1
        if (indexedPath) {
          const listKey = indexedPath[1]
          const index = Number(indexedPath[2])
          const fieldKey = indexedPath[3]
          const typedOp = { op: "update_item" as const, pageSlug: slugForOp, blockId, listKey: listKey!, index, patch: { [fieldKey!]: value } }
          postPatchToSite(typedOp, fromVersion, toVersion, focusBlockId)
        } else {
          const typedOp = { op: "update_props" as const, pageSlug: slugForOp, blockId, patch: { [editablePath]: value } }
          postPatchToSite(typedOp, fromVersion, toVersion, focusBlockId)
        }
      } else {
        postToSite("draftUpdated", { focusBlockId })
      }
    } catch {
      pushAssistantFromResult({
        status: "error",
        summary: "Could not apply inline edit.",
        changes: []
      })
    }
  }

  async function submitChatHttp(finalMessage: string, options?: { executionMode?: ChatExecutionMode; pendingPlanId?: string }) {
    const res = await fetch(`${orchestrator}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session,
        siteId,
        sitePurpose: activeSiteConfig.purpose || undefined,
        siteHosting: activeSiteConfig.hosting || undefined,
        slug,
        message: finalMessage,
        modelKey,
        activeBlockId: activeBlockIdRef.current,
        activeBlockType: activeBlockTypeRef.current,
        activeEditablePath: activeEditablePathRef.current,
        executionMode: options?.executionMode ?? "auto",
        pendingPlanId: options?.pendingPlanId
      })
    })

    const data = (await res.json()) as AssistantResponse
    applyChatResult(data)
  }

  async function submitVariations(finalMessage: string) {
    const selectedBlockId = activeBlockIdRef.current
    const selectedBlockType = activeBlockTypeRef.current
    if (!selectedBlockId || !selectedBlockType) {
      pushAssistantFromResult({
        status: "needs_clarification",
        summary: "Select a block first, then ask to generate variations.",
        changes: []
      })
      return
    }

    const res = await fetch(`${orchestrator}/chat/variations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session,
        siteId,
        sitePurpose: activeSiteConfig.purpose || undefined,
        siteHosting: activeSiteConfig.hosting || undefined,
        slug,
        message: finalMessage,
        modelKey,
        activeBlockId: selectedBlockId,
        activeBlockType: selectedBlockType,
        activeEditablePath: activeEditablePathRef.current
      })
    })

    const data = (await res.json()) as VariationResponse
    if (!res.ok || data.status !== "ok" || !Array.isArray(data.variations) || data.variations.length === 0) {
      pushAssistantFromResult({
        status: "error",
        summary: data.error ?? data.summary ?? "Could not generate variations.",
        changes: []
      })
      return
    }

    setVariationModal({
      requestText: finalMessage,
      blockId: data.blockId ?? selectedBlockId,
      blockType: data.blockType ?? selectedBlockType,
      pageSlug: data.pageSlug ?? slug,
      baseProps: (data.baseProps && typeof data.baseProps === "object" ? data.baseProps : {}) as Record<string, unknown>,
      options: data.variations
    })
    pushAssistantFromResult({
      status: "info",
      summary: data.summary ?? `Generated ${data.variations.length} variations. Choose one from the modal.`,
      changes: [`Block: ${data.blockType ?? selectedBlockType}`, `Options: ${data.variations.length}`]
    })
  }

  async function applyVariation(option: VariationOption) {
    if (!variationModal || isApplyingVariation) return
    setIsApplyingVariation(true)
    try {
      const res = await fetch(`${orchestrator}/ops`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session,
          siteId,
          ops: [
            {
              op: "update_props",
              pageSlug: variationModal.pageSlug,
              blockId: variationModal.blockId,
              patch: option.patch
            }
          ]
        })
      })
      const data = (await res.json()) as ApplyOpsResponse
      if (!res.ok || data.status !== "applied") {
        pushAssistantFromResult({
          status: "error",
          summary: data.error ?? data.summary ?? "Could not apply variation.",
          changes: data.changes ?? []
        })
        return
      }

      const focusBlockId = data.focusBlockId ?? variationModal.blockId
      activeBlockIdRef.current = focusBlockId
      activeEditablePathRef.current = undefined
      setActiveBlockId(focusBlockId)
      setActiveEditablePath(undefined)
      if (enablePatchTransport && typeof data.previewVersion === "number") {
        const toVersion = data.previewVersion
        const fromVersion = toVersion - 1
        const typedOp = { op: "update_props" as const, pageSlug: variationModal.pageSlug, blockId: variationModal.blockId, patch: option.patch }
        postPatchToSite(typedOp, fromVersion, toVersion, focusBlockId)
      } else {
        postToSite("draftUpdated", { focusBlockId })
      }
      setVariationModal(null)
      pushAssistantFromResult(
        {
          status: "applied",
          summary: `Applied variation: ${option.title}`,
          changes: [option.summary]
        },
        { canUndo: true }
      )
    } catch {
      pushAssistantFromResult({
        status: "error",
        summary: "Could not apply variation.",
        changes: []
      })
    } finally {
      setIsApplyingVariation(false)
    }
  }

  async function submitChatStream(finalMessage: string) {
    return await new Promise<boolean>((resolve) => {
      const params = new URLSearchParams({
        session,
        siteId,
        sitePurpose: activeSiteConfig.purpose || "",
        siteHosting: activeSiteConfig.hosting || "",
        slug,
        message: finalMessage,
        modelKey
      })
      if (activeBlockIdRef.current) params.set("activeBlockId", activeBlockIdRef.current)
      if (activeBlockTypeRef.current) params.set("activeBlockType", activeBlockTypeRef.current)
      if (activeEditablePathRef.current) params.set("activeEditablePath", activeEditablePathRef.current)

      const source = new EventSource(`${orchestrator}/chat/stream?${params.toString()}`)
      let settled = false
      let gotAnyEvent = false
      let pendingFocusBlockId: string | null = null
      let opRefreshTimer: number | null = null

      const flushOpRefresh = () => {
        postToSite("draftUpdated", { focusBlockId: pendingFocusBlockId })
        if (pendingFocusBlockId) {
          activeBlockIdRef.current = pendingFocusBlockId
          setActiveBlockId(pendingFocusBlockId)
        }
        activeEditablePathRef.current = undefined
        setActiveEditablePath(undefined)
        pendingFocusBlockId = null
      }

      const clearOpRefreshTimer = () => {
        if (opRefreshTimer === null) return
        window.clearTimeout(opRefreshTimer)
        opRefreshTimer = null
      }

      const scheduleOpRefresh = () => {
        clearOpRefreshTimer()
        opRefreshTimer = window.setTimeout(() => {
          opRefreshTimer = null
          flushOpRefresh()
        }, 100)
      }

      source.onmessage = (event) => {
        let payload: {
          type: "status" | "token" | "op_applied" | "final" | "error"
          message?: string
          text?: string
          index?: number
          total?: number
          op?: Operation
          previewVersion?: number
          focusBlockId?: string | null
          result?: AssistantResponse
        }
        try {
          payload = JSON.parse(event.data) as typeof payload
        } catch {
          return
        }
        gotAnyEvent = true

        if (payload.type === "status") {
          setStreamStatus(payload.message ?? "Working...")
        }

        if (payload.type === "token") {
          const text = payload.text ?? ""
          if (text) {
            setStreamTokenCount((prev) => prev + text.length)
          }
        }

        if (payload.type === "op_applied") {
          const total = Number(payload.total ?? 0)
          const index = Number(payload.index ?? 0)
          if (total > 0 && index > 0) {
            setStreamStatus(`Applying changes (${index}/${total})...`)
          } else {
            setStreamStatus("Applying changes...")
          }
          pendingFocusBlockId = typeof payload.focusBlockId === "string" ? payload.focusBlockId : null
          if (enablePatchTransport && payload.op && typeof payload.previewVersion === "number") {
            const toVersion = payload.previewVersion
            const fromVersion = toVersion - 1
            postPatchToSite(payload.op, fromVersion, toVersion, pendingFocusBlockId ?? undefined)
          } else if (total > 0 && index >= total) {
            clearOpRefreshTimer()
            flushOpRefresh()
          } else {
            scheduleOpRefresh()
          }
        }

        if (payload.type === "final") {
          settled = true
          setStreamStatus(null)
          setStreamTokenCount(0)
          clearOpRefreshTimer()
          if (pendingFocusBlockId !== null) flushOpRefresh()
          if (payload.result) applyChatResult(payload.result)
          source.close()
          resolve(true)
        }

        if (payload.type === "error") {
          settled = true
          setStreamStatus(null)
          setStreamTokenCount(0)
          clearOpRefreshTimer()
          pendingFocusBlockId = null
          if (payload.result) {
            applyChatResult(payload.result)
          } else {
            pushAssistantFromResult({ status: "error", summary: "Streaming request failed.", changes: [] })
          }
          source.close()
          resolve(true)
        }
      }

      source.onerror = () => {
        if (settled || gotAnyEvent) {
          clearOpRefreshTimer()
          pendingFocusBlockId = null
          source.close()
          resolve(true)
          return
        }
        setStreamStatus("Streaming failed, retrying with standard request...")
        setStreamTokenCount(0)
        clearOpRefreshTimer()
        pendingFocusBlockId = null
        settled = true
        source.close()
        resolve(false)
      }
    })
  }

  async function submitChat(explicitMessage?: string) {
    const finalMessage = (explicitMessage ?? message).trim()
    if (!finalMessage || isLoading) return

    setChatLog((prev) => [...prev, { id: createId(), role: "user", text: finalMessage }])
    setMessage("")
    setIsLoading(true)
    setStreamStatus(useStreaming ? "Connecting..." : null)
    setStreamTokenCount(0)
    try {
      if (isVariationRequest(finalMessage)) {
        await submitVariations(finalMessage)
        return
      }
      const requiresPlanApproval = isComplexTaskRequest(finalMessage)
      if (requiresPlanApproval) {
        setPendingPlanMessage(finalMessage)
        await submitChatHttp(finalMessage, { executionMode: "plan_only" })
        return
      }
      if (useStreaming) {
        const ok = await submitChatStream(finalMessage)
        if (!ok) await submitChatHttp(finalMessage)
      } else {
        await submitChatHttp(finalMessage)
      }
    } finally {
      setStreamStatus(null)
      setIsLoading(false)
    }
  }

  async function approvePendingPlan(planId: string) {
    if (!planId || isLoading) return
    const originalMessage = pendingPlanMessage?.trim() || "Approve and execute the pending plan."
    setChatLog((prev) => [...prev, { id: createId(), role: "user", text: "Approve plan and execute." }])
    setIsLoading(true)
    try {
      await submitChatHttp(originalMessage, {
        executionMode: "apply_pending_plan",
        pendingPlanId: planId
      })
    } finally {
      setIsLoading(false)
    }
  }

  async function stopPendingPlan(planId: string) {
    if (!planId || isLoading) return
    setChatLog((prev) => [...prev, { id: createId(), role: "user", text: "Stop and discard this plan." }])
    setIsLoading(true)
    try {
      await submitChatHttp("Stop pending plan.", {
        executionMode: "discard_pending_plan",
        pendingPlanId: planId
      })
    } finally {
      setIsLoading(false)
    }
  }

  async function transcribeAudio(blob: Blob, mimeType: string) {
    const fileExt = extensionFromMimeType(mimeType)
    const file = new File([blob], `recording.${fileExt}`, {
      type: mimeType || blob.type || "audio/webm"
    })
    const form = new FormData()
    form.append("audio", file)

    const res = await fetch(`${orchestrator}/audio/transcribe`, {
      method: "POST",
      body: form
    })

    const data = (await res.json()) as { text?: string; error?: string; detail?: string }
    if (!res.ok) throw new Error(data.error ?? data.detail ?? "Transcription failed.")
    const text = (data.text ?? "").trim()
    if (!text) throw new Error("No speech detected. Try speaking more clearly or recording longer.")
    return text
  }

  async function interpretPastedImage(blob: Blob, mimeType: string) {
    const ext = extensionFromMimeType(mimeType)
    const file = new File([blob], `pasted-image.${ext}`, {
      type: mimeType || blob.type || "image/png"
    })
    const form = new FormData()
    form.append("image", file)

    const res = await fetch(`${orchestrator}/image/interpret`, {
      method: "POST",
      body: form
    })

    const data = (await res.json()) as { text?: string; error?: string; detail?: string }
    if (!res.ok) throw new Error(data.error ?? data.detail ?? "Image analysis failed.")
    const text = (data.text ?? "").trim()
    if (!text) throw new Error("Image analysis returned empty text.")
    return text
  }

  async function applyUndoHistory(entryId: string) {
    if (isLoading || undoInFlightEntryId) return
    setUndoInFlightEntryId(entryId)
    try {
      const res = await fetch(`${orchestrator}/history/undo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session, siteId, slug })
      })
      const data = (await res.json()) as HistoryResponse
      if (!res.ok || data.status !== "applied") {
        pushAssistantFromResult({
          status: "error",
          summary: data.error ?? "Could not undo.",
          changes: []
        })
        return
      }

      activeEditablePathRef.current = undefined
      setActiveEditablePath(undefined)
      postToSite("draftUpdated", { focusBlockId: null })
      setChatLog((prev) => {
        const targetIndex = prev.findIndex((entry) => entry.id === entryId)
        if (targetIndex < 0) return prev

        const next = prev.map((entry, index) => (index === targetIndex ? { ...entry, canUndo: false, wasUndone: true } : entry))
        let promoteIndex = -1
        for (let index = targetIndex - 1; index >= 0; index -= 1) {
          const entry = next[index]
          if (entry.role === "assistant" && entry.status === "applied") {
            promoteIndex = index
            break
          }
        }
        if (promoteIndex >= 0) next[promoteIndex] = { ...next[promoteIndex], canUndo: true, wasUndone: false }
        return next
      })
    } catch {
      pushAssistantFromResult({
        status: "error",
        summary: "Could not undo.",
        changes: []
      })
    } finally {
      setUndoInFlightEntryId(null)
    }
  }

  async function publishSite() {
    if (isLoading || isPublishing) return
    setIsPublishing(true)
    try {
      const res = await fetch(`${orchestrator}/publish`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(publishToken ? { "x-publish-token": publishToken } : {})
        },
        body: JSON.stringify({ session, siteId })
      })
      const data = (await res.json()) as PublishResponse
      if (!res.ok || (data.status !== "triggered" && data.status !== "ready")) {
        pushAssistantFromResult({
          status: "error",
          summary: data.error ?? "Failed to trigger publish.",
          changes: []
        })
        return
      }

      const slugText = Array.isArray(data.slugs) && data.slugs.length > 0 ? data.slugs.join(", ") : "none"
      setPublishStatus({
        session: data.session ?? session,
        status: data.status,
        slugs: data.slugs ?? [],
        deployStatus: data.deployStatus,
        inspectUrl: data.inspectUrl,
        deploymentId: data.deploymentId,
        vercelState: data.vercelState
      })
      void fetchPublishStatus()
      if (data.status === "ready") {
        pushAssistantFromResult({
          status: "applied",
          summary: data.message ?? "Nothing new to publish.",
          changes: [
            `Session: ${data.session ?? session}`,
            `Slugs: ${slugText}`,
            ...(data.branch ? [`Branch: ${data.branch}`] : [])
          ]
        })
      } else {
        pushAssistantFromResult({
          status: "applied",
          summary: "Publish triggered. Vercel deployment started.",
          changes: [
            `Session: ${data.session ?? session}`,
            `Slugs: ${slugText}`,
            `Deploy status: ${data.deployStatus ?? "unknown"}`,
            `Vercel state: ${data.vercelState ?? "TRIGGERED"}`,
            ...(data.commitSha ? [`Commit: ${data.commitSha.slice(0, 12)}`] : []),
            ...(data.branch ? [`Branch: ${data.branch}`] : []),
            ...(data.message ? [data.message] : [])
          ]
        })
      }
    } catch {
      pushAssistantFromResult({
        status: "error",
        summary: "Failed to trigger publish.",
        changes: []
      })
    } finally {
      setIsPublishing(false)
    }
  }

  async function fetchPublishStatus() {
    try {
      const res = await fetch(`${orchestrator}/publish/status?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(siteId)}`)
      if (!res.ok) return
      const data = (await res.json()) as PublishStatus
      setPublishStatus(data)
    } catch {
      // Ignore status poll failures.
    }
  }

  useEffect(() => {
    if (!activeBlockId) return
    postToSite("highlightBlock", { blockId: activeBlockId, editablePath: activeEditablePath ?? null })
  }, [activeBlockId, activeEditablePath])

  useEffect(() => {
    void refreshRouteSlugs()
  }, [session, siteId])

  useEffect(() => {
    if (!showSettingsModal) return
    const updatePopoverPosition = () => {
      const button = settingsButtonRef.current
      if (!button) return
      const rect = button.getBoundingClientRect()
      const popoverWidth = 320
      const popoverHeight = 220
      const gap = 8
      const minEdge = 8
      const maxLeft = Math.max(minEdge, window.innerWidth - popoverWidth - minEdge)
      const maxTop = Math.max(minEdge, window.innerHeight - popoverHeight - minEdge)
      const left = Math.min(maxLeft, Math.max(minEdge, rect.right - popoverWidth))
      const top = Math.min(maxTop, Math.max(minEdge, rect.bottom + gap))
      setSettingsPopoverPos({ top, left })
    }

    updatePopoverPosition()
    window.addEventListener("resize", updatePopoverPosition)
    window.addEventListener("scroll", updatePopoverPosition, true)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowSettingsModal(false)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("resize", updatePopoverPosition)
      window.removeEventListener("scroll", updatePopoverPosition, true)
    }
  }, [showSettingsModal])

  useEffect(() => {
    if (!variationModal) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isApplyingVariation) setVariationModal(null)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [variationModal, isApplyingVariation])

  const publishState = (publishStatus?.vercelState ?? publishStatus?.status ?? "").toUpperCase()
  const publishInProgress =
    isPublishing || publishState === "PENDING" || publishState === "QUEUED" || publishState === "BUILDING" || publishState === "INITIALIZING"
  const publishTerminal =
    publishState === "READY" || publishState === "ERROR" || publishState === "FAILED" || publishState === "CANCELED" || publishState === "SUCCEEDED"

  useEffect(() => {
    if (!publishStatus || publishTerminal) return
    const timer = window.setInterval(() => {
      void fetchPublishStatus()
    }, 5000)
    return () => window.clearInterval(timer)
  }, [publishStatus, publishTerminal, session, siteId])

  const streamIsError = streamStatus ? /failed|error/i.test(streamStatus) : false
  const streamLabel = streamIsError ? streamStatus : streamTokenCount > 0 ? "Shaping your update..." : "Getting things ready..."
  const chatPanelStyle = { "--composer-height": `${composerHeight}px` } as CSSProperties
  const hasUserEntry = chatLog.some((entry) => entry.role === "user")
  return (
    <div className="layout">
      <aside className="chat-panel" ref={chatPanelRef} style={chatPanelStyle}>
        <header className="chat-header">
          <div className="chat-header-top">
            {/*
            <div
              className={`source-badge source-badge-compact ${
                plannerBadgeState === "openai"
                  ? "src-openai"
                  : plannerBadgeState === "demo"
                    ? "src-demo"
                    : plannerBadgeState === "error"
                      ? "src-error"
                      : "src-unknown"
              }`}
            >
              {plannerBadgeState === "openai"
                ? "OpenAI"
                : plannerBadgeState === "demo"
                  ? "Demo mode"
                  : plannerBadgeState === "error"
                    ? "Status unavailable"
                    : "Checking..."}
            </div>
            */}
          </div>
          <div className="chat-header-controls">
            <label className="chat-header-slug">
              <select value={slug} onChange={(e) => setSlug(e.target.value || "/")} disabled={isLoadingSlugs}>
                {routeOptions.map((route) => (
                  <option key={route} value={route}>
                    {slugLabel(route)}
                  </option>
                ))}
              </select>
            </label>
            <div className="chat-header-primary-actions">
              <a className="secondary-btn" href="/sites">
                Sites
              </a>
              <button
                type="button"
                className="settings-icon-btn"
                aria-label="Open settings"
                onClick={() => setShowSettingsModal(true)}
                ref={settingsButtonRef}
              >
                <Settings2Icon size={16} color="currentColor" />
              </button>
              <button type="button" className="publish-preview-btn" onClick={() => void publishSite()} disabled={isLoading || isPublishing}>
                {publishInProgress ? <span className="publish-spinner" aria-hidden="true" /> : null}
                {publishInProgress ? "Publishing" : "Publish"}
              </button>
            </div>
            {publishStatus?.inspectUrl ? (
              <a className="publish-view-link" href={publishStatus.inspectUrl} target="_blank" rel="noreferrer">
                View deploy
              </a>
            ) : null}
          </div>
        </header>

        <section className="chat-thread" ref={chatThreadRef}>
          {chatLog.map((entry) => (
            <article
              key={entry.id}
              className={`msg msg-${entry.role} ${entry.status === "needs_clarification" ? "msg-clarification" : ""} ${entry.canUndo ? "msg-has-undo" : ""}`}
            >
              <div className="msg-main">{entry.text}</div>
              {entry.aiJustification ? (
                <div className="msg-ai-insight">
                  <div className="msg-ai-insight-label">AI justification</div>
                  <blockquote>{entry.aiJustification}</blockquote>
                </div>
              ) : null}
              {entry.aiPerformanceNote ? (
                <div className="msg-ai-insight">
                  <div className="msg-ai-insight-label">Performance awareness</div>
                  <blockquote>{entry.aiPerformanceNote}</blockquote>
                </div>
              ) : null}
              {entry.status && !entry.canUndo ? <div className="msg-status">{entry.status === "needs_clarification" ? "question" : entry.status}</div> : null}
              {(entry.changes ?? []).filter((line) => !isRedundantChangeLine(entry.text, line)).length > 0 ? (
                <ul className="msg-list">
                  {(entry.changes ?? [])
                    .filter((line) => !isRedundantChangeLine(entry.text, line))
                    .map((line, idx) => (
                    <li key={idx}>{line}</li>
                  ))}
                </ul>
              ) : null}
              {(entry.suggestions ?? []).length > 0 ? (
                <div className="msg-suggestions">
                  {entry.suggestions?.map((line, idx) => (
                    <button
                      key={`${entry.id}-${idx}`}
                      type="button"
                      className="msg-suggestion"
                      onClick={() => void submitChat(line)}
                      disabled={isLoading}
                    >
                      {line}
                    </button>
                  ))}
                </div>
              ) : null}
              {entry.status === "plan_ready" && entry.pendingPlanId ? (
                <div className="msg-plan-actions">
                  {(() => {
                    const currentPlanId = entry.pendingPlanId
                    const disabled = isLoading || pendingPlanId !== currentPlanId
                    return (
                      <>
                  <button
                    type="button"
                    className="primary-btn msg-plan-btn"
                    onClick={() => void approvePendingPlan(currentPlanId)}
                    disabled={disabled}
                  >
                    Approve plan
                  </button>
                  <button
                    type="button"
                    className="secondary-btn msg-plan-btn"
                    onClick={() => void stopPendingPlan(currentPlanId)}
                    disabled={disabled}
                  >
                    Stop
                  </button>
                      </>
                    )
                  })()}
                </div>
              ) : null}
              {(() => {
                const routes = (entry.mentionedSlugs ?? []).filter((route) => route !== slug)
                if (routes.length === 0) return null
                return (
                  <div className="msg-suggestions msg-page-links">
                    {routes.map((route, idx) => (
                      <button
                        key={`${entry.id}-route-${idx}`}
                        type="button"
                        className="msg-suggestion msg-page-link"
                        onClick={() => {
                          setSlug(route)
                        }}
                        disabled={isLoading}
                      >
                        Open {route}
                      </button>
                    ))}
                  </div>
                )
              })()}
              {(entry.errors ?? []).length > 0 ? (
                <ul className="msg-errors">
                  {entry.errors?.map((line, idx) => (
                    <li key={idx}>{line}</li>
                  ))}
                </ul>
              ) : null}
              {showDebugDetails && entry.role === "assistant" && entry.debug ? (
                <div className="msg-debug">
                  <div className="msg-debug-title">Debug</div>
                  <ul>
                    {entry.debug.traceId ? <li>traceId: {entry.debug.traceId}</li> : null}
                    {entry.debug.promptHash ? <li>promptHash: {entry.debug.promptHash}</li> : null}
                    {entry.debug.outcome ? <li>outcome: {entry.debug.outcome}</li> : null}
                    {entry.debug.reasonCategory ? <li>reason: {entry.debug.reasonCategory}</li> : null}
                    {entry.debug.intent ? <li>intent: {entry.debug.intent}</li> : null}
                    {typeof entry.debug.opCount === "number" ? <li>opCount: {entry.debug.opCount}</li> : null}
                    {Array.isArray(entry.debug.opTypes) && entry.debug.opTypes.length > 0 ? <li>ops: {entry.debug.opTypes.join(", ")}</li> : null}
                    {entry.debug.promptExcerpt ? <li>prompt: {entry.debug.promptExcerpt}</li> : null}
                  </ul>
                </div>
              ) : null}
              {entry.canUndo || entry.wasUndone ? (
                <div className="msg-undo-row">
                  <button
                    type="button"
                    className="msg-undo-btn"
                    onClick={() => void applyUndoHistory(entry.id)}
                    disabled={!entry.canUndo || isLoading || undoInFlightEntryId !== null}
                  >
                    <span>{entry.wasUndone ? "Undone" : "Undo"}</span>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M9 7 4 12l5 5" />
                      <path d="M5 12h7a4.5 4.5 0 0 1 0 9H10" />
                    </svg>
                  </button>
                </div>
              ) : null}
            </article>
          ))}
          {streamStatus ? (
            <div className={`streaming-pill ${streamIsError ? "is-error" : "is-active"}`}>
              <span className="streaming-pill-title">
                <span className="streaming-pill-sparkle">✦</span>
              </span>
              <span className="streaming-pill-status">{streamLabel}</span>
              {!streamIsError ? (
                <span className="streaming-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              ) : null}
            </div>
          ) : null}
          <div ref={chatEndRef} />
        </section>

        <div
          ref={splitHandleRef}
          className="composer-splitter"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize input panel"
          onPointerDown={(event) => {
            resizeStartRef.current = { y: event.clientY, composerHeight }
            document.body.style.userSelect = "none"
          }}
        />

        <footer className="composer">
          <ClaudeStyleChatInput
            message={message}
            isLoading={isLoading}
            modelKey={modelKey}
            hasUserEntry={hasUserEntry}
            onMessageChange={setMessage}
            onModelChange={setModelKey}
            onSubmit={(explicitMessage) => void submitChat(explicitMessage)}
            onTranscribeAudio={transcribeAudio}
            onInterpretImage={interpretPastedImage}
            onAutoHeightChange={handleComposerAutoHeight}
          />
        </footer>
      </aside>

      <section className="preview">
        <iframe
          ref={iframeRef}
          title="Live preview"
          src={previewSrc}
          onLoad={() => postToSite("setNestedLabelsVisibility", { visible: showNestedLabels })}
        />
      </section>

      {variationModal ? (
        <div
          className="variation-modal-backdrop"
          onClick={() => {
            if (!isApplyingVariation) setVariationModal(null)
          }}
        >
          <div className="variation-modal" role="dialog" aria-modal="true" aria-label="Choose a variation" onClick={(e) => e.stopPropagation()}>
            <div className="variation-modal-header">
              <h2>Choose a Variation</h2>
              <p>{variationModal.blockType} · {variationModal.blockId}</p>
              <div className="variation-preview-presets" role="group" aria-label="Preview width">
                {(["desktop", "tablet", "mobile"] as PreviewWidthPreset[]).map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className={`variation-preview-preset-btn${variationPreviewPreset === preset ? " is-active" : ""}`}
                    onClick={() => setVariationPreviewPreset(preset)}
                    disabled={isApplyingVariation}
                  >
                    {preset}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="settings-close-btn"
                aria-label="Close variation picker"
                onClick={() => setVariationModal(null)}
                disabled={isApplyingVariation}
              >
                ×
              </button>
            </div>
            <div className="variation-modal-body">
              {variationModal.options.map((option) => (
                <article key={option.id} className="variation-card">
                  <header className="variation-card-header">
                    <h3>{option.title}</h3>
                    <span>{option.changedKeys.join(", ") || "patch"}</span>
                  </header>
                  <p>{option.summary}</p>
                  <VariationScaledPreview
                    virtualWidth={previewPresetWidths[variationPreviewPreset]}
                    block={{
                      id: variationModal.blockId,
                      type: variationModal.blockType as BlockInstance["type"],
                      props: mergedVariationProps(variationModal.baseProps, option.patch)
                    }}
                  />
                  <button type="button" className="publish-preview-btn variation-apply-btn" onClick={() => void applyVariation(option)} disabled={isApplyingVariation}>
                    {isApplyingVariation ? "Applying..." : "Apply this variation"}
                  </button>
                </article>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {showSettingsModal ? (
        <div className="settings-popover-backdrop" onClick={() => setShowSettingsModal(false)}>
          <div
            className="settings-modal settings-modal-popover"
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            onClick={(e) => e.stopPropagation()}
            style={settingsPopoverPos ? { top: settingsPopoverPos.top, left: settingsPopoverPos.left } : undefined}
          >
            <div className="settings-modal-header">
              <h2>Settings</h2>
              <button type="button" className="settings-close-btn" aria-label="Close settings" onClick={() => setShowSettingsModal(false)}>
                ×
              </button>
            </div>
            <div className="settings-modal-body">
              <label className="inline-toggle">
                <input type="checkbox" checked={useStreaming} onChange={(e) => setUseStreaming(e.target.checked)} />
                <span>Streaming</span>
              </label>

              <label className="inline-toggle">
                <input type="checkbox" checked={showNestedLabels} onChange={(e) => setShowNestedLabels(e.target.checked)} />
                <span>Nested labels</span>
              </label>
              <label className="inline-toggle">
                <input type="checkbox" checked={showDebugDetails} onChange={(e) => setShowDebugDetails(e.target.checked)} />
                <span>Debug mode</span>
              </label>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
