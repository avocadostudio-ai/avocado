import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Puck, blocksPlugin, fieldsPlugin, outlinePlugin } from "@puckeditor/core"
import "@puckeditor/core/puck.css"
import "@ai-site-editor/blocks/styles.css"
import "../puck-prototype.css"
import { ArrowLeft, BotMessageSquare, History, Redo2, Undo2 } from "lucide-react"
import { FALLBACK_SESSION, FALLBACK_SLUG } from "./puck/constants"
import { createPuckConfig } from "./puck/createPuckConfig"
import { PuckChatContextProvider } from "./puck/PuckChatContext"
import { PuckChatPluginPanelFromContext } from "./puck/PuckChatPluginPanel"
import { PuckDispatchBridge } from "./puck/PuckDispatchBridge"
import { PuckPreviewIframeOverride } from "./puck/PuckPreviewIframeOverride"
import { resolvePuckSiteId } from "./puck/site"
import type { ChatPanelProps, ImagePickerTarget, PuckData, SelectionContext } from "./puck/types"
import { getPuckHostApi, setPuckHostApi } from "../host/runtime"
import type { PuckHostApi } from "../host/types"
import { usePuckBootstrap } from "./puck/usePuckBootstrap"
import { usePuckPlannerFeatures } from "./puck/usePuckPlannerFeatures"
import { usePuckSiteSync } from "./puck/usePuckSiteSync"
import { buildOpsFromPuckDiff, ensurePuckBlockIds } from "./puck/adapters"
import { applyDraftOps } from "./puck/draft-api"

const PUCK_AUTOSAVE_DEBOUNCE_MS = 600

