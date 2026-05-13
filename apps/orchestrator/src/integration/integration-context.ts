import { blockManifestSchema, type BlockManifest } from "@avocadostudio-ai/shared"
import { z } from "zod"

export const siteCapabilitiesSchema = z.object({
  allowStructuralEdits: z.boolean(),
  manifestStatus: z.enum(["loading", "ready", "degraded"]),
  reason: z.string().optional(),
  manifestVersion: z.number().int().positive().optional(),
  blockCount: z.number().int().nonnegative().optional(),
  checkedAt: z.string()
})

export type SiteCapabilities = z.infer<typeof siteCapabilitiesSchema>

type IntegrationContextInput = {
  componentsManifest?: BlockManifest | string
  siteCapabilities?: SiteCapabilities | string
}

type IntegrationContextParseResult =
  | {
      ok: true
      data: {
        componentsManifest?: BlockManifest
        siteCapabilities?: SiteCapabilities
      }
    }
  | {
      ok: false
      error: "invalid componentsManifest payload" | "invalid siteCapabilities payload"
    }

function parsePossiblyJsonString(value: unknown) {
  if (!value) return undefined
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return "__invalid_json__" as const
  }
}

export function parseIntegrationContext(input: IntegrationContextInput): IntegrationContextParseResult {
  const manifestPayload = parsePossiblyJsonString(input.componentsManifest)
  const parsedManifest =
    manifestPayload === "__invalid_json__"
      ? { success: false as const }
      : manifestPayload
        ? blockManifestSchema.safeParse(manifestPayload)
        : { success: true as const, data: undefined }
  if (!parsedManifest.success) {
    return { ok: false, error: "invalid componentsManifest payload" }
  }

  const capabilitiesPayload = parsePossiblyJsonString(input.siteCapabilities)
  const parsedCapabilities =
    capabilitiesPayload === "__invalid_json__"
      ? { success: false as const }
      : capabilitiesPayload
        ? siteCapabilitiesSchema.safeParse(capabilitiesPayload)
        : { success: true as const, data: undefined }
  if (!parsedCapabilities.success) {
    return { ok: false, error: "invalid siteCapabilities payload" }
  }

  return {
    ok: true,
    data: {
      componentsManifest: parsedManifest.data,
      siteCapabilities: parsedCapabilities.data
    }
  }
}
