import { draftMode } from "next/headers"

export type ContentSource = "published" | "draft"

/**
 * Minimal source selector for embedded mode.
 * Keep this close to your page/data loader layer.
 */
export async function resolveContentSource(): Promise<ContentSource> {
  const state = await draftMode()
  return state.isEnabled ? "draft" : "published"
}

