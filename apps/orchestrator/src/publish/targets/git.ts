import type { PublishTracker } from "../../state/session-state.js"
import { publishViaGit } from "../publish-helpers.js"
import type { PublishContext, PublishOutcome, PublishTarget } from "../publish-target.js"

/**
 * Publish by committing `apps/site/lib/published-content.json` and pushing
 * to the configured remote branch. Works standalone or with a Vercel project
 * wired to that branch for auto-deploy.
 *
 * Selected when no `siteOrigin` is supplied and `PUBLISH_MODE=git` (the
 * default). Honors `PUBLISH_GIT_BRANCH` and `PUBLISH_GIT_STRICT` env vars.
 */
export class GitPublishTarget implements PublishTarget {
  readonly name = "git"

  async publish(ctx: PublishContext): Promise<PublishOutcome> {
    const { session, scopedSession, slugs } = ctx
    const result = await publishViaGit(scopedSession)
    const now = new Date().toISOString()

    const tracker: PublishTracker = {
      session,
      status: result.status === "failed" ? "failed" : "triggered",
      startedAt: now,
      updatedAt: now,
      slugs: result.slugs,
      vercelState: result.status === "failed" ? "ERROR" : "READY",
      deployResponse: "git_publish",
      deployStatus: result.status === "failed" ? 500 : 200
    }

    if (result.status === "failed") {
      return {
        ok: false,
        httpStatus: 400,
        tracker,
        response: {
          status: "failed",
          session,
          slugs: result.slugs,
          reason: result.reason,
          details: result.details
        }
      }
    }

    return {
      ok: true,
      httpStatus: 200,
      tracker,
      response: {
        status: result.status,
        session,
        slugs: result.slugs,
        branch: result.branch,
        commitSha: "commitSha" in result ? result.commitSha : undefined,
        message: "message" in result ? result.message : undefined,
        vercelState: "vercelState" in result ? result.vercelState ?? "READY" : "READY"
      }
    }
  }
}
