import type { createChatTelemetryStore } from "../telemetry/chat-telemetry.js"
import type { ModelKey } from "../state/session-state.js"

export type RouteContext = {
  chatTelemetry: ReturnType<typeof createChatTelemetryStore>
  modelLookup: Record<ModelKey, string>
  generatedImageDir: string
  orchestratorPublicOrigin: string
}
