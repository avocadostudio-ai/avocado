import type { PublishTracker } from "../../state/session-state.js"
import { normalizeSiteId, isLegacySiteId } from "../../state/session-state.js"
import { collectInlineAssets, recordPublishSnapshot } from "../publish-helpers.js"
import type { PublishContext, PublishOutcome, PublishTarget } from "../publish-target.js"

/**
 * Publish by POSTing to the site's `/api/editor/publish` contract endpoint.
 *
 * This is the primary production flow: the remote site implements the publish
 * contract from `@ai-site-editor/site-sdk`, receives pages + siteConfig +
 * inline image assets, and writes them wherever it stores content (CMS, json
 * file, database, etc.). The orchestrator does not touch the site's storage.
 *
 * For the legacy `avocado-stories` siteId this target also records a git
 * snapshot into `apps/site/lib/published-content.json` so version history can
 * find it. Non-legacy sites skip the snapshot — their publish handler owns
 * durability.
 */
export class SiteContractPublishTarget implements PublishTarget {
  readonly name = "site-contract"

  canHandle(ctx: PublishContext): boolean {
    return typeof ctx.siteOrigin === "string" && ctx.siteOrigin.length > 0
  }

  async publish(ctx: PublishContext): Promise<PublishOutcome> {
    const { session, scopedSession, siteId, siteOrigin, pages, slugs, siteConfig, generatedImageDir, logger } = ctx
    if (!siteOrigin) {
      return failed(session, slugs, 400, "siteOrigin is required for site-contract target")
    }

    const assets = await collectInlineAssets(pages, generatedImageDir)
    const publishTokenValue = process.env.PUBLISH_TOKEN?.trim()

    let siteRes: Response
    try {
      siteRes = await fetch(`${siteOrigin}/api/editor/publish`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(publishTokenValue ? { "x-publish-token": publishTokenValue } : {})
        },
        body: JSON.stringify({
          pages,
          siteConfig,
          session: scopedSession,
          publishedAt: new Date().toISOString(),
          ...(Object.keys(assets).length > 0 ? { assets } : {})
        })
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : "fetch failed"
      return failed(session, slugs, 502, `Site unreachable at ${siteOrigin}/api/editor/publish: ${detail}`)
    }

    if (siteRes.status === 404) {
      return failed(
        session,
        slugs,
        400,
        `Site does not implement the publish contract. POST ${siteOrigin}/api/editor/publish returned 404.`
      )
    }

    const siteResult = (await siteRes.json()) as { ok?: boolean; slugs?: string[]; error?: string }
    const ok = siteRes.ok && siteResult.ok !== false
    const now = new Date().toISOString()

    const tracker: PublishTracker = {
      session,
      status: ok ? "triggered" : "failed",
      startedAt: now,
      updatedAt: now,
      slugs,
      vercelState: ok ? "READY" : "ERROR",
      deployResponse: "site_contract",
      deployStatus: siteRes.status
    }

    if (!ok) {
      return {
        ok: false,
        httpStatus: 400,
        tracker,
        response: {
          status: "failed",
          session,
          slugs,
          reason: siteResult.error ?? "site publish failed"
        }
      }
    }

    // Record snapshot in git only for the default site (json-file based).
    // CMS sites (sanity, contentful, strapi) publish to their CMS directly;
    // writing their pages to apps/site/lib/published-content.json would
    // overwrite the avocado-stories content.
    const snapshotCommit = isLegacySiteId(normalizeSiteId(siteId))
      ? await recordPublishSnapshot(scopedSession, pages, logger, siteConfig)
      : undefined

    const publishedSlugs = siteResult.slugs ?? slugs
    const pageNames = publishedSlugs.map((s) => (s === "/" ? "Home" : s.replace(/^\//, "")))

    return {
      ok: true,
      httpStatus: 200,
      tracker,
      response: {
        status: "ready" as const,
        session,
        slugs: publishedSlugs,
        vercelState: "READY",
        commitSha: snapshotCommit?.slice(0, 12),
        message: `Published ${pageNames.join(", ")} to site.`
      }
    }
  }
}

function failed(session: string, slugs: string[], httpStatus: number, reason: string): PublishOutcome {
  const now = new Date().toISOString()
  return {
    ok: false,
    httpStatus,
    tracker: {
      session,
      status: "failed",
      startedAt: now,
      updatedAt: now,
      slugs,
      vercelState: "ERROR",
      deployResponse: "site_contract",
      deployStatus: httpStatus
    },
    response: {
      status: "failed",
      session,
      slugs,
      reason
    }
  }
}
