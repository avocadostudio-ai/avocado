import type { CSSProperties, ReactNode } from "react"

export type ChatEntry = {
  id: string
  role: "user" | "assistant"
  text?: string
  suggestions?: string[]
  canUndo?: boolean
  wasUndone?: boolean
}

export type UseChatEngineResult = {
  chatLog: ChatEntry[]
  isLoading: boolean
  streamStatus: string | null
  streamingText: string | null
  streamSteps: { label: string; done: boolean }[]
  streamingChanges: string[]
  undoInFlightEntryId: string | null
  submitChat: (prompt: string) => Promise<void>
  cancelChat: () => Promise<void> | void
  applyUndoHistory: (entryId: string) => Promise<void>
  canUndoServer: boolean
  canRedoServer: boolean
  applyGlobalUndo: () => Promise<void>
  applyGlobalRedo: () => Promise<void>
}

export type VersionHistoryPanelProps = {
  session: string
  siteId: string
  slug: string
  visible: boolean
  onRestore?: (targetVersion: number) => void
  isRestoring?: boolean
}

export type MediaInputHandlers = {
  transcribeAudio: (blob: Blob, mimeType: string) => Promise<string>
  interpretPastedImage: (blob: Blob, mimeType: string) => Promise<string>
  uploadPastedImage: (blob: Blob, mimeType: string) => Promise<string>
}

export type ChatComposerCoreProps = {
  message: string
  isLoading: boolean
  hasUserEntry: boolean
  onMessageChange: (value: string) => void
  onSubmit: (explicitMessage?: string) => void
  onTranscribeAudio: (blob: Blob, mimeType: string) => Promise<string>
  onInterpretImage: (blob: Blob, mimeType: string) => Promise<string>
  onUploadImage: (blob: Blob, mimeType: string) => Promise<string>
  onCancel?: () => void
  onAutoHeightChange?: (height: number) => void
  selectionModeEnabled?: boolean
  onToggleSelectionMode?: () => void
  compact?: boolean
  className?: string
  style?: CSSProperties
}

export type ImagePickerModalProps = {
  open: boolean
  features: {
    googleDrive?: boolean
    unsplash?: boolean
    imageGenerate?: boolean
    imageGenerateChat?: boolean
  }
  currentUrl?: string
  gdriveFolderId?: string
  cmsMedia?: any
  siteOrigin: string
  onClose: () => void
  onSelect: (imageUrl: string) => void
}

export type SiteConfigLike = {
  id: string
  name: string
  purpose?: string
  hosting?: string
  vercelProjectId?: string
  vercelTeamId?: string
  vercelProductionUrl?: string
  vercelDeployHookUrl?: string
  tone?: string
  constraints?: string[]
  gdriveFolderId?: string
  cmsMedia?: unknown
}

export type UsePublishResult = {
  publishSite: () => Promise<void>
  isPublishing: boolean
  publishInProgress: boolean
  publishStatus: { inspectUrl?: string } | null
}

export type PuckHostApi = {
  LEGACY_AVOCADO_SITE_ID: string
  LEGACY_AVOCADO_SITE_NAME: string
  loadSiteListFromStorage: (siteId: string) => SiteConfigLike[]
  resolveDefaultModelKey: () => string
  resolveDefaultProvider: () => string
  siteNameFromId: (siteId: string) => string
  siteOrigin: string
  slugLabel: (slug: string) => string
  resolveEditorSiteId: () => string
  sanitizeSiteId: (raw: string) => string
  orchestrator: string
  useChatEngine: (args: any) => UseChatEngineResult
  usePublish: (session: string, siteId: string, isLoading: boolean) => UsePublishResult
  VersionHistoryPanel: (props: VersionHistoryPanelProps) => ReactNode
  restoreToVersion: (session: string, siteId: string, slug: string, targetVersion: number) => Promise<boolean>
  ImagePickerModal: (props: any) => ReactNode
  ChatComposerCore: (props: any) => ReactNode
  useMediaInput: () => MediaInputHandlers
  renderFinalMarkdown: (text: string) => ReactNode
  renderSimpleMarkdown: (text: string) => ReactNode
  agentModeEnabled?: boolean
}
