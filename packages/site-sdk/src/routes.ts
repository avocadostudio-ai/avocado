// Draft route handler factories
export { createDraftEnableHandler, createDraftDisableHandler } from "./draft-routes.ts"

// Editor route handler factories
export { createBlocksHandler, createPagesHandler } from "./editor-routes.ts"

// Catch-all editor API handler
export { createEditorApiHandler } from "./editor-api-handler.ts"
export type { EditorApiHandlerConfig } from "./editor-api-handler.ts"
