import type { FastifyInstance } from "fastify"
import type { RouteContext } from "./route-context.js"
import type { ToolManifest } from "../tools/types.js"

export async function toolsRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get("/tools", async (_request, reply) => {
    return reply.code(200).send({ tools: ctx.toolRuntime.registry.listManifests() })
  })

  app.post("/tools/register", async (request, reply) => {
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
