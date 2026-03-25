import { buildBlockManifest } from "@ai-site-editor/site-sdk/editor-manifest"
import { getManifestImageFields } from "@ai-site-editor/site-sdk/routes"

export const { imageFields, listImageFields, listFieldNames } = getManifestImageFields(buildBlockManifest())
