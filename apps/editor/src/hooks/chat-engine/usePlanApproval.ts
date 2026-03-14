import { useState } from "react"
import type {
  AssistantResponse,
  ChatExecutionMode,
  PlannerBadgeState
} from "../../lib/editor-types"
import { createId } from "../../lib/editor-utils"

export type PlanApprovalDeps = {
  isLoading: boolean
  setIsLoading: (loading: boolean) => void
  useStreaming: boolean
  setChatLog: React.Dispatch<React.SetStateAction<import("../../lib/editor-types").ChatEntry[]>>
  setLatestStreamFocusBlockId: (value: string | null) => void
  setStreamStatus: (value: string | null) => void
  setStreamingText: (value: string | null) => void
  setStreamingChanges: (value: string[]) => void
  setStreamSteps: (value: { label: string; done: boolean }[]) => void
  pushAssistantFromResult: (data: AssistantResponse, options?: { canUndo?: boolean }) => void
  submitChatStream: (finalMessage: string, extraParams?: Record<string, string>) => Promise<boolean>
  submitChatHttp: (finalMessage: string, options?: { executionMode?: ChatExecutionMode; pendingPlanId?: string; continuationChainId?: string }) => Promise<void>
}

export function usePlanApproval(deps: PlanApprovalDeps) {
  const [pendingPlanId, setPendingPlanId] = useState<string | null>(null)
  const [pendingPlanMessage, setPendingPlanMessage] = useState<string | null>(null)
  const [plannerBadgeState, setPlannerBadgeState] = useState<PlannerBadgeState>("checking")

  async function approvePendingPlan(planId: string) {
    if (!planId || deps.isLoading) return
    const originalMessage = pendingPlanMessage?.trim() || "Approve and execute the pending plan."
    deps.setChatLog((prev) => [...prev, { id: createId(), role: "user", text: "Approve plan and execute." }])
    deps.setIsLoading(true)
    deps.setLatestStreamFocusBlockId(null)
    try {
      const approvalParams = { executionMode: "apply_pending_plan" as const, pendingPlanId: planId }
      if (deps.useStreaming) {
        const ok = await deps.submitChatStream(originalMessage, approvalParams)
        if (!ok) await deps.submitChatHttp(originalMessage, approvalParams)
      } else {
        await deps.submitChatHttp(originalMessage, approvalParams)
      }
    } catch (error) {
      deps.pushAssistantFromResult({
        status: "error",
        summary: `Plan execution failed: ${error instanceof Error ? error.message : "unknown error"}`,
        changes: []
      })
    } finally {
      deps.setStreamStatus(null)
      deps.setStreamingText(null)
      deps.setStreamingChanges([])
      deps.setStreamSteps([])
      deps.setIsLoading(false)
    }
  }

  async function stopPendingPlan(planId: string) {
    if (!planId || deps.isLoading) return
    deps.setChatLog((prev) => [...prev, { id: createId(), role: "user", text: "Stop and discard this plan." }])
    deps.setIsLoading(true)
    try {
      await deps.submitChatHttp("Stop pending plan.", {
        executionMode: "discard_pending_plan",
        pendingPlanId: planId
      })
    } finally {
      deps.setStreamingText(null)
      deps.setStreamingChanges([])
      deps.setIsLoading(false)
    }
  }

  return {
    pendingPlanId,
    setPendingPlanId,
    pendingPlanMessage,
    setPendingPlanMessage,
    plannerBadgeState,
    setPlannerBadgeState,
    approvePendingPlan,
    stopPendingPlan
  }
}
