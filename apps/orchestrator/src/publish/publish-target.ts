import type { FastifyBaseLogger } from "fastify"
import type { PageDoc, SiteConfig } from "@avocadostudio-ai/shared"
import type { PublishTracker } from "../state/session-state.js"

/**
 * Publish targets are the plugin point for where a `POST /publish` call ends
 * up writing content. Built-ins cover git + Vercel, a site-contract POST, and
 * a raw Vercel deploy hook. Third parties (S3, GitLab Pages, custom CI, etc.)
 * implement {@link PublishTarget} and register via
 * {@link registerPublishTarget} from `./publish-target-registry.js`.
 *
 * The route handler's job shrinks to: build {@link PublishContext}, call
 * {@link selectPublishTarget}, invoke `target.publish(ctx)`, save the returned
 * tracker, and reply with `outcome.response` / `outcome.httpStatus`.
 */

/** Request context handed to every publish target. */
export type PublishContext = {
  /** Normalized unscoped session id (what the client sent). */
  session: string
  /** `session::siteId` key used for state lookups. */
  scopedSession: string
  /** Raw siteId from the request body (unnormalized). */
  siteId?: string
  /** Validated remote site origin, if the client supplied one. */
  siteOrigin?: string
  /** Draft pages for this session, in publish order. */
  pages: PageDoc[]
  /** Slugs of `pages`, precomputed for target convenience. */
  slugs: string[]
  /** Site config for this scoped session. */
  siteConfig: SiteConfig
  /** Path on disk where the orchestrator caches generated images. */
  generatedImageDir: string
  /** Fastify request logger. */
  logger: FastifyBaseLogger
}

/**
 * What a target returns to the route handler. The route does not interpret the
 * `response` body — it's passed straight through to the HTTP client.
 */
export type PublishOutcome = {
  ok: boolean
  /** HTTP status for the reply. 200 on success; 400/502 on failure. */
  httpStatus: number
  /** Tracker to persist in `publishStatusBySession`. */
  tracker: PublishTracker
  /** Body to send back as JSON. */
  response: Record<string, unknown>
}

/** Status row returned by GET /publish/status. */
export type PublishStatus = {
  status: "triggered" | "failed" | "ready"
  deploymentId?: string
  vercelState?: string
  inspectUrl?: string
  lastCheckError?: string
}

export interface PublishTarget {
  /** Stable identifier. Used by `PUBLISH_TARGET` env var and the registry. */
  readonly name: string
  /**
   * Optional selection hint. The registry calls this when deciding which
   * target handles a given request. Return `true` to claim the request.
   * If omitted, the target is only dispatched when explicitly selected by
   * name (e.g. via `PUBLISH_TARGET=<name>`).
   */
  canHandle?(ctx: PublishContext): boolean
  publish(ctx: PublishContext): Promise<PublishOutcome>
}

/**
 * @deprecated Kept for one release so downstream code importing
 * `PublishResult` from this module continues to compile. New code should use
 * {@link PublishOutcome}. Will be removed once all consumers migrate.
 */
export type PublishResult = {
  ok: boolean
  slugs: string[]
  deploymentId?: string
  deploymentUrl?: string
  inspectUrl?: string
  error?: string
}
