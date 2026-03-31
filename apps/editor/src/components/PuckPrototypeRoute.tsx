import { PuckChatPrototype, type PuckHostApi } from "@ai-site-editor/editor-puck"
import { ChatComposerCore } from "./ChatSurface"
import { ImagePickerModal } from "./ImagePickerModal"
import { useChatEngine } from "../hooks/useChatEngine"
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
  useChatEngine,
  ImagePickerModal,
  ChatComposerCore,
  useMediaInput,
  renderFinalMarkdown,
  renderSimpleMarkdown,
  agentApiKey: ((import.meta.env.VITE_AGENT_API_KEY as string | undefined)?.trim() ?? ""),
}

export function PuckPrototypeRoute() {
  return <PuckChatPrototype host={puckHostApi} />
}
