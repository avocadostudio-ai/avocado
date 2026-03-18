// ── Core (always needed) ──────────────────────────────────────────────
// Types
export type { PageDoc, PageMeta, BlockInstance, DraftContext, SearchParamsRecord } from "./types.ts"
export type { SiteConfig } from "@ai-site-editor/shared"
export { pageDocSchema } from "./types.ts"

// URL utilities
export { buildSlug } from "./editor-query.ts"
export { single } from "./draft-context.ts"

// ── Backwards-compat re-exports (deprecated — use subpath imports) ───

/** @deprecated Import from `@ai-site-editor/site-sdk/draft` */
export { getOrchestratorUrl, fetchDraftPage, fetchDraftSlugs, fetchDraftSiteConfig } from "./draft-fetch.ts"
/** @deprecated Import from `@ai-site-editor/site-sdk/draft` */
export { resolveDraftContext, isTileMode } from "./draft-context.ts"

/** @deprecated Import from `@ai-site-editor/site-sdk/routes` */
export { createDraftEnableHandler, createDraftDisableHandler } from "./draft-routes.ts"
/** @deprecated Import from `@ai-site-editor/site-sdk/routes` */
export { createComponentsHandler, createBootstrapPagesHandler } from "./editor-routes.ts"

/** @deprecated Import from `@ai-site-editor/site-sdk/editor` */
export { getEditorCorsOrigins, applyEditorCors, createEditorCorsOptionsHandler } from "./editor-cors.ts"
/** @deprecated Import from `@ai-site-editor/site-sdk/editor` */
export { buildEditorQuerySuffix } from "./editor-query.ts"
/** @deprecated Import from `@ai-site-editor/site-sdk/editor` */
export { getPreviewWrapperProps } from "@ai-site-editor/preview-adapter"
/** @deprecated Import from `@ai-site-editor/site-sdk/editor` */
export { TileModeStyles } from "./tile-mode.tsx"
/** @deprecated Import from `@ai-site-editor/site-sdk/editor` */
export { EditorOverlay } from "./editor-overlay.tsx"

/** @deprecated Import from `@ai-site-editor/blocks` */
export { BlockErrorBoundary } from "@ai-site-editor/blocks"
