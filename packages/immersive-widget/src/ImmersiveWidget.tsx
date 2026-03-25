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
import { InlineFieldPrompt, type FieldContext } from "./components/InlineFieldPrompt"
import { TextSelectionToolbar } from "./components/TextSelectionToolbar"
import { useBlockSelection, type BlockSelectionState } from "./hooks/useBlockSelection"
import { useTextSelection, type TextSelectionContext } from "./hooks/useTextSelection"
import { findBlockNode, findEditableNode, supportsInlineEditablePath, applyAiFieldLoading } from "@ai-site-editor/preview-adapter"
import { submitChatStream, submitChatHttp, applyOps, type ChatResult, type ChatRequestPayload } from "./lib/widget-transport"
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
  const [panelQuickActions, setPanelQuickActions] = useState<string[] | undefined>(undefined)
  const [activeField, setActiveField] = useState<FieldContext | null>(null)
  const [fieldLoading, setFieldLoading] = useState(false)
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

  // Block selection — when a text field is clicked, show inline prompt
  const handleBlockSelected = useCallback((state: BlockSelectionState) => {
    setSelectedBlock(state)

    // If a text field was clicked (not an image), show inline field prompt
    if (state.blockId && state.editablePath && supportsInlineEditablePath(state.editablePath)) {
      const blockNode = findBlockNode(state.blockId)
      if (blockNode) {
        const fieldNode = findEditableNode(blockNode, state.editablePath)
        if (fieldNode) {
          setActiveField({
            blockId: state.blockId,
            blockType: state.blockType ?? "Block",
            editablePath: state.editablePath,
            element: fieldNode,
          })
          setPanelOpen(false) // Close chat panel when field prompt is active
          return
        }
      }
    }
    // Clear field prompt if clicking a block without a text field
    setActiveField(null)
  }, [])

  // Helper: apply an operation via /ops and refresh
  const applyOp = useCallback((op: Record<string, unknown>) => {
    applyOps(config.orchestratorUrl, {
      session: config.session,
      siteId: config.siteId,
      ops: [op],
    }).then(() => {
      setTimeout(() => refresh(), 100)
    })
  }, [config, refresh])

  const { focusBlock, renderLiveDraft, triggerRefresh } = useBlockSelection({
    slug,
    pathname,
    refresh,
    navigate,
    selectionMode: true,
    onBlockSelected: handleBlockSelected,
    onBlockReordered: useCallback((p: { slug: string; blockId: string; afterBlockId: string | null }) => {
      applyOp({ op: "move_block", pageSlug: p.slug, blockId: p.blockId, afterBlockId: p.afterBlockId })
    }, [applyOp]),
    onBlockDeleteRequested: useCallback((p: { slug: string; blockId: string; blockType: string }) => {
      applyOp({ op: "remove_block", pageSlug: p.slug, blockId: p.blockId })
    }, [applyOp]),
    onBlockAddRequested: useCallback((_p: { slug: string; afterBlockId?: string; beforeBlockId?: string }) => {
      setActiveField(null)
      setPanelQuickActions([
        "Add a Hero section",
        "Add a Features grid",
        "Add a Testimonials section",
        "Add an FAQ section",
        "Add a CTA section",
        "Add a Card grid",
      ])
      setPanelOpen(true)
    }, []),
    onListItemMoveRequested: useCallback((p: { slug: string; blockId: string; blockType: string; listKey: string; index: number; afterIndex?: number }) => {
      applyOp({ op: "move_item", pageSlug: p.slug, blockId: p.blockId, listKey: p.listKey, itemIndex: p.index, afterIndex: p.afterIndex })
    }, [applyOp]),
    onListItemRemoveRequested: useCallback((p: { slug: string; blockId: string; blockType: string; listKey: string; index: number }) => {
      applyOp({ op: "remove_item", pageSlug: p.slug, blockId: p.blockId, listKey: p.listKey, itemIndex: p.index })
    }, [applyOp]),
    onListItemAddRequested: useCallback((p: { slug: string; blockId: string; blockType: string; listKey: string; afterIndex: number }) => {
      applyOp({ op: "add_item", pageSlug: p.slug, blockId: p.blockId, listKey: p.listKey, afterIndex: p.afterIndex })
    }, [applyOp]),
  })

  // Text selection
  const { textSelection, clearSelection } = useTextSelection()

  // Cmd+K shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault()
        setActiveField(null)
        setPanelQuickActions(undefined)
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
        },
        onFieldDraft: (event) => {
          renderLiveDraft(event.blockId, event.value, true, { [event.editablePath]: event.value })
        },
        onFinal: (result) => {
          // Don't clear live draft — let refresh replace DOM naturally to avoid blink
          handleChatResult(result)
        },
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

  // Field-level submit — targets a specific editable field
  const handleFieldSubmit = useCallback((message: string) => {
    if (!activeField) return
    setFieldLoading(true)

    // Show shimmer effect on the field being edited
    applyAiFieldLoading(activeField.blockId, activeField.editablePath, true)

    const payload: ChatRequestPayload = {
      session: config.session,
      siteId: config.siteId,
      slug,
      message,
      modelKey,
      provider,
      activeBlockId: activeField.blockId,
      activeBlockType: activeField.blockType,
      activeEditablePath: activeField.editablePath,
      componentsManifest: manifest,
      ...(siteContext ? {
        sitePurpose: siteContext.purpose,
        businessContext: { purpose: siteContext.purpose, tone: siteContext.tone, constraints: siteContext.constraints },
        siteContext: { siteId: config.siteId, siteName: siteContext.siteName, purpose: siteContext.purpose, tone: siteContext.tone, constraints: siteContext.constraints },
      } : {}),
    }

    const { cancel } = submitChatStream(
      config.orchestratorUrl,
      payload,
      {
        onStatus: () => {},
        onOpApplied: () => {
          // Don't refresh on each op — wait for final to avoid flickering
        },
        onFieldDraft: (event) => {
          // Transition from shimmer → live text as AI streams
          applyAiFieldLoading("", "", false)
          renderLiveDraft(event.blockId, event.value, true, { [event.editablePath]: event.value })
        },
        onFinal: (result) => {
          setFieldLoading(false)
          setActiveField(null)
          applyAiFieldLoading("", "", false)
          // Don't clear live draft here — let the refresh replace the DOM
          // so the streamed text stays visible until the server content loads.
          // The refresh will naturally overwrite the live-draft nodes.
          if (result.focusBlockId) focusBlock(result.focusBlockId)
          triggerRefresh(result.focusBlockId)
        },
        onError: (result) => {
          setFieldLoading(false)
          applyAiFieldLoading("", "", false)
          renderLiveDraft("", "", false)
          if (result.summary?.toLowerCase().includes("unauthorized") || result.error?.toLowerCase().includes("unauthorized")) {
            sessionStorage.removeItem("iw-authed")
            setAuthenticated(false)
          }
        },
      },
      accessToken,
    )

    cancelRef.current = cancel
  }, [activeField, config, slug, modelKey, provider, manifest, siteContext, accessToken, focusBlock, renderLiveDraft, triggerRefresh])

  const handleTextSelectionAskAI = useCallback((ctx: TextSelectionContext) => {
    clearSelection()
    setSelectedBlock({ blockId: ctx.blockId, blockType: ctx.blockType, editablePath: ctx.editablePath })
    setPanelOpen(true)
  }, [clearSelection])

  const selectedBlockLabel = selectedBlock.blockType
    ? `${selectedBlock.blockType}${selectedBlock.editablePath ? ` > ${selectedBlock.editablePath}` : ""}`
    : null

  // Need a mounted flag for the portal — document.body doesn't exist during SSR
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  if (!mounted) return null

  const ui = (
    <div data-editor-widget-ignore="">
      {/* Inline field prompt — shown when a text element is clicked */}
      {activeField && !panelOpen && (
        <InlineFieldPrompt
          field={activeField}
          isLoading={fieldLoading}
          onSubmit={handleFieldSubmit}
          onClose={() => setActiveField(null)}
        />
      )}

      {/* Text selection toolbar */}
      {textSelection && !panelOpen && !activeField && (
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
          onClose={() => { setPanelOpen(false); setPanelQuickActions(undefined) }}
          quickActions={panelQuickActions}
          selectedBlockLabel={selectedBlockLabel}
        />
      )}

      {/* FAB */}
      <ChatFab
        open={panelOpen}
        onClick={() => {
          setPanelOpen((prev) => !prev)
          if (panelOpen) setPanelQuickActions(undefined)
        }}
      />
    </div>
  )

  // Portal to document.body to escape stacking contexts
  return createPortal(ui, document.body)
}
