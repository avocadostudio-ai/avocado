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
import { AddBlockFab } from "./components/AddBlockFab"
import { InlineFieldPrompt, type FieldContext } from "./components/InlineFieldPrompt"
import { InlineBlockPicker, type AddBlockContext } from "./components/InlineBlockPicker"
import { TextSelectionToolbar } from "./components/TextSelectionToolbar"
import { useBlockSelection, type BlockSelectionState } from "./hooks/useBlockSelection"
import { useTextSelection, type TextSelectionContext } from "./hooks/useTextSelection"
import { useUndoHistory } from "./hooks/useUndoHistory"
import { findBlockNode, findEditableNode, supportsInlineEditablePath, applyAiFieldLoading } from "@ai-site-editor/preview-adapter"
import { submitChatStream, applyOps, type ChatResult, type ChatRequestPayload } from "./lib/widget-transport"
import { loadChatHistory, saveChatHistory, nextEntryId, type WidgetChatEntry, type WidgetConfig } from "./lib/widget-state"
import type { BlockManifest } from "@ai-site-editor/shared"
import { defaultPropsForType } from "@ai-site-editor/shared"

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
  /** When true, restrict the MVP to text-first blocks and route text selections to the field prompt. */
  textOnly?: boolean
}

const TEXT_ONLY_BLOCK_TYPES = ["Hero", "FeatureGrid", "Testimonials", "FAQAccordion", "CTA", "RichText"]

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
  textOnly = false,
}: ImmersiveWidgetProps) {
  const allowedBlockTypes = textOnly ? TEXT_ONLY_BLOCK_TYPES : undefined
  const [panelOpen, setPanelOpen] = useState(false)
  const [blockPickerContext, setBlockPickerContext] = useState<AddBlockContext | null>(null)
  const [activeField, setActiveField] = useState<FieldContext | null>(null)
  const [fieldLoading, setFieldLoading] = useState(false)
  // TODO: password gate is temporarily bypassed in immersive mode. Restore by wiring
  // PasswordGate back in (render it when !authenticated) once we settle on the auth story.
  const authenticated = true
  const [chatLog, setChatLog] = useState<WidgetChatEntry[]>(() =>
    loadChatHistory(config.session, config.siteId)
  )
  const [isLoading, setIsLoading] = useState(false)
  const [streamStatus, setStreamStatus] = useState<string | null>(null)
  const [selectedBlock, setSelectedBlock] = useState<BlockSelectionState>({ blockId: null, blockType: null, editablePath: null })
  const [editCounter, setEditCounter] = useState(0)
  const cancelRef = useRef<(() => void) | null>(null)

  // Undo/redo — proxies to orchestrator /history/{undo,redo}
  const undoHistory = useUndoHistory({
    orchestratorUrl: config.orchestratorUrl,
    session: config.session,
    siteId: config.siteId,
    slug,
    onChanged: refresh,
    onNavigate: navigate,
    onStatus: setStreamStatus,
    refreshKey: editCounter,
  })

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
    }).then((result) => {
      if (!result.ok) {
        console.error("[immersive] /ops failed:", result.error)
        return
      }
      setTimeout(() => refresh(), 100)
      setEditCounter((n) => n + 1)
    })
  }, [config, refresh])

  const { focusBlock, renderLiveDraft, discardLiveDraftOriginals, triggerRefresh } = useBlockSelection({
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
    onBlockAddRequested: useCallback((p: { slug: string; afterBlockId?: string; beforeBlockId?: string }) => {
      setActiveField(null)
      // Top + has beforeBlockId set, bottom + has afterBlockId set
      const isTop = !!p.beforeBlockId && !p.afterBlockId
      const addBtn = document.querySelector<HTMLElement>(isTop ? ".editor-selected-add-top" : ".editor-selected-add-bottom")
      if (!addBtn) return
      setBlockPickerContext({ slug: p.slug, afterBlockId: p.afterBlockId, beforeBlockId: p.beforeBlockId, anchorElement: addBtn })
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

  // Keyboard shortcuts: Cmd+K (open chat), Cmd+Z (undo), Cmd+Shift+Z / Cmd+Y (redo)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (e.key === "k") {
        e.preventDefault()
        setActiveField(null)
        setBlockPickerContext(null)
        setPanelOpen(true)
      } else if (e.key === "z" && !e.shiftKey) {
        if (!undoHistory.canUndo || undoHistory.isBusy) return
        e.preventDefault()
        void undoHistory.undo()
      } else if ((e.key === "z" && e.shiftKey) || e.key === "y") {
        if (!undoHistory.canRedo || undoHistory.isBusy) return
        e.preventDefault()
        void undoHistory.redo()
      }
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [undoHistory.canUndo, undoHistory.canRedo, undoHistory.isBusy, undoHistory.undo, undoHistory.redo])

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
    setEditCounter((n) => n + 1)
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
          discardLiveDraftOriginals()
          handleChatResult(result)
        },
        onError: (result) => {
          setIsLoading(false)
          setStreamStatus(null)
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
          discardLiveDraftOriginals()
          if (result.focusBlockId) focusBlock(result.focusBlockId)
          triggerRefresh(result.focusBlockId)
          setEditCounter((n) => n + 1)
        },
        onError: (result) => {
          setFieldLoading(false)
          applyAiFieldLoading("", "", false)
          renderLiveDraft("", "", false)
        },
      },
      accessToken,
    )

    cancelRef.current = cancel
  }, [activeField, config, slug, modelKey, provider, manifest, siteContext, accessToken, focusBlock, renderLiveDraft, triggerRefresh])

  const handleTextSelectionAskAI = useCallback((ctx: TextSelectionContext) => {
    clearSelection()
    setSelectedBlock({ blockId: ctx.blockId, blockType: ctx.blockType, editablePath: ctx.editablePath })

    // In text-only mode, route selection to the inline field prompt (with the excerpt pre-filled)
    // when the field supports inline editing. Fallback to chat panel otherwise.
    if (textOnly && supportsInlineEditablePath(ctx.editablePath)) {
      const blockNode = findBlockNode(ctx.blockId)
      const fieldNode = blockNode ? findEditableNode(blockNode, ctx.editablePath) : null
      if (fieldNode) {
        setPanelOpen(false)
        setActiveField({
          blockId: ctx.blockId,
          blockType: ctx.blockType,
          editablePath: ctx.editablePath,
          element: fieldNode,
          selectedText: ctx.selectedText,
        })
        return
      }
    }

    setPanelOpen(true)
  }, [clearSelection, textOnly])

  const selectedBlockLabel = selectedBlock.blockType
    ? `${selectedBlock.blockType}${selectedBlock.editablePath ? ` > ${selectedBlock.editablePath}` : ""}`
    : null

  // Need a mounted flag for the portal — document.body doesn't exist during SSR
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  const addBlockFabRef = useRef<HTMLButtonElement | null>(null)
  const handleAddBlockFabClick = useCallback(() => {
    if (!addBlockFabRef.current) return
    // Insert after the last block currently on the page (DOM order).
    const blocks = Array.from(document.querySelectorAll<HTMLElement>("[data-block-id]"))
    const lastId = blocks.length > 0 ? blocks[blocks.length - 1].getAttribute("data-block-id") ?? undefined : undefined
    setActiveField(null)
    setPanelOpen(false)
    setBlockPickerContext({
      slug,
      afterBlockId: lastId,
      anchorElement: addBlockFabRef.current,
    })
  }, [slug])

  if (!mounted) return null

  const ui = (
    <div data-editor-widget-ignore="">
      {/* Inline block picker — shown when + button (inline or FAB) is clicked */}
      {blockPickerContext && (
        <InlineBlockPicker
          context={blockPickerContext}
          allowedTypes={allowedBlockTypes}
          placement={blockPickerContext.anchorElement === addBlockFabRef.current ? "above" : "below"}
          onAdd={(blockType) => {
            const ctx = blockPickerContext
            setBlockPickerContext(null)
            const safeType = blockType.toLowerCase().replace(/[^a-z0-9]+/g, "_")
            const blockId = `b_${safeType}_${Date.now()}_${Math.floor(Math.random() * 1000)}`
            const op: Record<string, unknown> = {
              op: "add_block",
              pageSlug: ctx.slug,
              block: { id: blockId, type: blockType, props: defaultPropsForType(blockType as any) },
            }
            if (ctx.afterBlockId) op.afterBlockId = ctx.afterBlockId
            applyOp(op)
          }}
          onClose={() => setBlockPickerContext(null)}
        />
      )}

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

      {/* Chat panel (password gate is currently bypassed in immersive mode) */}
      {panelOpen && authenticated && (
        <ChatPanel
          chatLog={chatLog}
          isLoading={isLoading}
          streamStatus={streamStatus}
          onSubmit={handleSubmit}
          onClose={() => setPanelOpen(false)}
          selectedBlockLabel={selectedBlockLabel}
          canUndo={undoHistory.canUndo}
          canRedo={undoHistory.canRedo}
          onUndo={undoHistory.undo}
          onRedo={undoHistory.redo}
        />
      )}

      {/* Add-block pill — hidden when the chat panel is open to avoid overlap */}
      {!panelOpen && (
        <AddBlockFab ref={addBlockFabRef} onClick={handleAddBlockFabClick} />
      )}

      {/* FAB */}
      <ChatFab
        open={panelOpen}
        onClick={() => setPanelOpen((prev) => !prev)}
      />
    </div>
  )

  // Portal to document.body to escape stacking contexts
  return createPortal(ui, document.body)
}
