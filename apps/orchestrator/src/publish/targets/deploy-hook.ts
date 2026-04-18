import type { PublishTracker } from "../../state/session-state.js"
import { toErrorDetail } from "../../ops/ops-engine.js"
import { firstUrlFromText } from "../../chat/chat-pipeline.js"
import { parseJsonMaybe } from "../../chat/variation-pipeline.js"
import { deploymentIdFromAny } from "../publish-helpers.js"
import type { PublishContext, PublishOutcome, PublishTarget } from "../publish-target.js"

/**
 * Publish by POSTing to a raw Vercel deploy hook URL. Useful when the
 * orchestrator runs outside the git repo (e.g. in a managed environment) and
 * cannot commit + push on its own.
 *
 * Selected when no `siteOrigin` is supplied and `PUBLISH_MODE=deploy_hook`.
 * Requires `VERCEL_DEPLOY_HOOK_URL` to be set.
 */
export class DeployHookPublishTarget implements PublishTarget {
  readonly name = "deploy-hook"

  async publish(ctx: PublishContext): Promise<PublishOutcome> {
    const { session, scopedSession, slugs } = ctx
    const deployHookUrl = process.env.VERCEL_DEPLOY_HOOK_URL?.trim()
    if (!deployHookUrl) {
      const now = new Date().toISOString()
      return {
        ok: false,
        httpStatus: 400,
        tracker: {
          session,
          status: "failed",
          startedAt: now,
          updatedAt: now,
          slugs,
          vercelState: "ERROR"
        },
        response: { error: "VERCEL_DEPLOY_HOOK_URL is not configured" }
      }
    }

    try {
      const hookResponse = await fetch(deployHookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "orchestrator",
          session: scopedSession,
          slugs,
          publishedAt: new Date().toISOString()
        })
      })

      const responseText = await hookResponse.text()
      const responseJson = parseJsonMaybe(responseText)
      const inspectUrl =
        findStringByKeys(responseJson, new Set(["inspectorUrl", "inspectUrl", "url"])) ?? firstUrlFromText(responseText)
      const deploymentId =
        findStringByKeys(responseJson, new Set(["deploymentId", "id"])) ??
        (inspectUrl ? deploymentIdFromAny(inspectUrl) : undefined) ??
        deploymentIdFromAny(responseText)
      const vercelStateRaw =
        findStringByKeys(responseJson, new Set(["state", "readyState", "status"])) ??
        (hookResponse.ok ? "TRIGGERED" : "FAILED")
      const vercelState = typeof vercelStateRaw === "string" ? vercelStateRaw.toUpperCase() : undefined
      const now = new Date().toISOString()

      const tracker: PublishTracker = {
        session,
        status: hookResponse.ok ? "triggered" : "failed",
        startedAt: now,
        updatedAt: now,
        slugs,
        deployStatus: hookResponse.status,
        deployResponse: responseText.slice(0, 500),
        inspectUrl,
        deploymentId,
        vercelState
      }

      return {
        ok: hookResponse.ok,
        httpStatus: 200,
        tracker,
        response: {
          status: hookResponse.ok ? "triggered" : "failed",
          session,
          slugs,
          deployStatus: hookResponse.status,
          deployResponse: responseText.slice(0, 500),
          inspectUrl,
          deploymentId,
          vercelState
        }
      }
    } catch (error) {
      const now = new Date().toISOString()
      return {
        ok: false,
        httpStatus: 502,
        tracker: {
          session,
          status: "failed",
          startedAt: now,
          updatedAt: now,
          slugs,
          vercelState: "ERROR"
        },
        response: { error: toErrorDetail(error) }
      }
    }
  }
}

function findStringByKeys(root: unknown, wanted: Set<string>): string | undefined {
  if (!root || typeof root !== "object") return undefined
  if (Array.isArray(root)) {
    for (const item of root) {
      const found = findStringByKeys(item, wanted)
      if (found) return found
    }
    return undefined
  }
  const obj = root as Record<string, unknown>
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && wanted.has(key)) return value
    if (value && typeof value === "object") {
      const found = findStringByKeys(value, wanted)
      if (found) return found
    }
  }
  return undefined
}
