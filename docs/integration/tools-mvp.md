# Native Tools MVP (Anthropic-first)

This document defines the MVP tool contract and onboarding flow for adopter tools. If you want the AI planner to call your own APIs (product catalog, asset management, etc.) during chat-driven editing, this is the contract to implement.

**Prerequisites**: a running orchestrator instance and familiarity with the [integration overview](README.md).

## What "Anthropic-first" means

The AI planner supports multiple LLM providers (Anthropic and OpenAI). **"Anthropic-first"** means the tool calling system in the MVP is built on Anthropic's native tool use protocol — tools are exposed to Claude as `tools[]` with `input_schema`, and the model responds with `tool_use` content blocks.

| What works now (MVP) | Planned |
|---|---|
| Tools called via Anthropic's `tool_use` / `tool_result` protocol | OpenAI Responses API tool adapter |
| Claude models (Haiku, Sonnet, Opus) trigger tool calls during planning | GPT models using equivalent function calling |

The internal tool runtime is provider-neutral — tool manifests, execution, and results use a shared contract. Only the adapter layer that maps tools into LLM API calls is Anthropic-specific today. Adding OpenAI support is an adapter change, not a contract change, so any tools you register now will work with both providers once the OpenAI adapter ships.

**In practice**: if you're using an Anthropic API key for planning, tools work today. If you're using only an OpenAI key, registered tools will not be called by the planner until the OpenAI adapter is added.

## Scope

- MVP: tools work with Anthropic models via native tool use protocol.
- OpenAI Responses API tool adapter planned (tool contracts are forward-compatible).
- Built-in tool shipped in MVP: `unsplash.search`.

## Internal Tool Contract

Every tool is registered with a `ToolManifest`:

- `name`: unique id (for example `unsplash.search`, `pim.getProduct`)
- `description`: natural-language purpose
- `inputSchema`: JSON Schema for tool input
- `outputSchema`: JSON Schema for tool output
- `capability`: `read` or `write`
- `timeoutMs`: per-call timeout
- `retryPolicy`: `{ maxAttempts, backoffMs? }`
- `idempotent`: whether identical calls can be replayed safely

Execution context passed to tools:

- `siteId`
- `sessionId`
- `userId` (optional)
- `traceId`
- `plannerProvider`

Result envelope returned by runtime:

- `ok`
- `data` (on success)
- `error` `{ code, message, retryable }` (on failure)
- `latencyMs`
- `attempts`

## Default Governance Policy

- Read tools auto-run.
- Write tools require approval (runtime blocks direct auto execution).

## Anthropic Adapter Behavior

Planner exposes tools as Anthropic `tools[]` with `input_schema`.
The planner loop supports:

1. model requests tool call (`tool_use`)
2. orchestrator executes tool server-side
3. orchestrator returns `tool_result`
4. model continues until `submit_edit_plan`

`submit_edit_plan` is still validated by existing normalizer + `editPlanSchema`.

## Unsplash Tool

`unsplash.search` input:

```json
{ "query": "mountain sunset", "limit": 3 }
```

`unsplash.search` output:

```json
{
  "items": [
    {
      "id": "...",
      "imageUrl": "https://...",
      "thumbUrl": "https://...",
      "alt": "...",
      "author": "Unsplash",
      "sourceUrl": "https://..."
    }
  ]
}
```

## Adopter Onboarding

### Option A: Runtime registration endpoint

- `GET /tools` to view enabled tools
- `POST /tools/register` to register a remote tool

Payload:

```json
{
  "manifest": { "name": "pim.getProduct", "description": "...", "inputSchema": {"type":"object"}, "outputSchema": {"type":"object"}, "capability": "read", "timeoutMs": 3000, "retryPolicy": {"maxAttempts": 2}, "idempotent": true },
  "endpoint": "https://vendor.example.com/site-editor/tools/pim/getProduct",
  "staticHeaders": { "x-api-key": "***" }
}
```

### Option B: Bootstrap config file

Set `ORCHESTRATOR_TOOL_MANIFEST_PATH` to a JSON file:

```json
{
  "tools": [
    {
      "manifest": { "name": "dam.searchAssets", "description": "...", "inputSchema": {"type":"object"}, "outputSchema": {"type":"object"}, "capability": "read", "timeoutMs": 5000, "retryPolicy": {"maxAttempts": 2}, "idempotent": true },
      "endpoint": "https://vendor.example.com/site-editor/tools/dam/searchAssets",
      "staticHeaders": { "x-api-key": "***" }
    }
  ]
}
```

## Remote Tool HTTP Contract

Orchestrator calls remote endpoints with:

```json
{
  "toolName": "pim.getProduct",
  "arguments": { "sku": "SKU-123" },
  "context": {
    "siteId": "...",
    "sessionId": "...",
    "userId": "...",
    "traceId": "...",
    "plannerProvider": "anthropic"
  }
}
```

Expected response:

```json
{ "data": { "...": "..." } }
```

On non-2xx responses, runtime returns normalized tool error to the model loop.

## PIM Skeleton Example

- Tool name: `pim.getProduct`
- Input schema: `{ sku: string }`
- Output schema: `{ sku: string, title: string, description?: string, imageUrl?: string, price?: string }`
- Capability: `read`

## DAM Skeleton Example

- Tool name: `dam.searchAssets`
- Input schema: `{ query: string, limit?: integer }`
- Output schema: `{ items: [{ id: string, url: string, alt?: string, mimeType?: string }] }`
- Capability: `read`
