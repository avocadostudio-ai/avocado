export type JsonSchema = {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null"
  description?: string
  enum?: unknown[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchema
}

export type ToolCapability = "read" | "write"

export type ToolRetryPolicy = {
  maxAttempts: number
  backoffMs?: number
}

export type ToolManifest = {
  name: string
  description: string
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  capability: ToolCapability
  timeoutMs: number
  retryPolicy: ToolRetryPolicy
  idempotent: boolean
  enabled?: boolean
}

export type ToolCallContext = {
  siteId: string
  sessionId: string
  userId?: string
  traceId: string
  plannerProvider: "anthropic" | "openai" | "demo"
  authHeader?: string
  onStatusUpdate?: (message: string) => void
  onImageProgress?: (event: { percent: number; stage: string }) => void
}

export type ToolError = {
  code: string
  message: string
  retryable: boolean
}

export type ToolResult = {
  ok: boolean
  data?: unknown
  error?: ToolError
  latencyMs: number
  attempts: number
}

export type ToolExecutionPolicy = {
  autoRunRead: boolean
  requireApprovalForWrite: boolean
}

export type ToolExecutionEvent = {
  toolName: string
  ok: boolean
  latencyMs: number
  attempts: number
  errorCode?: string
  traceId: string
  sessionId: string
  siteId: string
  plannerProvider: string
}

export type ToolHandler = (args: {
  input: unknown
  context: ToolCallContext
  manifest: ToolManifest
}) => Promise<unknown>

export type RegisteredTool = {
  manifest: ToolManifest
  handler: ToolHandler
  source: "builtin" | "remote"
  endpoint?: string
  staticHeaders?: Record<string, string>
}

export type RemoteToolRegistration = {
  manifest: ToolManifest
  endpoint: string
  staticHeaders?: Record<string, string>
}
