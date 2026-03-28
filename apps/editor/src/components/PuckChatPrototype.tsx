import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Puck, blocksPlugin, createUsePuck, fieldsPlugin, outlinePlugin, useGetPuck, type Data } from "@puckeditor/core"
import "@puckeditor/core/puck.css"
import "@ai-site-editor/blocks/styles.css"
import { SharedBlockRenderer, hasRenderer } from "@ai-site-editor/blocks"
import { BotMessageSquare } from "lucide-react"
import {
  deriveFieldMetaFromSchema,
  getAllBlockMeta,
  type BlockDefinition,
  type BlockManifest,
  type BlockMeta,
  type FieldMeta,
  type PageDoc,
} from "@ai-site-editor/shared"
import { LEGACY_AVOCADO_SITE_ID, LEGACY_AVOCADO_SITE_NAME, loadSiteListFromStorage, orchestrator, resolveDefaultModelKey, resolveDefaultProvider, resolveEditorSiteId, sanitizeSiteId, siteNameFromId, siteOrigin, slugLabel } from "../lib/editor-utils"
import { ImagePickerModal } from "./ImagePickerModal"
import { useChatEngine } from "../hooks/useChatEngine"
import { useMediaInput } from "../hooks/useMediaInput"
import { ChatComposerCore } from "./ChatSurface"
import { renderFinalMarkdown, renderSimpleMarkdown } from "../lib/markdown-renderer"
import type { AIProvider, ChatEntry, ModelKey } from "../lib/editor-types"

type ChatPanelProps = {
  session: string
  siteId: string
  isBusy: boolean
  error: string | null
  chatEntries: ChatEntry[]
  streamStatus: string | null
  streamingText: string | null
  streamSteps: { label: string; done: boolean }[]
  streamingChanges: string[]
  undoInFlightEntryId: string | null
  onSendPrompt: (prompt: string) => Promise<void>
  onCancelPrompt: () => void
  onClickSuggestion: (prompt: string) => Promise<void>
  onUndo: (entryId: string) => Promise<void>
  onSelectionChange: (selection?: SelectionContext) => void
}

const PuckChatContext = createContext<ChatPanelProps | null>(null)

type PuckData = Data<Record<string, Record<string, unknown>>>
type SelectionContext = {
  activeBlockId?: string
  activeBlockType?: string
  activeEditablePath?: string
}
type PuckSelectionItem = {
  type?: unknown
  props?: Record<string, unknown>
}
type PuckSelectionStore = {
  selectedItem?: PuckSelectionItem | null
  appState: {
    ui: {
      itemSelector: { index: number; zone?: string } | null
      field: { focus?: string | null }
    }
    data: {
      content: PuckSelectionItem[]
      zones?: Record<string, PuckSelectionItem[] | undefined>
    }
  }
}
type PlannerFeatures = {
  googleDrive?: boolean
  unsplash?: boolean
  imageGenerate?: boolean
  imageGenerateChat?: boolean
}
type ImagePickerTarget = {
  currentUrl?: string
  onSelect: (imageUrl: string) => void
}
type PuckCustomFieldRenderProps = {
  value: unknown
  onChange: (value: string) => void
  readOnly?: boolean
}

const FALLBACK_SESSION = "dev"
const FALLBACK_SLUG = "/"
const usePuckSelector = createUsePuck()
const PUCK_PREVIEW_SCROLL_FIX_CSS = `
html, body {
  overflow-y: auto !important;
  overflow-x: hidden !important;
  height: auto !important;
  min-height: 100% !important;
}
#frame-root,
[data-puck-entry],
body > div:first-child {
  height: auto !important;
  min-height: 100% !important;
  overflow: visible !important;
}
`

function PuckPreviewIframeOverride({
  document: _frameDocument,
  children,
}: {
  document?: Document
  children?: ReactNode
}) {
  return (
    <>
      <style>{PUCK_PREVIEW_SCROLL_FIX_CSS}</style>
      {children}
    </>
  )
}

function resolvePuckSiteId(): string {
  if (typeof window === "undefined") return LEGACY_AVOCADO_SITE_ID
  const fromQuery = sanitizeSiteId(new URLSearchParams(window.location.search).get("siteId") ?? "")
  if (fromQuery) return fromQuery
  const editorSiteId = sanitizeSiteId(resolveEditorSiteId())
  return editorSiteId || LEGACY_AVOCADO_SITE_ID
}

