import type { FastifyInstance } from "fastify"
import type { RouteContext } from "./route-context.js"
import type { ToolManifest } from "../tools/types.js"

const TOOLS_ADMIN_SECRET = process.env.TOOLS_ADMIN_SECRET?.trim()

export async function toolsRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get("/tools", async (_request, reply) => {
    return reply.code(200).send({ tools: ctx.toolRuntime.registry.listManifests() })
  })

  app.post("/tools/register", async (request, reply) => {
    // Require admin secret when configured; reject all registrations otherwise in non-dev
    if (TOOLS_ADMIN_SECRET) {
      const provided = (request.headers["x-tools-admin-secret"] as string)?.trim()
      if (provided !== TOOLS_ADMIN_SECRET) {
        return reply.code(403).send({ error: "Invalid or missing x-tools-admin-secret header" })
      }
    } else if (process.env.NODE_ENV === "production") {
      return reply.code(403).send({ error: "Tool registration is disabled in production without TOOLS_ADMIN_SECRET" })
    }

    const body = request.body as {
      manifest?: ToolManifest
      endpoint?: string
      staticHeaders?: Record<string, string>
    }
    if (!body?.manifest || typeof body.endpoint !== "string") {
      return reply.code(400).send({ error: "manifest and endpoint are required" })
    }

    try {
      ctx.toolRuntime.registry.registerRemote({
        manifest: body.manifest,
        endpoint: body.endpoint,
        staticHeaders: body.staticHeaders
      })
      return reply.code(200).send({ status: "registered", tool: body.manifest.name })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return reply.code(400).send({ error: detail })
    }
  })
}
