export { getConfiguredDraftSecret, getSafeInternalRedirectPath, validateDraftSecret, type DraftSecretValidationResult } from "./draft-mode.ts"
export { isImagePath, toAltPath } from "./editable-path.ts"
export {
  editorComponentSchema,
  editorComponentsManifestSchema,
  jsonSchemaLikeSchema,
  validateByJsonSchemaLike,
  validateManifestDefaultProps,
  type EditorComponentDefinition,
  type EditorComponentsManifest
} from "./editor-components-manifest.ts"

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
  // Registry functions
  registerBlock,
  getBlockMeta,
  getAllBlockMeta,
  isFieldInlineEditable,
  getImageSpec,
  // Backwards-compatible exports
  blockSchemas,
  allowedBlockTypes,
  _registerBlockInternal,
  // Utility functions
  getPropDisplayName,
  defaultPropsForType,
  defaultListItemForBlock,
  resolveHeadingTag,
  DEFAULT_HEADING_LEVELS,
  // Schemas & validation
  blockInstanceSchema,
  validateBlockProps,
  getBlockJsonSchema,
} from "./blocks.ts"

export {
  // Types
  type PageMeta,
  type PageDoc,
  type Operation,
  type EditPlan,
  type PatchRejectReason,
  type ApplyPatchMessage,
  type PatchAckMessage,
  type ResetToServerMessage,
  // Schemas
  pageMetaSchema,
  pageDocSchema,
  operationSchema,
  editPlanSchema,
  // Demo data
  demoPublishedPages,
} from "./schemas.ts"
