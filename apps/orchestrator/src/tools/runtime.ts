import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import type { ToolExecutionEvent, ToolExecutionPolicy, ToolCallContext, ToolManifest } from "./types.js"
import { ToolRegistry } from "./registry.js"
import { ToolExecutor } from "./executor.js"
import { unsplashSearchHandler, unsplashSearchManifest } from "./builtins/unsplash-search.js"
import { imageGenerateHandler, imageGenerateManifest } from "./builtins/image-generate.js"

type Logger = {
  info: (payload: Record<string, unknown>, message?: string) => void
  warn: (payload: Record<string, unknown>, message?: string) => void
  error: (payload: Record<string, unknown>, message?: string) => void
}

export type ToolRuntime = {
  registry: ToolRegistry
  executor: ToolExecutor
  defaultPolicy: ToolExecutionPolicy
}

type CreateToolRuntimeArgs = {
  logger: Logger
  onExecution?: (event: ToolExecutionEvent) => void
}

export async function createToolRuntime(args: CreateToolRuntimeArgs): Promise<ToolRuntime> {
  const registry = new ToolRegistry()
  registry.registerBuiltin(unsplashSearchManifest, unsplashSearchHandler)
  if (process.env.OPENAI_API_KEY) {
    registry.registerBuiltin(imageGenerateManifest, imageGenerateHandler)
  }

  const defaultPolicy: ToolExecutionPolicy = {
    autoRunRead: true,
    requireApprovalForWrite: true
  }

  const executor = new ToolExecutor(registry, args.logger, args.onExecution)
  await loadRemoteToolRegistrations(registry, args.logger)

  return { registry, executor, defaultPolicy }
}

export async function loadRemoteToolRegistrations(registry: ToolRegistry, logger: Logger) {
  const manifestPath = process.env.ORCHESTRATOR_TOOL_MANIFEST_PATH?.trim()
  if (!manifestPath) return
  if (!existsSync(manifestPath)) {
    logger.warn({ manifestPath }, "Tool manifest path not found; skipping remote tool registration")
    return
  }

  try {
    const raw = await readFile(manifestPath, "utf8")
    const parsed = JSON.parse(raw) as {
      tools?: Array<{
        manifest: ToolManifest
        endpoint: string
        staticHeaders?: Record<string, string>
      }>
    }
    const items = Array.isArray(parsed.tools) ? parsed.tools : []
    for (const item of items) {
      registry.registerRemote({
        manifest: item.manifest,
        endpoint: item.endpoint,
        staticHeaders: item.staticHeaders
      })
    }
    logger.info({ manifestPath, count: items.length }, "Loaded remote tool registrations")
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    logger.error({ err: detail, manifestPath }, "Failed to load remote tool registrations")
  }
}

export async function executeToolCall(args: {
  runtime: ToolRuntime
  toolName: string
  input: unknown
  context: ToolCallContext
  policy?: Partial<ToolExecutionPolicy>
}) {
  return args.runtime.executor.execute({
    toolName: args.toolName,
    input: args.input,
    context: args.context,
    policy: args.policy
  })
}
