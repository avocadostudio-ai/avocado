/**
 * Root component for the immersive editing widget.
 * Renders directly inside the site page — no iframe.
 *
 * Provides:
 * - Floating chat panel (FAB + expandable panel)
 * - Block selection overlay (via bridge functions)
 * - Text selection toolbar for AI targeting
 * - Direct SSE/HTTP transport to orchestrator
 */

"use client"

import { useState, useCallback, useEffect, useRef, useMemo } from "react"
import { createPortal } from "react-dom"
import { ChatFab } from "./components/ChatFab"
import { ChatPanel } from "./components/ChatPanel"
import { PasswordGate } from "./components/PasswordGate"
import { TextSelectionToolbar } from "./components/TextSelectionToolbar"
import { useBlockSelection, type BlockSelectionState } from "./hooks/useBlockSelection"
import { useTextSelection, type TextSelectionContext } from "./hooks/useTextSelection"
import { submitChatStream, submitChatHttp, type ChatResult, type ChatRequestPayload } from "./lib/widget-transport"
import { getAccessToken } from "./lib/access-auth"
import { loadChatHistory, saveChatHistory, nextEntryId, type WidgetChatEntry, type WidgetConfig } from "./lib/widget-state"
import type { BlockManifest } from "@ai-site-editor/shared"

export type SiteContext = {
  siteName?: string
  purpose?: string
  tone?: string
  constraints?: string[]
}

export type ImmersiveWidgetProps = {
  config: WidgetConfig
  /** Current page slug (derived from pathname) */
  slug: string
  pathname: string
  /** Trigger a Next.js router refresh */
  refresh: () => void
  /** Navigate to a different page */
  navigate: (href: string) => void
  /** Block manifest for the site */
  manifest?: BlockManifest | null
  /** Site context (purpose, tone, etc.) */
  siteContext?: SiteContext
  /** Access token for orchestrator auth */
  accessToken?: string
  /** AI model key */
  modelKey?: string
  /** AI provider */
  provider?: string
}

