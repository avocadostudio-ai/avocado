// Draft route handler factories
export { createDraftEnableHandler, createDraftDisableHandler } from "./draft-routes.ts"

// Editor route handler factories
export { createBlocksHandler, createPagesHandler, createPublishHandler } from "./editor-routes.ts"
export type { OnPublishFn } from "./editor-routes.ts"

// Catch-all editor API handler
export { createEditorApiHandler } from "./editor-api-handler.ts"
export type { EditorApiHandlerConfig } from "./editor-api-handler.ts"
