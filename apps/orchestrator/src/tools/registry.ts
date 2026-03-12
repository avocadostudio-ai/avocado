import type { ToolManifest, RegisteredTool, ToolHandler, RemoteToolRegistration } from "./types.js"
import { validateToolManifestShape } from "./schema-validator.js"

function normalizeToolName(name: string) {
  return name.trim().toLowerCase()
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>()

  registerBuiltin(manifest: ToolManifest, handler: ToolHandler) {
    const valid = validateToolManifestShape(manifest)
    if (!valid.ok) throw new Error(valid.message)

    const key = normalizeToolName(manifest.name)
    this.tools.set(key, {
      manifest: { ...manifest, enabled: manifest.enabled ?? true },
      handler,
      source: "builtin"
    })
  }

  registerRemote(args: RemoteToolRegistration) {
    const valid = validateToolManifestShape(args.manifest)
    if (!valid.ok) throw new Error(valid.message)
    const endpoint = args.endpoint.trim()
    if (!/^https?:\/\//i.test(endpoint)) throw new Error("remote tool endpoint must be http(s)")

    const key = normalizeToolName(args.manifest.name)
    const handler: ToolHandler = async ({ input, context }) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(args.staticHeaders ?? {}),
          ...(context.authHeader ? { authorization: context.authHeader } : {})
        },
        body: JSON.stringify({
          toolName: args.manifest.name,
          arguments: input,
          context: {
            siteId: context.siteId,
            sessionId: context.sessionId,
            userId: context.userId,
            traceId: context.traceId,
            plannerProvider: context.plannerProvider
          }
        })
      })
      if (!response.ok) {
        const body = await response.text().catch(() => "")
        throw new Error(`Remote tool failed (${response.status}): ${body.slice(0, 200)}`)
      }
      const payload = (await response.json()) as { data?: unknown }
      return payload.data
    }

    this.tools.set(key, {
      manifest: { ...args.manifest, enabled: args.manifest.enabled ?? true },
      handler,
      source: "remote",
      endpoint,
      staticHeaders: args.staticHeaders
    })
  }

  getByName(name: string) {
    return this.tools.get(normalizeToolName(name))
  }

  listEnabled() {
    return Array.from(this.tools.values()).filter((tool) => tool.manifest.enabled !== false)
  }

  listManifests() {
    return this.listEnabled().map((entry) => ({
      ...entry.manifest,
      source: entry.source,
      endpoint: entry.endpoint
    }))
  }
}
