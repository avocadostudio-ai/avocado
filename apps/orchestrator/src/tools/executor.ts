import { createHash } from "node:crypto"
import type { ToolCallContext, ToolExecutionEvent, ToolExecutionPolicy, ToolResult } from "./types.js"
import { validateAgainstSchema } from "./schema-validator.js"
import { ToolRegistry } from "./registry.js"

const DEFAULT_POLICY: ToolExecutionPolicy = {
  autoRunRead: true,
  requireApprovalForWrite: true
}

type Logger = {
  info: (payload: Record<string, unknown>, message?: string) => void
  warn: (payload: Record<string, unknown>, message?: string) => void
}

type ExecuteArgs = {
  toolName: string
  input: unknown
  context: ToolCallContext
  policy?: Partial<ToolExecutionPolicy>
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function timeoutPromise(ms: number) {
  return new Promise<never>((_resolve, reject) => {
    const t = setTimeout(() => {
      clearTimeout(t)
      reject(new Error(`Tool timed out after ${ms}ms`))
    }, ms)
  })
}

function normalizedToolError(code: string, message: string, retryable: boolean) {
  return {
    ok: false,
    error: { code, message, retryable }
  } as const
}

function stableHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export class ToolExecutor {
  private readonly idempotencyCache = new Map<string, ToolResult>()

  constructor(
    private readonly registry: ToolRegistry,
    private readonly logger: Logger,
    private readonly onExecution?: (event: ToolExecutionEvent) => void
  ) {}

  async execute(args: ExecuteArgs): Promise<ToolResult> {
    const tool = this.registry.getByName(args.toolName)
    const startedAt = Date.now()
    const policy: ToolExecutionPolicy = {
      autoRunRead: args.policy?.autoRunRead ?? DEFAULT_POLICY.autoRunRead,
      requireApprovalForWrite: args.policy?.requireApprovalForWrite ?? DEFAULT_POLICY.requireApprovalForWrite
    }

    if (!tool || tool.manifest.enabled === false) {
      return {
        ...normalizedToolError("tool_not_found", `Tool not found: ${args.toolName}`, false),
        latencyMs: Date.now() - startedAt,
        attempts: 1
      }
    }

    if (tool.manifest.capability === "write" && policy.requireApprovalForWrite) {
      return {
        ...normalizedToolError("tool_requires_approval", `Tool requires approval: ${tool.manifest.name}`, false),
        latencyMs: Date.now() - startedAt,
        attempts: 1
      }
    }

    if (tool.manifest.capability === "read" && !policy.autoRunRead) {
      return {
        ...normalizedToolError("tool_auto_run_disabled", `Read tool auto-run disabled: ${tool.manifest.name}`, false),
        latencyMs: Date.now() - startedAt,
        attempts: 1
      }
    }

    const inputValidation = validateAgainstSchema(args.input, tool.manifest.inputSchema)
    if (!inputValidation.ok) {
      return {
        ...normalizedToolError("invalid_tool_input", inputValidation.message, false),
        latencyMs: Date.now() - startedAt,
        attempts: 1
      }
    }

    const idempotencyKey = `${args.context.traceId}:${tool.manifest.name}:${stableHash(args.input)}`
    if (tool.manifest.idempotent && this.idempotencyCache.has(idempotencyKey)) {
      return this.idempotencyCache.get(idempotencyKey)!
    }

    const maxAttempts = Math.max(1, tool.manifest.retryPolicy.maxAttempts)
    const backoffMs = Math.max(0, tool.manifest.retryPolicy.backoffMs ?? 0)

    let attempts = 0
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempts = attempt
      try {
        const output = await Promise.race([
          tool.handler({ input: args.input, context: args.context, manifest: tool.manifest }),
          timeoutPromise(tool.manifest.timeoutMs)
        ])

        const outputValidation = validateAgainstSchema(output, tool.manifest.outputSchema)
        if (!outputValidation.ok) {
          const result: ToolResult = {
            ...normalizedToolError("invalid_tool_output", outputValidation.message, false),
            latencyMs: Date.now() - startedAt,
            attempts
          }
          this.emit(args, result)
          return result
        }

        const result: ToolResult = {
          ok: true,
          data: output,
          latencyMs: Date.now() - startedAt,
          attempts
        }
        if (tool.manifest.idempotent) this.idempotencyCache.set(idempotencyKey, result)
        this.emit(args, result)
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const retryable = attempt < maxAttempts
        if (retryable && backoffMs > 0) await sleep(backoffMs * attempt)
        if (!retryable) {
          const result: ToolResult = {
            ...normalizedToolError("tool_execution_failed", message.slice(0, 240), false),
            latencyMs: Date.now() - startedAt,
            attempts
          }
          this.emit(args, result)
          return result
        }
      }
    }

    const result: ToolResult = {
      ...normalizedToolError("tool_execution_failed", "Tool execution failed", false),
      latencyMs: Date.now() - startedAt,
      attempts
    }
    this.emit(args, result)
    return result
  }

  private emit(args: ExecuteArgs, result: ToolResult) {
    const payload = {
      event: "tool_execution",
      tool: args.toolName,
      ok: result.ok,
      latencyMs: result.latencyMs,
      attempts: result.attempts,
      traceId: args.context.traceId,
      siteId: args.context.siteId,
      sessionId: args.context.sessionId,
      plannerProvider: args.context.plannerProvider,
      errorCode: result.error?.code
    }
    if (result.ok) this.logger.info(payload, "Tool executed")
    else this.logger.warn(payload, "Tool execution failed")

    this.onExecution?.({
      toolName: args.toolName,
      ok: result.ok,
      latencyMs: result.latencyMs,
      attempts: result.attempts,
      errorCode: result.error?.code,
      traceId: args.context.traceId,
      sessionId: args.context.sessionId,
      siteId: args.context.siteId,
      plannerProvider: args.context.plannerProvider
    })
  }
}
