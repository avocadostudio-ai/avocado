import { useState } from "react"
import type { ChatExecutionMode } from "../../lib/editor-types"
import { createId } from "../../lib/editor-utils"
import { useEditorStore } from "../../store"

export type PlanApprovalDeps = {
  submitChatStream: (finalMessage: string, extraParams?: Record<string, string>) => Promise<boolean>
  submitChatHttp: (finalMessage: string, options?: { executionMode?: ChatExecutionMode; pendingPlanId?: string; continuationChainId?: string }) => Promise<void>
}

export function usePlanApproval(deps: PlanApprovalDeps) {
  const store = useEditorStore
  const [pendingPlanMessage, setPendingPlanMessage] = useState<string | null>(null)

  async function approvePendingPlan(planId: string) {
    const { isLoading, useStreaming } = store.getState()
    if (!planId || isLoading) return
    const originalMessage = pendingPlanMessage?.trim() || "Approve and execute the pending plan."
    store.getState().appendChatEntry({ id: createId(), role: "user", text: "Approve plan and execute." })
    store.getState().setIsLoading(true)
    store.getState().setLatestStreamFocusBlockId(null)
    try {
      const approvalParams = { executionMode: "apply_pending_plan" as const, pendingPlanId: planId }
      if (useStreaming) {
        const ok = await deps.submitChatStream(originalMessage, approvalParams)
        if (!ok) await deps.submitChatHttp(originalMessage, approvalParams)
      } else {
        await deps.submitChatHttp(originalMessage, approvalParams)
      }
    } catch (error) {
      store.getState().pushAssistantFromResult({
        status: "error",
        summary: `Plan execution failed: ${error instanceof Error ? error.message : "unknown error"}`,
        changes: []
      })
    } finally {
      store.getState().setStreamStatus(null)
      store.getState().setStreamingText(null)
      store.getState().setStreamingChanges([])
      store.getState().setStreamSteps([])
      store.getState().setIsLoading(false)
    }
  }

  async function stopPendingPlan(planId: string) {
    const { isLoading } = store.getState()
    if (!planId || isLoading) return
    store.getState().appendChatEntry({ id: createId(), role: "user", text: "Stop and discard this plan." })
    store.getState().setIsLoading(true)
    try {
      await deps.submitChatHttp("Stop pending plan.", {
        executionMode: "discard_pending_plan",
        pendingPlanId: planId
      })
    } finally {
      store.getState().setStreamingText(null)
      store.getState().setStreamingChanges([])
      store.getState().setIsLoading(false)
    }
  }

  return {
    pendingPlanMessage,
    setPendingPlanMessage,
    approvePendingPlan,
    stopPendingPlan
  }
}