function mapScalarField(field: FieldMeta, onOpenImagePicker?: (target: ImagePickerTarget) => void): Record<string, unknown> {
  if (field.kind === "number") {
    return { type: "number", label: field.label }
  }
  if (field.kind === "enum") {
    return { type: "select", label: field.label, options: field.options ?? [] }
  }
  if (field.kind === "headingLevel") {
    return { type: "select", label: field.label, options: ["h1", "h2", "h3", "h4", "h5", "h6"] }
  }
  if (field.kind === "richtext") {
    return { type: "textarea", label: field.label }
  }
  if (field.kind === "image") {
    return {
      type: "custom",
      label: field.label,
      render: ({ value, onChange, readOnly }: PuckCustomFieldRenderProps) => (
        <PuckImageFieldControl
          value={typeof value === "string" ? value : ""}
          readOnly={Boolean(readOnly)}
          onChoose={() => {
            if (readOnly) return
            onOpenImagePicker?.({
              currentUrl: typeof value === "string" ? value : undefined,
              onSelect: (imageUrl) => onChange(imageUrl),
            })
          }}
          onClear={() => {
            if (readOnly) return
            onChange("")
          }}
        />
      )
    }
  }
  return { type: "text", label: field.label }
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function getBlockIdFromProps(props: unknown): string | undefined {
  if (!props || typeof props !== "object") return undefined
  const typed = props as Record<string, unknown>
  return asNonEmptyString(typed.id) ?? asNonEmptyString(typed._blockId)
}

function deriveSelectionContextFromPuck(puck: PuckSelectionStore | null | undefined): SelectionContext | undefined {
  if (!puck?.appState?.ui || !puck.appState?.data) return undefined
  const selected = puck.selectedItem
  const fromSelected = {
    activeBlockId: getBlockIdFromProps(selected?.props),
    activeBlockType: asNonEmptyString(selected?.type),
  }

  const selector = puck.appState.ui.itemSelector
  const selectedByIndex = (() => {
    if (!selector) return undefined
    const items = selector.zone ? puck.appState.data.zones?.[selector.zone] : puck.appState.data.content
    const item = items?.[selector.index]
    if (!item) return undefined
    return {
      activeBlockId: getBlockIdFromProps(item.props),
      activeBlockType: asNonEmptyString(item.type),
    }
  })()

  const activeBlockId = fromSelected.activeBlockId ?? selectedByIndex?.activeBlockId
  const activeBlockType = fromSelected.activeBlockType ?? selectedByIndex?.activeBlockType
  const activeEditablePath = asNonEmptyString(puck.appState.ui.field.focus)
  if (!activeBlockId && !activeBlockType && !activeEditablePath) return undefined
  return { activeBlockId, activeBlockType, activeEditablePath }
}

function formatSelectionSummary(selection?: SelectionContext): string {
  if (!selection) return "none"
  const parts: string[] = []
  if (selection.activeBlockType) parts.push(`type=${selection.activeBlockType}`)
  if (selection.activeBlockId) parts.push(`id=${selection.activeBlockId}`)
  if (selection.activeEditablePath) parts.push(`field=${selection.activeEditablePath}`)
  return parts.length > 0 ? parts.join(" | ") : "none"
}

function buildFields(
  def: BlockDefinition,
  meta: BlockMeta | undefined,
  onOpenImagePicker?: (target: ImagePickerTarget) => void
): Record<string, unknown> {
  const derived = deriveFieldMetaFromSchema(def.propsSchema)
  const fields: Record<string, unknown> = {}

  for (const [key, field] of Object.entries(derived.fields)) {
    const richer = meta?.fields[key]
    fields[key] = mapScalarField(richer ?? field, onOpenImagePicker)
  }

  for (const [listKey, listField] of Object.entries(derived.listFields)) {
    const arrayFields: Record<string, unknown> = {}
    for (const [itemKey, itemField] of Object.entries(listField.itemFields)) {
      const richer = meta?.listFields?.[listKey]?.itemFields[itemKey]
      arrayFields[itemKey] = mapScalarField(richer ?? itemField, onOpenImagePicker)
    }
    fields[listKey] = {
      type: "array",
      label: meta?.listFields?.[listKey]?.label ?? listField.label ?? listKey,
      arrayFields,
      getItemSummary: (item: Record<string, unknown>, index: number) => {
        const title = typeof item.title === "string" ? item.title.trim() : ""
        return title.length > 0 ? title : `Item ${index + 1}`
      }
    }
  }

  return fields
}

function pageToPuckData(page: PageDoc): PuckData {
  const content = page.blocks.map((block) => ({
    type: block.type,
    props: {
      id: block.id,
      ...block.props,
      _blockId: block.id,
    }
  }))
  return {
    root: {},
    content,
  }
}

function cloneJsonSafe<T>(value: T): T {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value)
    } catch {
      // Fall through to JSON clone for non-cloneable values.
    }
  }
  return JSON.parse(JSON.stringify(value)) as T
}

function parseEditablePathTokens(path: string): Array<string | number> {
  if (!path) return []
  const normalized = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((token) => token.trim())
    .filter(Boolean)
  return normalized.map((token) => (/^\d+$/.test(token) ? Number(token) : token))
}

