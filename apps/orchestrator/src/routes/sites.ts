/**
 * Sites HTTP API.
 *
 * Endpoints exposed for the bin script (`@ai-site-editor/site-sdk register`)
 * and any external coding agent that wants to register a site without going
 * through the editor UI or the MCP tool surface.
 *
 *   POST /sites/register   — register a new site config
 *   GET  /sites             — list all known sites (used by the editor on mount
 *                              to populate its dashboard)
 */

import type { FastifyInstance } from "fastify"
import { siteConfigSchema, type SiteConfig } from "@ai-site-editor/shared"
import {
  DEFAULT_SESSION,
  getSiteConfig,
  listSitesForSession,
  scopedSessionKey,
  setSiteConfig,
  siteConfigs,
  schedulePersistState,
} from "../state/session-state.js"
import type { RouteContext } from "./route-context.js"

type RegisterBody = {
  siteId?: string
  name?: string
  session?: string
  previewUrl?: string
  port?: number
  purpose?: string
  /** The DRAFT_MODE_SECRET written into the site's .env.local. */
  secret?: string
  /** Free-form extras the editor can store on the site config. */
  config?: Record<string, unknown>
}

type SiteConfigExtras = Record<string, unknown>

export async function sitesRoutes(app: FastifyInstance, _ctx: RouteContext) {
  app.post("/sites/register", async (request, reply) => {
    const body = (request.body ?? {}) as RegisterBody

    if (!body.siteId || typeof body.siteId !== "string") {
      return reply.code(400).send({ error: "siteId is required" })
    }
    if (!body.name || typeof body.name !== "string") {
      return reply.code(400).send({ error: "name is required" })
    }

    const session = scopedSessionKey(body.session ?? DEFAULT_SESSION, body.siteId)

    // Validate the known SiteConfig fields strictly. Anything else (purpose,
    // previewUrl, port, free-form extras) merges in unvalidated as `extras`.
    const parsed = siteConfigSchema.safeParse(body.config ?? {})
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid config", details: parsed.error.issues })
    }

    const extras: SiteConfigExtras = { name: body.name }
    if (body.purpose) extras.purpose = body.purpose
    if (body.previewUrl) extras.previewUrl = body.previewUrl
    if (typeof body.port === "number") {
      extras.port = body.port
      if (!body.previewUrl) extras.previewUrl = `http://localhost:${body.port}`
    }

    const merged = { ...parsed.data, ...extras } as SiteConfig

    // No-op guard: skip the write (and the debounced full-state persist) when
    // the registered config is byte-identical to what we already have. Repeat
    // registrations from the bin script are common and shouldn't churn disk.
    const existing = getSiteConfig(session)
    const unchanged = JSON.stringify(existing) === JSON.stringify(merged)

    if (!unchanged) {
      setSiteConfig(session, merged)
      schedulePersistState(app.log)
    }

    // Surface DRAFT_MODE_SECRET mismatches as warnings — the BYO-agent CLI
    // flags them to the user, but registration still succeeds.
    const warnings: string[] = []
    const expectedSecret = process.env.DRAFT_MODE_SECRET
    if (body.secret && expectedSecret && body.secret !== expectedSecret) {
      warnings.push(
        "DRAFT_MODE_SECRET mismatch: the secret in your site's .env.local does not match the orchestrator's DRAFT_MODE_SECRET. " +
          "The editor's iframe draft-mode flow will fail until you align them — set the same value in apps/editor/.env (VITE_SITE_DRAFT_SECRET) and rebuild the editor."
      )
    } else if (body.secret && !expectedSecret) {
      warnings.push(
        "Orchestrator has no DRAFT_MODE_SECRET set in its environment. The editor's iframe draft-mode flow may not work — set DRAFT_MODE_SECRET on the orchestrator and VITE_SITE_DRAFT_SECRET on the editor to the same value as your site's .env.local."
      )
    }

    return {
      status: unchanged ? "unchanged" : "registered",
      siteId: body.siteId,
      session,
      config: { id: body.siteId, ...merged },
      warnings,
    }
  })

  /**
   * The editor calls this on mount to discover sites registered by external
   * tooling (the bin script, an external coding agent, a CI job).
   */
  app.get("/sites", async (request) => {
    const query = request.query as { session?: string }
    const wantedSession = (query.session ?? DEFAULT_SESSION).trim() || DEFAULT_SESSION
    return { sites: listSitesForSession(wantedSession) }
  })

  /** Admin: remove site configs by key pattern or previewUrl filter. */
  app.delete("/sites", async (request) => {
    const query = request.query as { filter?: string; key?: string }
    const removed: string[] = []
    for (const [key, config] of siteConfigs.entries()) {
      if (query.key && key.includes(query.key)) {
        siteConfigs.delete(key)
        removed.push(key)
      } else if (query.filter) {
        const url = (config as Record<string, unknown>).previewUrl
        if (typeof url === "string" && url.includes(query.filter)) {
          siteConfigs.delete(key)
          removed.push(key)
        }
      }
    }
    if (removed.length > 0) schedulePersistState(request.log)
    return { removed, remaining: siteConfigs.size }
  })
}
