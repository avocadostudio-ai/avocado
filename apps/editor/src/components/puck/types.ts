import type { Data } from "@puckeditor/core"
import type { ChatEntry } from "../../lib/editor-types"

export type PuckData = Data<Record<string, Record<string, unknown>>>

export type SelectionContext = {
  activeBlockId?: string
  activeBlockType?: string
  activeEditablePath?: string
}

export type PuckSelectionItem = {
  type?: unknown
  props?: Record<string, unknown>
}

export type PuckSelectionStore = {
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

export type PlannerFeatures = {
  googleDrive?: boolean
  unsplash?: boolean
  imageGenerate?: boolean
  imageGenerateChat?: boolean
}

export type ImagePickerTarget = {
  currentUrl?: string
  onSelect: (imageUrl: string) => void
}

export type PuckCustomFieldRenderProps = {
  value: unknown
  onChange: (value: string) => void
  readOnly?: boolean
}

export type ChatPanelProps = {
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