function setValueByEditablePath(root: Record<string, unknown>, editablePath: string, value: unknown): boolean {
  const tokens = parseEditablePathTokens(editablePath)
  if (tokens.length === 0) return false
  let cursor: unknown = root
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const token = tokens[i]
    const nextToken = tokens[i + 1]
    if (typeof token === "number") {
      if (!Array.isArray(cursor)) return false
      const arr = cursor as unknown[]
      if (arr[token] === undefined || arr[token] === null || typeof arr[token] !== "object") {
        arr[token] = typeof nextToken === "number" ? [] : {}
      }
      cursor = arr[token]
      continue
    }

    if (!cursor || typeof cursor !== "object") return false
    const record = cursor as Record<string, unknown>
    const nextValue = record[token]
    if (nextValue === undefined || nextValue === null || typeof nextValue !== "object") {
      record[token] = typeof nextToken === "number" ? [] : {}
    }
    cursor = record[token]
  }

  const lastToken = tokens[tokens.length - 1]
  if (typeof lastToken === "number") {
    if (!Array.isArray(cursor)) return false
    const arr = cursor as unknown[]
    if (Object.is(arr[lastToken], value)) return false
    arr[lastToken] = value
    return true
  }

  if (!cursor || typeof cursor !== "object") return false
  const record = cursor as Record<string, unknown>
  if (Object.is(record[lastToken], value)) return false
  record[lastToken] = value
  return true
}

function findPuckBlockIndexById(data: PuckData, blockId: string): number {
  return data.content.findIndex((item) => {
    const props = (item as { props?: unknown }).props
    if (!props || typeof props !== "object") return false
    const typed = props as Record<string, unknown>
    return typed.id === blockId || typed._blockId === blockId
  })
}

