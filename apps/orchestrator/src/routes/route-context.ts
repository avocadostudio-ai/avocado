import type { createChatTelemetryStore } from "../telemetry/chat-telemetry.js"
import type { AIProvider, ModelKey } from "../state/session-state.js"

export type RouteContext = {
  chatTelemetry: ReturnType<typeof createChatTelemetryStore>
  modelLookup: Record<AIProvider, Record<ModelKey, string>>
  availableProviders: AIProvider[]
  generatedImageDir: string
  orchestratorPublicOrigin: string
}
