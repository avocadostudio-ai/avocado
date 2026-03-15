// Types
export type { PageDoc, PageMeta, BlockInstance, DraftContext, SearchParamsRecord } from "./types.ts"
export { pageDocSchema } from "./types.ts"

// Draft fetching
export { getOrchestratorUrl, fetchDraftPage, fetchDraftSlugs } from "./draft-fetch.ts"

// Draft context resolution
export { resolveDraftContext, isTileMode, single } from "./draft-context.ts"

// Draft route handler factories
export { createDraftEnableHandler, createDraftDisableHandler } from "./draft-routes.ts"

// Editor CORS utilities
export { getEditorCorsOrigins, applyEditorCors, createEditorCorsOptionsHandler } from "./editor-cors.ts"

// Editor query param utilities
export { buildEditorQuerySuffix, buildSlug } from "./editor-query.ts"

// Editor manifest & route factories
export {
  editorComponentSchema, editorComponentsManifestSchema,
  validateByJsonSchemaLike, validateManifestDefaultProps,
  buildComponentsManifest,
  type EditorComponentDefinition, type EditorComponentsManifest
} from "./editor-manifest.ts"
export { createComponentsHandler, createBootstrapPagesHandler } from "./editor-routes.ts"

// Block wrapper (re-export from preview-adapter for convenience)
export { getPreviewWrapperProps } from "@ai-site-editor/preview-adapter"

// UI components
export { TileModeStyles } from "./tile-mode.tsx"
export { BlockErrorBoundary } from "./block-error-boundary.tsx"
export { EditorOverlay } from "./editor-overlay.tsx"
