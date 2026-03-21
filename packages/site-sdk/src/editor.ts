// Editor UI components
export { EditorOverlay } from "./editor-overlay.tsx"

// Editor query param utilities
export { buildEditorQuerySuffix } from "./editor-query.ts"

// Block wrapper props for preview mode
export function getPreviewWrapperProps(editorMode: boolean, blockId: string, blockType: string) {
  if (!editorMode) return {}

  return {
    "data-block-id": blockId,
    "data-block-type": blockType,
    className: "editor-selectable",
    style: { viewTransitionName: `block-${blockId}` }
  } as const
}

// Block rendering helper
export { renderBlocks } from "./render-blocks.tsx"

// Editor CORS utilities
export { getEditorCorsOrigins, applyEditorCors, createEditorCorsOptionsHandler } from "./editor-cors.ts"
