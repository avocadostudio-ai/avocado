import { useEffect, useState } from "react"
import type { AssistantResponse, PublishResponse, PublishStatus } from "../lib/editor-types"
import { orchestrator, publishToken } from "../lib/editor-utils"

export function usePublish(
  session: string,
  siteId: string,
  isLoading: boolean,
  pushMessage: (data: AssistantResponse) => void,
  siteOrigin?: string
) {
  const [isPublishing, setIsPublishing] = useState(false)
  const [publishStatus, setPublishStatus] = useState<PublishStatus | null>(null)

  async function fetchPublishStatus() {
    try {
      const res = await fetch(`${orchestrator}/publish/status?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(siteId)}`)
      if (!res.ok) return
      const data = (await res.json()) as PublishStatus
      setPublishStatus(data)
    } catch {
      // Ignore status poll failures.
    }
  }

  async function publishSite() {
    if (isLoading || isPublishing) return
    setIsPublishing(true)
    try {
      const res = await fetch(`${orchestrator}/publish`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(publishToken ? { "x-publish-token": publishToken } : {})
        },
        body: JSON.stringify({ session, siteId, siteOrigin })
      })
      const data = (await res.json()) as PublishResponse
      if (!res.ok || (data.status !== "triggered" && data.status !== "ready")) {
        pushMessage({
          status: "error",
          summary: data.error ?? "Failed to trigger publish.",
          changes: []
        })
        return
      }

      const slugText = Array.isArray(data.slugs) && data.slugs.length > 0 ? data.slugs.join(", ") : "none"
      setPublishStatus({
        session: data.session ?? session,
        status: data.status,
        slugs: data.slugs ?? [],
        deployStatus: data.deployStatus,
        inspectUrl: data.inspectUrl,
        deploymentId: data.deploymentId,
        vercelState: data.vercelState
      })
      void fetchPublishStatus()
      if (data.status === "ready") {
        pushMessage({
          status: "applied",
          summary: data.message ?? "Nothing new to publish.",
          changes: [
            `Session: ${data.session ?? session}`,
            `Slugs: ${slugText}`,
            ...(data.branch ? [`Branch: ${data.branch}`] : [])
          ]
        })
      } else {
        pushMessage({
          status: "applied",
          summary: "Publish triggered. Vercel deployment started.",
          changes: [
            `Session: ${data.session ?? session}`,
            `Slugs: ${slugText}`,
            `Deploy status: ${data.deployStatus ?? "unknown"}`,
            `Vercel state: ${data.vercelState ?? "TRIGGERED"}`,
            ...(data.commitSha ? [`Commit: ${data.commitSha.slice(0, 12)}`] : []),
            ...(data.branch ? [`Branch: ${data.branch}`] : []),
            ...(data.message ? [data.message] : [])
          ]
        })
      }
    } catch {
      pushMessage({
        status: "error",
        summary: "Failed to trigger publish.",
        changes: []
      })
    } finally {
      setIsPublishing(false)
    }
  }

  const publishState = (publishStatus?.vercelState ?? publishStatus?.status ?? "").toUpperCase()
  const publishInProgress =
    isPublishing || publishState === "PENDING" || publishState === "QUEUED" || publishState === "BUILDING" || publishState === "INITIALIZING"
  const publishTerminal =
    publishState === "READY" || publishState === "ERROR" || publishState === "FAILED" || publishState === "CANCELED" || publishState === "SUCCEEDED"

  useEffect(() => {
    if (!publishStatus || publishTerminal) return
    const timer = window.setInterval(() => {
      void fetchPublishStatus()
    }, 5000)
    return () => window.clearInterval(timer)
  }, [publishStatus, publishTerminal, session, siteId])

  return {
    isPublishing,
    publishStatus,
    publishState,
    publishInProgress,
    publishTerminal,
    publishSite
  }
}