function applyLiveDraftToPuckData(
  data: PuckData,
  blockId: string,
  fields: Record<string, unknown>
): PuckData {
  const blockIndex = findPuckBlockIndexById(data, blockId)
  if (blockIndex < 0) return data
  const currentBlock = data.content[blockIndex] as { props?: unknown } & Record<string, unknown>
  if (!currentBlock.props || typeof currentBlock.props !== "object") return data

  const nextProps = cloneJsonSafe(currentBlock.props as Record<string, unknown>)
  let changed = false
  for (const [path, value] of Object.entries(fields)) {
    if (!path) continue
    const applied = setValueByEditablePath(nextProps, path, value)
    if (applied) changed = true
  }
  if (!changed) return data

  const nextContent = [...data.content]
  nextContent[blockIndex] = {
    ...(currentBlock as Record<string, unknown>),
    props: nextProps,
  } as PuckData["content"][number]
  return {
    ...data,
    content: nextContent,
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ""}`)
  }
  return (await res.json()) as T
}

export function PuckChatPrototype() {
  const [session] = useState(FALLBACK_SESSION)
  const [siteId] = useState(() => resolvePuckSiteId())
  const [slug, setSlug] = useState(FALLBACK_SLUG)
  const [availableSlugs, setAvailableSlugs] = useState<string[]>([FALLBACK_SLUG])
  const [isLoadingSlugs, setIsLoadingSlugs] = useState(false)
  const [manifest, setManifest] = useState<BlockManifest | null>(null)
  const [puckData, setPuckData] = useState<PuckData | null>(null)
  const [remotePuckVersion, setRemotePuckVersion] = useState(0)
  const puckDispatchRef = useRef<((action: any) => void) | null>(null)
  const [modelKey] = useState<ModelKey>(() => resolveDefaultModelKey())
  const [provider] = useState<AIProvider>(() => resolveDefaultProvider())
  const [useStreaming] = useState(true)
  const [activeBlockId, setActiveBlockId] = useState<string | undefined>(undefined)
  const [activeBlockType, setActiveBlockType] = useState<string | undefined>(undefined)
  const [activeEditablePath, setActiveEditablePath] = useState<string | undefined>(undefined)
  const [backendFeatures, setBackendFeatures] = useState<PlannerFeatures>({})
  const [imagePickerTarget, setImagePickerTarget] = useState<ImagePickerTarget | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const latestLoadSeqRef = useRef(0)
  const activeBlockIdRef = useRef<string | undefined>(undefined)
  const activeBlockTypeRef = useRef<string | undefined>(undefined)
  const activeEditablePathRef = useRef<string | undefined>(undefined)
  const slugRef = useRef(slug)
  const envAgentApiKey = useMemo(
    () => ((import.meta.env.VITE_AGENT_API_KEY as string | undefined)?.trim() ?? ""),
    []
  )
  const activeSiteConfig = useMemo(() => {
    const list = loadSiteListFromStorage(siteId)
    const match = list.find((site) => site.id === siteId)
    const canonicalName = siteId === LEGACY_AVOCADO_SITE_ID
      ? LEGACY_AVOCADO_SITE_NAME
      : (siteNameFromId(siteId) || match?.name || "Site")
    if (match) return { ...match, name: canonicalName }
    return {
      id: siteId,
      name: canonicalName,
      purpose: "",
      hosting: "",
      vercelProjectId: "",
      vercelTeamId: "",
      vercelProductionUrl: "",
      vercelDeployHookUrl: "",
      tone: "",
      constraints: [],
    }
  }, [siteId])
  useEffect(() => {
    // Defensive: if main editor drag state leaked, preview iframe can become non-interactive/non-scrollable.
    if (typeof document === "undefined") return
    document.body.classList.remove("panel-resizing")
    document.body.style.userSelect = ""
  }, [])
  useEffect(() => {
    slugRef.current = slug
  }, [slug])
  const onOpenImagePicker = useCallback((target: ImagePickerTarget) => {
    setImagePickerTarget(target)
  }, [])

  useEffect(() => {
    let active = true
    const checkPlannerStatus = async () => {
      const urls = [`${orchestrator}/status/planner`]
      if (orchestrator.includes("localhost")) {
        urls.push(`${orchestrator.replace("localhost", "127.0.0.1")}/status/planner`)
      }
      for (const url of urls) {
        try {
          const res = await fetch(url)
          if (!res.ok) continue
          const data = (await res.json()) as { features?: PlannerFeatures }
          if (!active) return
          if (data.features) {
            const next = data.features
            setBackendFeatures((prev) => (
              prev.googleDrive === next.googleDrive
                && prev.unsplash === next.unsplash
                && prev.imageGenerate === next.imageGenerate
                && prev.imageGenerateChat === next.imageGenerateChat
            ) ? prev : next)
          }
          return
        } catch {
          // Try fallback URL if available.
        }
      }
    }
    void checkPlannerStatus()
    return () => { active = false }
  }, [])

  const config = useMemo(() => {
    if (!manifest) return null

    const allMetaByType = getAllBlockMeta() as Record<string, BlockMeta | undefined>

    const components = Object.fromEntries(
      manifest.blocks.map((def) => {
        const fields = buildFields(def, allMetaByType[def.type], onOpenImagePicker)
        return [
          def.type,
          {
            fields,
            defaultProps: def.defaultProps,
            permissions: {
              drag: true,
              delete: true,
              duplicate: true,
              edit: true,
              insert: true,
            },
            render: (props: Record<string, unknown>) => {
              const blockId = typeof props._blockId === "string" && props._blockId.trim().length > 0
                ? props._blockId
                : `puck-${def.type}`
              const { _blockId: _, id: __, ...rest } = props

              if (!hasRenderer(def.type)) {
                return (
                  <section style={{ padding: "16px", border: "1px dashed #9ca3af", borderRadius: 8 }}>
                    <strong>{def.type}</strong>
                    <p style={{ margin: "8px 0 0", fontSize: 13 }}>
                      No renderer is registered for this block in the editor runtime.
                    </p>
                  </section>
                )
              }

              return (
                <SharedBlockRenderer
                  block={{
                    id: blockId,
                    type: def.type,
                    props: rest,
                  }}
                />
              )
            }
          }
        ]
      })
    )

    return {
      components,
    }
  }, [manifest, onOpenImagePicker])

  const ensureDraftInitialized = useCallback(async () => {
    let pages: PageDoc[] = []
    try {
      const source = await fetchJson<{ pages?: unknown }>(
        `${siteOrigin}/api/editor/pages?siteId=${encodeURIComponent(siteId)}`
      )
      pages = Array.isArray(source.pages) ? source.pages as PageDoc[] : []
    } catch {
      // Keep bootstrapping best-effort: orchestrator may already have draft pages.
    }

    const hasContent = pages.some((page) => Array.isArray(page.blocks) && page.blocks.length > 0)

    await fetch(`${orchestrator}/draft/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session,
        siteId,
        overwrite: hasContent,
        ...(pages.length > 0 ? { pages } : {}),
      })
    }).catch(() => undefined)
  }, [session, siteId])

  const loadManifestAndSlugs = useCallback(async () => {
    const [nextManifest, slugPayload] = await Promise.all([
      fetchJson<BlockManifest>(`${siteOrigin}/api/editor/blocks`),
      fetchJson<{ slugs?: string[] }>(`${orchestrator}/draft/slugs?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(siteId)}`)
    ])
    setManifest(nextManifest)
    const slugs = Array.isArray(slugPayload.slugs) && slugPayload.slugs.length > 0 ? slugPayload.slugs : [FALLBACK_SLUG]
    setAvailableSlugs(slugs)
    if (!slugs.includes(slug)) setSlug(slugs[0])
  }, [session, siteId, slug])

  const loadPage = useCallback(async (nextSlug: string) => {
    const loadSeq = ++latestLoadSeqRef.current
    const page = await fetchJson<PageDoc>(
      `${orchestrator}/draft/pages?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(siteId)}&slug=${encodeURIComponent(nextSlug)}`
    )
    if (loadSeq !== latestLoadSeqRef.current) return
    setPuckData(pageToPuckData(page))
    setRemotePuckVersion((v) => v + 1)
  }, [session, siteId])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setError(null)
      setIsBusy(true)
      try {
        await ensureDraftInitialized()
        if (cancelled) return
        await loadManifestAndSlugs()
        if (cancelled) return
        await loadPage(slug)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : "Failed to load Puck prototype")
      } finally {
        if (!cancelled) setIsBusy(false)
      }
    }
    void run()
    return () => { cancelled = true }
  }, [ensureDraftInitialized, loadManifestAndSlugs, loadPage, slug])

  const getBlockDefaultProps = useCallback((blockType: string): Record<string, unknown> | null => {
    if (!manifest) return null
    const def = manifest.blocks.find((item) => item.type === blockType)
    if (!def?.defaultProps || typeof def.defaultProps !== "object") return null
    return def.defaultProps as Record<string, unknown>
  }, [manifest])

  const postToSite = useCallback((
    type: "highlightBlock" | "draftUpdated" | "setNestedLabelsVisibility" | "liveDraft" | "showSkeleton" | "removeSkeleton" | "aiFieldLoading",
    payload: Record<string, unknown>
  ) => {
    if (type === "liveDraft") {
      const blockId = typeof payload.blockId === "string" ? payload.blockId : ""
      const rawFields = payload.fields
      if (!blockId || !rawFields || typeof rawFields !== "object" || Array.isArray(rawFields)) return
      setPuckData((prev) => {
        if (!prev) return prev
        const next = applyLiveDraftToPuckData(prev, blockId, rawFields as Record<string, unknown>)
        if (next !== prev && puckDispatchRef.current) {
          puckDispatchRef.current({ type: "setData", data: next })
        }
        return next
      })
      return
    }

    if (type !== "draftUpdated") return
    const navigateTo = typeof payload.navigateTo === "string" && payload.navigateTo.length > 0
      ? payload.navigateTo
      : slugRef.current
    if (navigateTo !== slugRef.current) setSlug(navigateTo)
    // Fetch updated page from orchestrator and push into Puck via dispatch (no remount)
    void fetchJson<PageDoc>(
      `${orchestrator}/draft/pages?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(siteId)}&slug=${encodeURIComponent(navigateTo)}`
    ).then((page) => {
      const nextData = pageToPuckData(page)
      if (puckDispatchRef.current) {
        puckDispatchRef.current({ type: "setData", data: nextData })
      }
      setPuckData(nextData)
    }).catch(() => undefined)
  }, [session, siteId])

  const postPatchToSite = useCallback(() => {
    void fetchJson<PageDoc>(
      `${orchestrator}/draft/pages?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(siteId)}&slug=${encodeURIComponent(slugRef.current)}`
    ).then((page) => {
      const nextData = pageToPuckData(page)
      if (puckDispatchRef.current) {
        puckDispatchRef.current({ type: "setData", data: nextData })
      }
      setPuckData(nextData)
    }).catch(() => undefined)
  }, [session, siteId])

  const chatEngine = useChatEngine({
    session,
    siteId,
    activeSiteConfig,
    slug,
    setSlug,
    modelKey,
    provider,
    useStreaming,
    activeBlockIdRef,
    activeBlockTypeRef,
    activeEditablePathRef,
    setActiveBlockId,
    setActiveBlockType,
    setActiveEditablePath,
    postToSite,
    postPatchToSite,
    setAvailableSlugs,
    setIsLoadingSlugs,
    routeOptions: availableSlugs,
    componentManifest: manifest,
    allowStructuralEdits: true,
    getBlockDefaultProps,
    onApplied: () => {
      void loadPage(slugRef.current).catch(() => undefined)
    },
    agentApiKey: envAgentApiKey || undefined,
  })

  const onSelectionChange = useCallback((selection?: SelectionContext) => {
    const nextBlockId = selection?.activeBlockId
    const nextBlockType = selection?.activeBlockType
    const nextPath = selection?.activeEditablePath

    if (activeBlockIdRef.current !== nextBlockId) {
      activeBlockIdRef.current = nextBlockId
      setActiveBlockId(nextBlockId)
    }
    if (activeBlockTypeRef.current !== nextBlockType) {
      activeBlockTypeRef.current = nextBlockType
      setActiveBlockType(nextBlockType)
    }
    if (activeEditablePathRef.current !== nextPath) {
      activeEditablePathRef.current = nextPath
      setActiveEditablePath(nextPath)
    }
  }, [])

  const onSendPrompt = useCallback(async (prompt: string) => {
    await chatEngine.submitChat(prompt)
  }, [chatEngine])

  const onCancelPrompt = useCallback(() => {
    void chatEngine.cancelChat()
  }, [chatEngine])

  const onClickSuggestion = useCallback(async (prompt: string) => {
    await chatEngine.submitChat(prompt)
  }, [chatEngine])

  const onUndo = useCallback(async (entryId: string) => {
    await chatEngine.applyUndoHistory(entryId)
  }, [chatEngine])

  const headerBusy = isBusy || chatEngine.isLoading || isLoadingSlugs
  const puckOverrides = useMemo(() => ({
    iframe: PuckPreviewIframeOverride,
    headerActions: ({ children }: { children: ReactNode }) => (
      <>
        <PuckDispatchBridge dispatchRef={puckDispatchRef} />
        <label className="puck-poc-header-page-select" title="Select page">
          <select value={slug} onChange={(e) => setSlug(e.target.value)} disabled={headerBusy}>
            {availableSlugs.map((candidate) => (
              <option key={candidate} value={candidate}>{slugLabel(candidate)}</option>
            ))}
          </select>
        </label>
        {children}
      </>
    )
  }), [availableSlugs, headerBusy, slug])

  // Stable plugin object — never changes, so Puck never remounts plugin tabs.
  // Chat state flows via PuckChatContext instead of props through the plugin boundary.
  const chatPlugin = useMemo(() => ({
    name: "ai-site-editor-chat",
    label: "AI",
    icon: <BotMessageSquare size={24} />,
    render: () => <PuckChatPluginPanelFromContext />
  }), [])

  const puckPlugins = useMemo(() => ([
    chatPlugin,
    blocksPlugin(),
    outlinePlugin(),
    fieldsPlugin({ desktopSideBar: "right" }),
  ]), [chatPlugin])

  const chatContextValue = useMemo<ChatPanelProps>(() => ({
    session,
    siteId,
    isBusy: isBusy || chatEngine.isLoading,
    error,
    chatEntries: chatEngine.chatLog,
    streamStatus: chatEngine.streamStatus,
    streamingText: chatEngine.streamingText,
    streamSteps: chatEngine.streamSteps,
    streamingChanges: chatEngine.streamingChanges,
    undoInFlightEntryId: chatEngine.undoInFlightEntryId,
    onSendPrompt,
    onCancelPrompt,
    onClickSuggestion,
    onUndo,
    onSelectionChange,
  }), [
    session, siteId, isBusy, error,
    chatEngine.chatLog, chatEngine.isLoading,
    chatEngine.streamStatus, chatEngine.streamingText,
    chatEngine.streamSteps, chatEngine.streamingChanges,
    chatEngine.undoInFlightEntryId,
    onSendPrompt, onCancelPrompt, onClickSuggestion, onUndo, onSelectionChange,
  ])

  return (
    !config || !puckData ? (
      <div className="puck-poc-loading">Loading prototype…</div>
    ) : (
      <>
        <PuckChatContext.Provider value={chatContextValue}>
          <div className="puck-poc-root">
            <Puck
              key={`${slug}-${remotePuckVersion}`}
              config={config as any}
              data={puckData as any}
              onChange={(nextData) => setPuckData(nextData as PuckData)}
              viewports={[
                { width: 390, height: 844, icon: "Smartphone", label: "Mobile" },
                { width: 768, height: 960, icon: "Tablet", label: "Tablet" },
                { width: 1280, height: 900, icon: "Monitor", label: "Desktop" },
                { width: "100%", height: 900, icon: "Monitor", label: "Full width" },
              ]}
              overrides={puckOverrides as any}
              plugins={puckPlugins}
            />
          </div>
        </PuckChatContext.Provider>
        <ImagePickerModal
          open={Boolean(imagePickerTarget)}
          features={{
            ...backendFeatures,
            googleDrive: Boolean(backendFeatures.googleDrive || activeSiteConfig?.gdriveFolderId?.trim()),
          }}
          currentUrl={imagePickerTarget?.currentUrl}
          gdriveFolderId={activeSiteConfig?.gdriveFolderId}
          cmsMedia={activeSiteConfig?.cmsMedia}
          siteOrigin={siteOrigin}
          onClose={() => setImagePickerTarget(null)}
          onSelect={(imageUrl) => {
            imagePickerTarget?.onSelect(imageUrl)
            setImagePickerTarget(null)
          }}
        />
      </>
    )
  )
}

