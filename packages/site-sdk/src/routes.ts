// Draft route handler factories
export { createDraftEnableHandler, createDraftDisableHandler } from "./draft-routes.ts"

// Editor route handler factories
export { createBlocksHandler, createPagesHandler, createPublishHandler } from "./editor-routes.ts"
export type { OnPublishFn, InlineAsset, PublishContext } from "./editor-routes.ts"

// Catch-all editor API handler
export { createEditorApiHandler } from "./editor-api-handler.ts"
export type { EditorApiHandlerConfig } from "./editor-api-handler.ts"

// Publish utilities (SSRF check, image resolution)
export { isSafeImageUrl, createImageResolver } from "./publish-utils.ts"
export type { ImageUploader } from "./publish-utils.ts"

// Revalidation handler factory
export { createRevalidateHandler } from "./revalidate-handler.ts"
export type { RevalidateHandlerConfig } from "./revalidate-handler.ts"

// Manifest utilities (derive image fields from block manifest)
export { getManifestImageFields } from "./manifest-utils.ts"
