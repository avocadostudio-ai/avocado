import { createHash } from "node:crypto"
import type { FastifyInstance } from "fastify"

const ACCESS_PASSWORD_HASH = process.env.ACCESS_PASSWORD_HASH?.trim()

export async function authRoutes(app: FastifyInstance) {
  app.get("/auth/status", async () => ({
    gateEnabled: Boolean(ACCESS_PASSWORD_HASH),
  }))

  app.post("/auth/verify", async (request, reply) => {
    if (!ACCESS_PASSWORD_HASH) {
      return { ok: true }
    }

    const { password } = request.body as { password?: string }
    if (!password) {
      return reply.code(400).send({ error: "password is required" })
    }

    const hash = createHash("sha256").update(password).digest("hex")
    if (hash === ACCESS_PASSWORD_HASH) {
      return { ok: true }
    }

    return reply.code(401).send({ error: "incorrect password" })
  })
}
