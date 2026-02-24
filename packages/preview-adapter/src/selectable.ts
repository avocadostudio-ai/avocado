export function getPreviewWrapperProps(editorMode: boolean, blockId: string, blockType: string) {
  if (!editorMode) return {}

  return {
    "data-block-id": blockId,
    "data-block-type": blockType,
    className: "editor-selectable"
  } as const
}