function resolvePreviewImageUrl(url: string): string {
  if (!url) return ""
  if (/^(https?:\/\/|data:|blob:)/i.test(url)) return url
  if (url.startsWith("/")) return `${siteOrigin}${url}`
  return url
}

function PuckImageFieldControl({
  value,
  readOnly,
  onChoose,
  onClear,
}: {
  value: string
  readOnly: boolean
  onChoose: () => void
  onClear: () => void
}) {
  const hasValue = value.trim().length > 0
  const previewUrl = hasValue ? resolvePreviewImageUrl(value) : ""

  return (
    <div className="puck-poc-image-field">
      <div className="puck-poc-image-field__preview">
        {hasValue ? (
          <>
            <img src={previewUrl} alt="" />
            <span>{value}</span>
          </>
        ) : (
          <span className="puck-poc-image-field__placeholder">No image selected</span>
        )}
      </div>
      <div className="puck-poc-image-field__actions">
        <button type="button" onClick={onChoose} disabled={readOnly}>Choose image</button>
        <button type="button" onClick={onClear} disabled={readOnly || !hasValue}>Clear</button>
      </div>
    </div>
  )
}

/** Captures Puck's dispatch inside a ref so code outside Puck's tree can push data updates. */
function PuckDispatchBridge({ dispatchRef }: { dispatchRef: React.MutableRefObject<((action: any) => void) | null> }) {
  const getPuck = useGetPuck()
  useEffect(() => {
    dispatchRef.current = (action: any) => getPuck().dispatch(action)
    return () => { dispatchRef.current = null }
  }, [getPuck, dispatchRef])
  return null
}

