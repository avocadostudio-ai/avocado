import type { PuckSelectionStore, SelectionContext } from "./types"

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

export function deriveSelectionContextFromPuck(
  puck: PuckSelectionStore | null | undefined
): SelectionContext | undefined {
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

export function formatSelectionSummary(selection?: SelectionContext): string {
  if (!selection) return "none"
  const parts: string[] = []
  if (selection.activeBlockType) parts.push(`type=${selection.activeBlockType}`)
  if (selection.activeBlockId) parts.push(`id=${selection.activeBlockId}`)
  if (selection.activeEditablePath) parts.push(`field=${selection.activeEditablePath}`)
  return parts.length > 0 ? parts.join(" | ") : "none"
}
