import type { PageDoc, SiteConfig } from "@ai-site-editor/shared"
import type { PublishTarget, PublishResult, PublishStatus } from "./publish-target.js"
import { publishViaGit, refreshPublishStatusFromVercel } from "./publish-helpers.js"
import { publishStatusBySession } from "../state/session-state.js"

export class GitVercelPublishTarget implements PublishTarget {
  async publish(session: string, _pages: PageDoc[], _config: SiteConfig): Promise<PublishResult> {
    // publishViaGit reads pages from session state, so this delegates directly
    const result = await publishViaGit(session)
    const ok = result.status === "triggered" || result.status === "ready"
    const error = result.status === "failed" && "reason" in result
      ? String(result.reason)
      : undefined
    return {
      ok,
      slugs: result.slugs,
      error
    }
  }

  async getStatus(session: string): Promise<PublishStatus | null> {
    const tracker = publishStatusBySession.get(session)
    if (!tracker) return null
    const refreshed = await refreshPublishStatusFromVercel(tracker)
    return {
      status: refreshed.vercelState === "READY" ? "ready" : refreshed.status,
      deploymentId: refreshed.deploymentId,
      vercelState: refreshed.vercelState,
      inspectUrl: refreshed.inspectUrl,
      lastCheckError: refreshed.lastCheckError
    }
  }
}