function PuckChatPluginPanelFromContext() {
  const ctx = useContext(PuckChatContext)
  if (!ctx) return null
  return <PuckChatPluginPanel {...ctx} />
}

function PuckChatPluginPanel({
  session,
  siteId,
  isBusy,
  error,
  chatEntries,
  streamStatus,
  streamingText,
  streamSteps,
  streamingChanges,
  undoInFlightEntryId,
  onSendPrompt,
  onCancelPrompt,
  onClickSuggestion,
  onUndo,
  onSelectionChange
}: ChatPanelProps) {
  const media = useMediaInput()
  const [draft, setDraft] = useState("")
  const threadRef = useRef<HTMLDivElement | null>(null)
  const shouldAutoScrollRef = useRef(true)
  const didInitialAutoScrollRef = useRef(false)
  const getPuck = useGetPuck()
  const selectionJson = usePuckSelector((store) => JSON.stringify(
    deriveSelectionContextFromPuck(store as unknown as PuckSelectionStore) ?? null
  ))
  const liveSelection = useMemo(() => {
    try {
      const parsed = JSON.parse(selectionJson) as SelectionContext | null
      return parsed ?? undefined
    } catch {
      return undefined
    }
  }, [selectionJson])
  const safeEntries = useMemo(() => (
    Array.isArray(chatEntries)
      ? chatEntries.filter((entry) => Boolean(entry && typeof entry === "object"))
      : []
  ), [chatEntries])
  const [fallbackStoredEntries, setFallbackStoredEntries] = useState<ChatEntry[]>([])
  useEffect(() => {
    if (typeof window === "undefined") return
    const storageKey = `editor-chat-log-v1:${session}:${siteId}`
    let lastRaw: string | null = null
    const readFallbackEntries = () => {
      try {
        const raw = window.localStorage.getItem(storageKey)
        if (raw === lastRaw) return
        lastRaw = raw
        if (!raw) {
          setFallbackStoredEntries([])
          return
        }
        const parsed = JSON.parse(raw) as unknown
        if (!Array.isArray(parsed)) {
          setFallbackStoredEntries([])
          return
        }
        setFallbackStoredEntries(parsed.filter((entry): entry is ChatEntry => Boolean(entry && typeof entry === "object")))
      } catch {
        setFallbackStoredEntries([])
      }
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key && event.key !== storageKey) return
      readFallbackEntries()
    }

    readFallbackEntries()
    window.addEventListener("storage", onStorage)
    const pollId = window.setInterval(readFallbackEntries, 700)
    return () => {
      window.removeEventListener("storage", onStorage)
      window.clearInterval(pollId)
    }
  }, [session, siteId])
  const displayEntries = safeEntries.length > 0 ? safeEntries : fallbackStoredEntries
  const hasUserEntry = displayEntries.some((entry) => entry.role === "user")
  const hasThreadContent = displayEntries.length > 0 || Boolean(streamingText) || Boolean(streamStatus)
  const doneStreamSteps = useMemo(() => streamSteps.filter((s) => s.done), [streamSteps])
  const scrollThreadToBottom = useCallback(() => {
    const thread = threadRef.current
    if (!thread) return
    thread.scrollTop = thread.scrollHeight
  }, [])

  const onThreadScroll = useCallback(() => {
    const thread = threadRef.current
    if (!thread) return
    const distanceToBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight
    shouldAutoScrollRef.current = distanceToBottom < 64
  }, [])

  const send = useCallback((explicitMessage?: string) => {
    const prompt = (explicitMessage ?? draft).trim()
    if (!prompt) return
    const latestSelection = deriveSelectionContextFromPuck(getPuck() as unknown as PuckSelectionStore)
    onSelectionChange(latestSelection)
    setDraft("")
    shouldAutoScrollRef.current = true
    scrollThreadToBottom()
    void onSendPrompt(prompt)
  }, [draft, getPuck, onSelectionChange, onSendPrompt, scrollThreadToBottom])

  useEffect(() => {
    onSelectionChange(liveSelection)
  }, [
    liveSelection?.activeBlockId,
    liveSelection?.activeBlockType,
    liveSelection?.activeEditablePath,
    onSelectionChange
  ])

  useEffect(() => {
    if (!hasThreadContent) return
    const shouldForceInitial = !didInitialAutoScrollRef.current
    if (!shouldForceInitial && !shouldAutoScrollRef.current) return
    const raf1 = window.requestAnimationFrame(() => {
      scrollThreadToBottom()
      didInitialAutoScrollRef.current = true
    })
    return () => {
      window.cancelAnimationFrame(raf1)
    }
  }, [
    hasThreadContent,
    displayEntries.length,
    streamingText,
    streamStatus,
    streamSteps.length,
    streamingChanges.length,
    scrollThreadToBottom
  ])

  return (
    <div className="puck-poc-chat puck-poc-chat--plugin">
      <div className="puck-poc-chat__header">
        <h1>AI page builder</h1>
      </div>
      <p className="puck-poc-chat__selection">Context: {formatSelectionSummary(liveSelection)}</p>

      <div className="puck-poc-chat__surface">
        <div
          ref={threadRef}
          className="puck-poc-chat__thread-core"
          onScroll={onThreadScroll}
        >
          {displayEntries.length === 0 && !streamingText && !streamStatus ? (
            <article className="chat-thread-empty">Start chatting to see responses here.</article>
          ) : null}
          {displayEntries.map((entry) => {
            const safeText = typeof entry.text === "string" && entry.text.trim().length > 0 ? entry.text : "…"
            const roleClass = entry.role === "user" ? "user" : "assistant"
            const safeSuggestions = Array.isArray(entry.suggestions)
              ? entry.suggestions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
              : []
            return (
              <article key={entry.id} className={`puck-poc-msg puck-poc-msg--${roleClass}`}>
                <div className="puck-poc-msg__main">
                  {(() => {
                    if (entry.role !== "assistant") return safeText
                    try {
                      return renderFinalMarkdown(safeText)
                    } catch {
                      return safeText
                    }
                  })()}
                </div>
                {safeSuggestions.length > 0 ? (
                  <div className="msg-suggestions">
                    {safeSuggestions.map((line, idx) => (
                      <button
                        key={`${entry.id}-${idx}`}
                        type="button"
                        className="msg-suggestion"
                        onClick={() => void onClickSuggestion(line)}
                        disabled={isBusy}
                      >
                        {line}
                      </button>
                    ))}
                  </div>
                ) : null}
                {entry.canUndo || entry.wasUndone ? (
                  <div className="msg-undo-row">
                    <button
                      type="button"
                      className="msg-undo-btn"
                      onClick={() => void onUndo(entry.id)}
                      disabled={!entry.canUndo || isBusy || undoInFlightEntryId !== null}
                    >
                      {entry.wasUndone ? "Undone" : "Undo"}
                    </button>
                  </div>
                ) : null}
              </article>
            )
          })}
          {streamingText ? (
            <article className="puck-poc-msg puck-poc-msg--assistant">
              {doneStreamSteps.length > 0 ? (
                <ul className="stream-steps stream-steps-in-bubble">
                  {doneStreamSteps.map((step, idx) => (
                    <li key={idx} className="stream-step is-done">{step.label}</li>
                  ))}
                </ul>
              ) : null}
              <div className="puck-poc-msg__main">{renderSimpleMarkdown(streamingText)}</div>
              {streamingChanges.length > 0 ? (
                <ul className="msg-list">
                  {streamingChanges.slice(0, 8).map((line, idx) => (
                    <li key={idx}>{line}</li>
                  ))}
                  {streamingChanges.length > 8 ? (
                    <li className="msg-list-overflow">and {streamingChanges.length - 8} more…</li>
                  ) : null}
                </ul>
              ) : null}
            </article>
          ) : streamStatus ? (
            <article className="puck-poc-msg puck-poc-msg--assistant">
              {doneStreamSteps.length > 0 ? (
                <ul className="stream-steps stream-steps-in-bubble">
                  {doneStreamSteps.map((step, idx) => (
                    <li key={idx} className="stream-step is-done">{step.label}</li>
                  ))}
                </ul>
              ) : null}
              <div className="puck-poc-msg__main">{streamStatus}</div>
            </article>
          ) : null}
        </div>
        <ChatComposerCore
          message={draft}
          isLoading={isBusy}
          hasUserEntry={hasUserEntry}
          onMessageChange={setDraft}
          onSubmit={send}
          onTranscribeAudio={media.transcribeAudio}
          onInterpretImage={media.interpretPastedImage}
          onUploadImage={media.uploadPastedImage}
          onCancel={onCancelPrompt}
          onAutoHeightChange={() => {}}
          className="composer puck-poc-chat__composer-core"
        />
      </div>

      {error ? <p className="puck-poc-chat__error">{error}</p> : null}
    </div>
  )
}
