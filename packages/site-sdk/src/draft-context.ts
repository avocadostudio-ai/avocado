import { draftMode, cookies } from "next/headers"
import type { SearchParamsRecord } from "./types.ts"
import type { DraftContext } from "./types.ts"
import { resolveDraftContextCore } from "./draft-context-core.ts"
import type { DraftModeAdapter } from "./draft-context-core.ts"

export function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

export async function resolveEditorContext(
  searchParams: SearchParamsRecord,
  options?: {
    defaultSession?: string
    defaultSiteId?: string
    defaultEditorOrigin?: string
  }
): Promise<DraftContext | null> {
  const jar = await cookies()
  const draft = await draftMode()

  const adapter: DraftModeAdapter = {
    isDraftMode: draft.isEnabled,
    getCookie: (name) => jar.get(name)?.value,
  }

  return resolveDraftContextCore(searchParams, adapter, options)
}