export function PuckChatPrototype({ host }: { host: PuckHostApi }) {
  setPuckHostApi(host)
  const hostApi = getPuckHostApi()
  const [session] = useState(FALLBACK_SESSION)
  const [siteId] = useState(() => resolvePuckSiteId())
  const [slug, setSlug] = useState(FALLBACK_SLUG)
  const [modelKey] = useState(() => hostApi.resolveDefaultModelKey())
  const [provider] = useState(() => hostApi.resolveDefaultProvider())
  const [useStreaming] = useState(true)
  const [activeBlockId, setActiveBlockId] = useState<string | undefined>(undefined)
  const [activeBlockType, setActiveBlockType] = useState<string | undefined>(undefined)
  const [activeEditablePath, setActiveEditablePath] = useState<string | undefined>(undefined)
  const [imagePickerTarget, setImagePickerTarget] = useState<ImagePickerTarget | null>(null)
  const puckDispatchRef = useRef<((action: any) => void) | null>(null)
  const activeBlockIdRef = useRef<string | undefined>(undefined)
  const activeBlockTypeRef = useRef<string | undefined>(undefined)
  const activeEditablePathRef = useRef<string | undefined>(undefined)
  const slugRef = useRef(slug)
  slugRef.current = slug
  const latestPuckDataRef = useRef<PuckData | null>(null)
  const persistedPuckDataRef = useRef<PuckData | null>(null)
  const pendingPersistDataRef = useRef<PuckData | null>(null)
  const persistTimerRef = useRef<number | null>(null)
  const persistInFlightRef = useRef(false)

  const agentModeEnabled = hostApi.agentModeEnabled ?? false

  const activeSiteConfig = useMemo(() => {
    const list = hostApi.loadSiteListFromStorage(siteId)
    const match = list.find((site) => site.id === siteId)
    const canonicalName = siteId === hostApi.LEGACY_AVOCADO_SITE_ID
      ? hostApi.LEGACY_AVOCADO_SITE_NAME
      : (hostApi.siteNameFromId(siteId) || match?.name || "Site")
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
  }, [siteId, hostApi])

  useEffect(() => {
    // Defensive: if main editor drag state leaked, preview iframe can become non-interactive/non-scrollable.
    if (typeof document === "undefined") return
    document.body.classList.remove("panel-resizing")
    document.body.style.userSelect = ""
  }, [])

  useEffect(() => { hostApi.setGlobalSlug(slug) }, [slug, hostApi])

  const onOpenImagePicker = useCallback((target: ImagePickerTarget) => {
    setImagePickerTarget(target)
  }, [])

  const {
    manifest,
    puckData,
    setPuckData,
    remotePuckVersion,
    availableSlugs,
    setAvailableSlugs,
    isLoadingSlugs,
    setIsLoadingSlugs,
    isBusy,
    error,
  } = usePuckBootstrap({ session, siteId, slug, setSlug })

  const backendFeatures = usePuckPlannerFeatures()

  const onRemotePuckData = useCallback((data: PuckData) => {
    latestPuckDataRef.current = data
    persistedPuckDataRef.current = data
  }, [])

  const {
    postToSite,
    postPatchToSite,
    syncDraftPage,
  } = usePuckSiteSync({
    session,
    siteId,
    slugRef,
    setSlug,
    setAvailableSlugs,
    puckDispatchRef,
    setPuckData,
    onRemoteData: onRemotePuckData,
  })

  const config = useMemo(
    () => (manifest ? createPuckConfig(manifest, onOpenImagePicker) : null),
    [manifest, onOpenImagePicker]
  )

  const getBlockDefaultProps = useCallback((blockType: string): Record<string, unknown> | null => {
    if (!manifest) return null
    const def = manifest.blocks.find((item) => item.type === blockType)
    if (!def?.defaultProps || typeof def.defaultProps !== "object") return null
    return def.defaultProps as Record<string, unknown>
  }, [manifest])

  const chatEngine = hostApi.useChatEngine({
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
    // onApplied omitted: postToSite("draftUpdated") already triggers syncDraftPage
    agentModeEnabled,
  })

  const publish = hostApi.usePublish(session, siteId, chatEngine.isLoading)

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

    // useChatEngine reads activeBlockId/Type/EditablePath from the global
    // Zustand store in the host app — not from the refs passed in its args.
    // Push Puck's selection into that store so chat requests include the
    // selected block id.
    hostApi.setGlobalSelection(selection)
  }, [hostApi])

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

  const flushPendingPersist = useCallback(async () => {
    if (persistInFlightRef.current) return
    const targetData = pendingPersistDataRef.current
    if (!targetData) return

    const previousData = persistedPuckDataRef.current
    pendingPersistDataRef.current = null
    if (!previousData) {
      persistedPuckDataRef.current = targetData
      return
    }

    const ops = buildOpsFromPuckDiff(slugRef.current, previousData, targetData)
    if (ops.length === 0) {
      persistedPuckDataRef.current = targetData
      return
    }

    persistInFlightRef.current = true
    try {
      const applied = await applyDraftOps(session, siteId, ops)
      if (applied) {
        persistedPuckDataRef.current = targetData
      } else {
        void syncDraftPage(slugRef.current).catch(() => undefined)
      }
    } catch {
      void syncDraftPage(slugRef.current).catch(() => undefined)
    } finally {
      persistInFlightRef.current = false
      if (pendingPersistDataRef.current) {
        void flushPendingPersist()
      }
    }
  }, [session, siteId, syncDraftPage])

  const queuePersist = useCallback((data: PuckData) => {
    pendingPersistDataRef.current = data
    if (typeof window === "undefined") return
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current)
    }
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null
      void flushPendingPersist()
    }, PUCK_AUTOSAVE_DEBOUNCE_MS)
  }, [flushPendingPersist])

  const onPuckChange = useCallback((nextDataRaw: unknown) => {
    if (!persistedPuckDataRef.current && puckData) {
      persistedPuckDataRef.current = puckData
    }
    const nextData = ensurePuckBlockIds(nextDataRaw as PuckData)
    latestPuckDataRef.current = nextData
    setPuckData(nextData)
    queuePersist(nextData)
  }, [puckData, queuePersist, setPuckData])

  const onPuckPublish = useCallback(async (nextDataRaw: unknown) => {
    if (!persistedPuckDataRef.current && puckData) {
      persistedPuckDataRef.current = puckData
    }
    const nextData = ensurePuckBlockIds(nextDataRaw as PuckData)
    latestPuckDataRef.current = nextData
    setPuckData(nextData)
    pendingPersistDataRef.current = nextData
    if (typeof window !== "undefined" && persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current)
      persistTimerRef.current = null
    }
    await flushPendingPersist()
    await publish.publishSite()
  }, [flushPendingPersist, puckData, setPuckData, publish])

  const flushThenHistory = useCallback(async (direction: "undo" | "redo") => {
    // Cancel pending debounce and flush pending ops before applying server-side history action.
    if (typeof window !== "undefined" && persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current)
      persistTimerRef.current = null
    }
    await flushPendingPersist()
    if (direction === "undo") await chatEngine.applyGlobalUndo()
    else await chatEngine.applyGlobalRedo()
    // useUndoHistory calls postToSite("draftUpdated") which triggers syncDraftPage via usePuckSiteSync.
  }, [flushPendingPersist, chatEngine])

  useEffect(() => {
    latestPuckDataRef.current = puckData ?? null
  }, [puckData])

  useEffect(() => {
    if (!latestPuckDataRef.current) return
    persistedPuckDataRef.current = latestPuckDataRef.current
  }, [remotePuckVersion, slug])

  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current)
        persistTimerRef.current = null
      }
    }
  }, [])

  const headerBusy = isBusy || chatEngine.isLoading || isLoadingSlugs

  const puckOverrides = useMemo(() => ({
    iframe: PuckPreviewIframeOverride,
    headerActions: ({ children }: { children: ReactNode }) => (
      <>
        <PuckDispatchBridge dispatchRef={puckDispatchRef} />
        <a
          href="/sites"
          className="puck-poc-header-btn puck-poc-header-back"
          title="Back to sites"
          aria-label="Back to sites"
        >
          <ArrowLeft size={16} />
          <span>Sites</span>
        </a>
        <label className="puck-poc-header-page-select" title="Select page">
          <select value={slug} onChange={(e) => setSlug(e.target.value)} disabled={headerBusy}>
              {availableSlugs.map((candidate) => (
              <option key={candidate} value={candidate}>{hostApi.slugLabel(candidate)}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="puck-poc-header-btn"
          disabled={!chatEngine.canUndoServer || headerBusy}
          onClick={() => void flushThenHistory("undo")}
          title="Undo (Ctrl+Z)"
          aria-label="Undo"
        >
          <Undo2 size={16} />
        </button>
        <button
          type="button"
          className="puck-poc-header-btn"
          disabled={!chatEngine.canRedoServer || headerBusy}
          onClick={() => void flushThenHistory("redo")}
          title="Redo (Ctrl+Y)"
          aria-label="Redo"
        >
          <Redo2 size={16} />
        </button>
        {publish.publishStatus?.inspectUrl ? (
          <a className="puck-publish-link" href={publish.publishStatus.inspectUrl} target="_blank" rel="noreferrer">
            View deploy
          </a>
        ) : null}
        {children}
      </>
    )
  }), [availableSlugs, headerBusy, slug, publish.publishStatus, chatEngine.canUndoServer, chatEngine.canRedoServer, flushThenHistory])

  const chatPlugin = useMemo(() => ({
    name: "ai-site-editor-chat",
    label: "AI",
    icon: <BotMessageSquare size={24} />,
    render: () => <PuckChatPluginPanelFromContext />
  }), [])

  const [isRestoring, setIsRestoring] = useState(false)
  const onRestoreVersion = useCallback(async (targetVersion: number) => {
    setIsRestoring(true)
    try {
      // Flush any pending ops before restore so we don't race with autosave.
      if (typeof window !== "undefined" && persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current)
        persistTimerRef.current = null
      }
      await flushPendingPersist()
      const ok = await hostApi.restoreToVersion(session, siteId, slugRef.current, targetVersion)
      if (ok) {
        await syncDraftPage(slugRef.current)
      }
    } finally {
      setIsRestoring(false)
    }
  }, [flushPendingPersist, hostApi, session, siteId, syncDraftPage])

  const historyPlugin = useMemo(() => ({
    name: "ai-site-editor-history",
    label: "History",
    icon: <History size={24} />,
    render: () => (
      <hostApi.VersionHistoryPanel
        session={session}
        siteId={siteId}
        slug={slug}
        visible={true}
        onRestore={onRestoreVersion}
        isRestoring={isRestoring}
      />
    )
  }), [hostApi, session, siteId, slug, onRestoreVersion, isRestoring])

  const puckPlugins = useMemo(() => ([
    chatPlugin,
    historyPlugin,
    blocksPlugin(),
    outlinePlugin(),
    fieldsPlugin({ desktopSideBar: "right" }),
  ]), [chatPlugin, historyPlugin])

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
    session,
    siteId,
    isBusy,
    error,
    chatEngine.chatLog,
    chatEngine.isLoading,
    chatEngine.streamStatus,
    chatEngine.streamingText,
    chatEngine.streamSteps,
    chatEngine.streamingChanges,
    chatEngine.undoInFlightEntryId,
    onSendPrompt,
    onCancelPrompt,
    onClickSuggestion,
    onUndo,
    onSelectionChange,
  ])

  return (
    !config || !puckData ? (
      <div className="puck-poc-loading">Loading…</div>
    ) : (
      <>
        <PuckChatContextProvider value={chatContextValue}>
          <div className="puck-poc-root">
            <Puck
              key={`${slug}-${remotePuckVersion}`}
              config={config as any}
              data={puckData as any}
              onChange={onPuckChange}
              onPublish={onPuckPublish}
              iframe={{ enabled: false }}
              viewports={[
                { width: 390, height: 844, icon: "Smartphone", label: "Mobile" },
                { width: 768, height: 960, icon: "Tablet", label: "Tablet" },
                { width: "100%", height: 900, icon: "Monitor", label: "Full width" },
              ]}
              overrides={puckOverrides as any}
              plugins={puckPlugins}
            />
          </div>
        </PuckChatContextProvider>
        <hostApi.ImagePickerModal
          open={Boolean(imagePickerTarget)}
          features={{
            ...backendFeatures,
            googleDrive: Boolean(backendFeatures.googleDrive || activeSiteConfig?.gdriveFolderId?.trim()),
          }}
          currentUrl={imagePickerTarget?.currentUrl}
          gdriveFolderId={activeSiteConfig?.gdriveFolderId}
          cmsMedia={activeSiteConfig?.cmsMedia}
          siteOrigin={hostApi.siteOrigin}
          onClose={() => setImagePickerTarget(null)}
          onSelect={(imageUrl: string) => {
            imagePickerTarget?.onSelect(imageUrl)
            setImagePickerTarget(null)
          }}
        />
      </>
    )
  )
}
