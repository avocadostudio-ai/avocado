export { getConfiguredDraftSecret, getSafeInternalRedirectPath, validateDraftSecret, type DraftSecretValidationResult } from "./draft-mode.ts"
export type {
  FieldDiffKind,
  FieldDiff,
  BlockDiffStatus,
  BlockDiff,
  PageDiffStatus,
  PageDiff,
  PublishDiff,
} from "./publish-diff.ts"
export { isImagePath, toAltPath } from "./editable-path.ts"
export {
  blockDefinitionSchema,
  blockManifestSchema,
  jsonSchemaLikeSchema,
  validateByJsonSchemaLike,
  validateManifestDefaultProps,
  deriveFieldMetaFromSchema,
  type BlockDefinition,
  type BlockManifest
} from "./block-manifest.ts"

export {
  // Types
  type FieldKind,
  type ImageSpec,
  type FieldMeta,
  type ListFieldMeta,
  type BlockMeta,
  type BlockType,
  type BlockInstance,
  type BlockRegistration,
  // Constants & helpers
  IMAGE_PLACEHOLDER,
  isImagePlaceholder,
  // Registry functions
  registerBlock,
  getBlockMeta,
  getAllBlockMeta,
  getImageFields,
  getListImageFields,
  isFieldInlineEditable,
  getImageSpec,
  isChrome,
  getChromeTypes,
  // Backwards-compatible exports
  blockSchemas,
  allowedBlockTypes,
  // Utility functions
  getPropDisplayName,
  defaultListItemForBlock,
  // Schemas & validation
  blockInstanceSchema,
  blockInstanceSchemaLenient,
  validateBlockProps,
  getBlockJsonSchema,
} from "./blocks/_registry.ts"

export {
  defaultPropsForType,
  resolveHeadingTag,
  resolveItemHeadingTag,
  DEFAULT_HEADING_LEVELS,
} from "./blocks/index.ts"

export {
  blockTypeToCamel,
  camelToBlockType,
  blockTypeToLower,
  lowerToBlockType,
} from "./block-names.ts"

export {
  chatStreamEventSchema,
  parseChatStreamFrame,
  type ChatStreamEvent,
  type ChatStreamEventType,
  type ChatStreamFrame,
} from "./chat-events.ts"

export {
  // Types
  type PageMeta,
  type PageDoc,
  type SiteConfig,
  type Operation,
  type EditPlan,
  type PatchRejectReason,
  type ApplyPatchMessage,
  type PatchAckMessage,
  type ResetToServerMessage,
  // Schemas
  pageMetaSchema,
  pageDocSchema,
  pageDocSchemaLenient,
  siteConfigSchema,
  operationSchema,
  editPlanSchema,
  // Demo data
  demoPublishedPages,
} from "./schemas.ts"