export function ImmersiveWidget({
  config,
  slug,
  pathname,
  refresh,
  navigate,
  manifest,
  siteContext,
  accessToken,
  modelKey = "balanced",
  provider = "anthropic",
}: ImmersiveWidgetProps) {
  const [panelOpen, setPanelOpen] = useState(false)
  // Key: "iw-authed" is only set in THIS tab after successful password verify or confirmed valid token
  const [authenticated, setAuthenticated] = useState(() =>
    typeof sessionStorage !== "undefined" && sessionStorage.getItem("iw-authed") === "1"
  )

  // On first mount, verify any existing token
  useEffect(() => {
    if (authenticated) return
    const token = getAccessToken()
    if (!token) return
    fetch(`${config.orchestratorUrl}/auth/status`, {
      headers: { "x-access-token": token },
    })
      .then(r => r.json())
      .then((d: { gateEnabled?: boolean; tokenValid?: boolean }) => {
        if (!d.gateEnabled || d.tokenValid) {
          sessionStorage.setItem("iw-authed", "1")
          setAuthenticated(true)
        }
      })
      .catch(() => {})
  }, [config.orchestratorUrl, authenticated])
  const [chatLog, setChatLog] = useState<WidgetChatEntry[]>(() =>
    loadChatHistory(config.session, config.siteId)
  )
  const [isLoading, setIsLoading] = useState(false)
  const [streamStatus, setStreamStatus] = useState<string | null>(null)
  const [selectedBlock, setSelectedBlock] = useState<BlockSelectionState>({ blockId: null, blockType: null, editablePath: null })
  const cancelRef = useRef<(() => void) | null>(null)

  // Persist chat history
  useEffect(() => {
    saveChatHistory(config.session, config.siteId, chatLog)
  }, [chatLog, config.session, config.siteId])

  // Block selection — callbacks use refs to avoid circular deps with triggerRefresh
  const handleBlockSelected = useCallback((state: BlockSelectionState) => {
    setSelectedBlock(state)
  }, [])

  const { focusBlock, renderLiveDraft, triggerRefresh } = useBlockSelection({
    slug,
    pathname,
    refresh,
    navigate,
    selectionMode: true, // Always on in immersive mode
    onBlockSelected: handleBlockSelected,
  })

  // Text selection
  const { textSelection, clearSelection } = useTextSelection()

  // Cmd+K shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault()
        setPanelOpen(true)
      }
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [])

  const handleChatResult = useCallback((result: ChatResult) => {
    setIsLoading(false)
    setStreamStatus(null)

    const entry: WidgetChatEntry = {
      id: nextEntryId(),
      role: "assistant",
      text: result.summary || "Done.",
      changes: result.changes,
      suggestions: result.suggestions,
      timestamp: Date.now(),
    }
    setChatLog((prev) => [...prev, entry])

    if (result.focusBlockId) {
      focusBlock(result.focusBlockId)
    }
    triggerRefresh(result.focusBlockId)
  }, [focusBlock, triggerRefresh])

  const handleSubmit = useCallback((message: string) => {
    // Cancel any in-flight stream
    cancelRef.current?.()

    // Add user message
    const userEntry: WidgetChatEntry = {
      id: nextEntryId(),
      role: "user",
      text: message,
      timestamp: Date.now(),
    }
    setChatLog((prev) => [...prev, userEntry])
    setIsLoading(true)
    setStreamStatus("Thinking...")

    const payload: ChatRequestPayload = {
      session: config.session,
      siteId: config.siteId,
      slug,
      message,
      modelKey,
      provider,
      activeBlockId: selectedBlock.blockId ?? undefined,
      activeBlockType: selectedBlock.blockType ?? undefined,
      activeEditablePath: selectedBlock.editablePath ?? undefined,
      componentsManifest: manifest,
      ...(siteContext ? {
        sitePurpose: siteContext.purpose,
        businessContext: {
          purpose: siteContext.purpose,
          tone: siteContext.tone,
          constraints: siteContext.constraints,
        },
        siteContext: {
          siteId: config.siteId,
          siteName: siteContext.siteName,
          purpose: siteContext.purpose,
          tone: siteContext.tone,
          constraints: siteContext.constraints,
        },
      } : {}),
    }

    const { cancel } = submitChatStream(
      config.orchestratorUrl,
      payload,
      {
        onStatus: (msg) => setStreamStatus(msg),
        onOpApplied: (event) => {
          setStreamStatus(`Applying changes (${event.index + 1}/${event.total})...`)
          if (event.focusBlockId) focusBlock(event.focusBlockId)
          triggerRefresh(event.focusBlockId)
        },
        onFieldDraft: (event) => {
          renderLiveDraft(event.blockId, event.value, true, { [event.editablePath]: event.value })
        },
        onFinal: handleChatResult,
        onError: (result) => {
          setIsLoading(false)
          setStreamStatus(null)
          // If unauthorized, show password gate
          if (result.summary?.toLowerCase().includes("unauthorized") || result.error?.toLowerCase().includes("unauthorized")) {
            sessionStorage.removeItem("iw-authed")
            setAuthenticated(false)
            return
          }
          setChatLog((prev) => [...prev, {
            id: nextEntryId(),
            role: "assistant",
            text: result.summary || result.error || "Something went wrong.",
            timestamp: Date.now(),
          }])
        },
      },
      accessToken,
    )

    cancelRef.current = cancel
  }, [config, slug, modelKey, provider, selectedBlock, manifest, accessToken, focusBlock, renderLiveDraft, triggerRefresh, handleChatResult])

  const handleTextSelectionAskAI = useCallback((ctx: TextSelectionContext) => {
    clearSelection()
    setSelectedBlock({ blockId: ctx.blockId, blockType: ctx.blockType, editablePath: ctx.editablePath })
    setPanelOpen(true)
    // Pre-fill context — user can type their instruction
  }, [clearSelection])

  const selectedBlockLabel = selectedBlock.blockType
    ? `${selectedBlock.blockType}${selectedBlock.editablePath ? ` > ${selectedBlock.editablePath}` : ""}`
    : null

  // Need a mounted flag for the portal — document.body doesn't exist during SSR
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  if (!mounted) return null

  const ui = (
    <>
      {/* Text selection toolbar */}
      {textSelection && !panelOpen && (
        <TextSelectionToolbar
          selection={textSelection}
          onAskAI={handleTextSelectionAskAI}
        />
      )}

      {/* Password gate — shown when not authenticated */}
      {panelOpen && !authenticated && (
        <PasswordGate
          orchestratorUrl={config.orchestratorUrl}
          onAuthenticated={() => {
            sessionStorage.setItem("iw-authed", "1")
            setAuthenticated(true)
          }}
          onClose={() => setPanelOpen(false)}
        />
      )}

      {/* Chat panel — only when authenticated */}
      {panelOpen && authenticated && (
        <ChatPanel
          chatLog={chatLog}
          isLoading={isLoading}
          streamStatus={streamStatus}
          onSubmit={handleSubmit}
          onClose={() => setPanelOpen(false)}
          selectedBlockLabel={selectedBlockLabel}
        />
      )}

      {/* FAB */}
      <ChatFab
        open={panelOpen}
        onClick={() => setPanelOpen((prev) => !prev)}
      />
    </>
  )

  // Portal to document.body to escape stacking contexts
  return createPortal(ui, document.body)
}
