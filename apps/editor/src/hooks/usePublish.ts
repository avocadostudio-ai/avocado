import { useEffect, useState } from "react"
import type { AssistantResponse, PublishResponse, PublishStatus } from "../lib/editor-types"
import { orchestrator, publishToken } from "../lib/editor-utils"

export function usePublish(
  session: string,
  siteId: string,
  isLoading: boolean,
  pushMessage: (data: AssistantResponse) => void,
  siteOrigin?: string,
  onPublished?: () => void
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

      const slugs = Array.isArray(data.slugs) ? data.slugs : []
      setPublishStatus({
        session: data.session ?? session,
        status: data.status,
        slugs,
        deployStatus: data.deployStatus,
        inspectUrl: data.inspectUrl,
        deploymentId: data.deploymentId,
        vercelState: data.vercelState
      })
      void fetchPublishStatus()
      const pageChanges = slugs.map((s) => {
        const label = s === "/" ? "Home" : s.replace(/^\//, "")
        return `Updated ${label}`
      })
      if (data.status === "ready") {
        pushMessage({
          status: "applied",
          summary: data.message ?? "Nothing new to publish.",
          changes: [
            ...pageChanges,
            ...(data.branch ? [`Branch: ${data.branch}`] : [])
          ]
        })
      } else {
        pushMessage({
          status: "applied",
          summary: "Publish triggered. Vercel deployment started.",
          changes: [
            ...pageChanges,
            `Deploy status: ${data.deployStatus ?? "unknown"}`,
            `Vercel state: ${data.vercelState ?? "TRIGGERED"}`,
            ...(data.commitSha ? [`Commit: ${data.commitSha.slice(0, 12)}`] : []),
            ...(data.branch ? [`Branch: ${data.branch}`] : []),
            ...(data.message ? [data.message] : [])
          ]
        })
      }
      onPublished?.()
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
