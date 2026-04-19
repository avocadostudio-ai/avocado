import type { createChatTelemetryStore } from "../telemetry/chat-telemetry.js"
import type { EvalCandidateStore } from "../telemetry/eval-candidate-store.js"
import type { AIProvider, ModelKey } from "../state/session-state.js"
import type { ToolRuntime } from "../tools/runtime.js"

export type RouteContext = {
  chatTelemetry: ReturnType<typeof createChatTelemetryStore>
  evalCandidates?: EvalCandidateStore
  modelLookup: Record<AIProvider, Record<ModelKey, string>>
  availableProviders: AIProvider[]
  generatedImageDir: string
  orchestratorPublicOrigin: string
  sitePublicOrigin: string
  toolRuntime: ToolRuntime
}
