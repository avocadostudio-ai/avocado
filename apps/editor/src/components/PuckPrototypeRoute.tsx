import { PuckChatPrototype, type PuckHostApi } from "@ai-site-editor/editor-puck"
import { ChatComposerCore } from "./ChatSurface"
import { ImagePickerModal } from "./ImagePickerModal"
import { useChatEngine } from "../hooks/useChatEngine"
import { usePublish } from "../hooks/usePublish"
import { useEditorStore } from "../store"
import { useMediaInput } from "../hooks/useMediaInput"
import { renderFinalMarkdown, renderSimpleMarkdown } from "../lib/markdown-renderer"
import {
  LEGACY_AVOCADO_SITE_ID,
  LEGACY_AVOCADO_SITE_NAME,
  loadSiteListFromStorage,
  orchestrator,
  resolveDefaultModelKey,
  resolveDefaultProvider,
  resolveEditorSiteId,
  sanitizeSiteId,
  siteNameFromId,
  siteOrigin,
  slugLabel,
} from "../lib/editor-utils"

const puckHostApi: PuckHostApi = {
  LEGACY_AVOCADO_SITE_ID,
  LEGACY_AVOCADO_SITE_NAME,
  loadSiteListFromStorage,
  resolveDefaultModelKey,
  resolveDefaultProvider,
  siteNameFromId,
  siteOrigin,
  slugLabel,
  resolveEditorSiteId,
  sanitizeSiteId,
  orchestrator,
  usePublish: (session: string, siteId: string, isLoading: boolean) => {
    const pushAssistantFromResult = useEditorStore((s) => s.pushAssistantFromResult)
    return usePublish(session, siteId, isLoading, pushAssistantFromResult, siteOrigin)
  },
  useChatEngine: (args: any) => {
    const actions = useChatEngine(args)
    const chatLog = useEditorStore((s) => s.chatLog)
    const isLoading = useEditorStore((s) => s.isLoading)
    const streamStatus = useEditorStore((s) => s.streamStatus)
    const streamingText = useEditorStore((s) => s.streamingText)
    const streamSteps = useEditorStore((s) => s.streamSteps)
    const streamingChanges = useEditorStore((s) => s.streamingChanges)
    return { ...actions, chatLog, isLoading, streamStatus, streamingText, streamSteps, streamingChanges }
  },
  ImagePickerModal,
  ChatComposerCore,
  useMediaInput,
  renderFinalMarkdown,
  renderSimpleMarkdown,
  agentModeEnabled: false, // Detected from /status/planner at runtime
}

export function PuckPrototypeRoute() {
  return <PuckChatPrototype host={puckHostApi} />
}
