// Backward-compatible re-exports — all public API preserved.
// New code should import from the focused modules directly.

export {
  SITE_LIST_STORAGE_KEY,
  DEFAULT_SITE_HOSTING,
  LEGACY_AVOCADO_SITE_ID,
  LEGACY_AVOCADO_SITE_NAME,
  LEGACY_AVOCADO_SITE_PURPOSE,
  isSiteIdLocked,
  AUTO_SITE_PRESETS,
  siteNameFromId,
  resolveEditorSiteId,
  resolveEditorPreviewUrl,
  defaultSiteList,
  loadSiteListFromStorage
} from "./site-presets"

export {
  resolveOrigin,
  siteOrigin,
  orchestrator,
  publishToken,
  enablePatchTransport,
  siteDraftSecret,
  buildSitePathWithQuery,
  resolveSiteOrigin,
  buildSiteDraftEnableUrl,
  buildSiteDraftDisableUrl
} from "./site-urls"

export {
  sanitizeSiteId,
  slugLabel,
  extensionFromMimeType,
  isVariationRequest,
  isComplexTaskRequest,
  normalizeComparableText,
  comparableTokens,
  isRedundantChangeLine
} from "./validators"

export {
  AI_JUSTIFICATION_PREFIX,
  AI_PERFORMANCE_PREFIX,
  DEBUG_MODE_STORAGE_KEY,
  MODEL_KEY_STORAGE_KEY,
  PROVIDER_STORAGE_KEY,
  CHAT_THEME_STORAGE_KEY,
  DEV_OPTIONS_STORAGE_KEY,
  previewPresetWidths,
  createId,
  resolveDefaultDebugMode,
  resolveDefaultModelKey,
  resolveDefaultProvider,
  resolveDefaultChatDarkMode,
  resolveAnchoredComposerEnabled,
  resolveDevOptionsEnabled,
  mergedVariationProps,
  splitAiInsightChanges
} from "./defaults"
