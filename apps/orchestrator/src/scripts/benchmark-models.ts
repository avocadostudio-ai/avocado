import dotenv from "dotenv"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import OpenAI from "openai"
import Anthropic from "@anthropic-ai/sdk"

type EndpointMode = "auto" | "chat" | "responses" | "messages"
type ProviderMode = "auto" | "openai" | "anthropic"
type Provider = "openai" | "anthropic"
type EvalMode = "text" | "ops-json"
type OpsCardinality = "single" | "multi"
type PromptCase = {
  id: string
  prompt: string
  expectedOps?: string[]
}

type Usage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

type RunResult = {
  model: string
  promptId: string
  run: number
  endpoint: Exclude<EndpointMode, "auto">
  provider: Provider
  latencyMs: number
  usage: Usage
  estimatedUsd: number | null
  outputTextPreview?: string
  commandEval?: CommandEval
  evalMode?: EvalMode
  error?: string
}

type CommandEval = {
  expectedOps: string[]
  predictedOps: string[]
  missingOps: string[]
  unexpectedOps: string[]
  precision: number
  recall: number
  f1: number
  exactMatch: boolean
}

type Aggregate = {
  ok: number
  total: number
  successRate: number
  p50LatencyMs: number
  p95LatencyMs: number
  avgInputTokens: number
  avgOutputTokens: number
  avgUsd: number | null
  totalUsd: number | null
}

type ScoredAggregate = {
  model: string
  aggregate: Aggregate
  score: number
}

const envCandidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]
for (const path of envCandidates) {
  if (existsSync(path)) {
    dotenv.config({ path })
    break
  }
}

const DEFAULT_MODELS = ["gpt-4o-mini"]
const DEFAULT_PROMPTS: PromptCase[] = [
  {
    id: "hero-rewrite",
    prompt: "Rewrite this hero headline and subhead for clarity and conversion. Headline: Build better pages. Subhead: Use AI to edit your website fast."
  },
  {
    id: "cta-copy",
    prompt: "Generate 5 concise CTA button labels for a SaaS pricing page. Return JSON array only."
  },
  {
    id: "content-ops",
    prompt: "Given a testimonial section with weak social proof, propose 3 concrete edits to improve credibility. Keep each edit under 25 words."
  },
  {
    id: "schema-safe",
    prompt: "Return a JSON object with keys summary (string) and changes (array of strings) for this request: Make the homepage tone more confident."
  },
  {
    id: "long-context",
    prompt:
      "Summarize this update request into 4 bullets with no fluff: We need faster first paint, better mobile spacing, fewer generic words, and clearer pricing differentiation across tiers."
  }
]

const USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-5.2": { input: 1.75, output: 14 },
  "gpt-5.2-codex": { input: 1.75, output: 14 }
}

const CANONICAL_OPS = [
  "create_page",
  "add_block",
  "update_props",
  "remove_block",
  "move_block",
  "duplicate_block",
  "add_item",
  "update_item",
  "remove_item",
  "move_item",
  "rename_page",
  "remove_page",
  "move_page",
  "duplicate_page",
  "update_page_meta",
  "update_site_config"
] as const
type CanonicalOp = (typeof CANONICAL_OPS)[number]

const OP_ALIASES: Record<string, CanonicalOp> = {
  create_page: "create_page",
  createpage: "create_page",
  create_page_op: "create_page",
  add_block: "add_block",
  addblock: "add_block",
  insert_block: "add_block",
  insertblock: "add_block",
  update_props: "update_props",
  updateprops: "update_props",
  update_block: "update_props",
  updateblock: "update_props",
  edit_block: "update_props",
  editblock: "update_props",
  remove_block: "remove_block",
  removeblock: "remove_block",
  delete_block: "remove_block",
  deleteblock: "remove_block",
  move_block: "move_block",
  moveblock: "move_block",
  reorder_block: "move_block",
  reorderblock: "move_block",
  duplicate_block: "duplicate_block",
  duplicateblock: "duplicate_block",
  copy_block: "duplicate_block",
  copyblock: "duplicate_block",
  clone_block: "duplicate_block",
  cloneblock: "duplicate_block",
  add_item: "add_item",
  additem: "add_item",
  insert_item: "add_item",
  insertitem: "add_item",
  append_item: "add_item",
  appenditem: "add_item",
  update_item: "update_item",
  updateitem: "update_item",
  edit_item: "update_item",
  edititem: "update_item",
  remove_item: "remove_item",
  removeitem: "remove_item",
  delete_item: "remove_item",
  deleteitem: "remove_item",
  move_item: "move_item",
  moveitem: "move_item",
  reorder_item: "move_item",
  reorderitem: "move_item",
  rename_page: "rename_page",
  renamepage: "rename_page",
  remove_page: "remove_page",
  removepage: "remove_page",
  delete_page: "remove_page",
  deletepage: "remove_page",
  move_page: "move_page",
  movepage: "move_page",
  reorder_page: "move_page",
  reorderpage: "move_page",
  duplicate_page: "duplicate_page",
  duplicatepage: "duplicate_page",
  copy_page: "duplicate_page",
  copypage: "duplicate_page",
  clone_page: "duplicate_page",
  clonepage: "duplicate_page",
  update_page_meta: "update_page_meta",
  updatepagemeta: "update_page_meta",
  set_page_meta: "update_page_meta",
  setpagemeta: "update_page_meta",
  update_site_config: "update_site_config",
  updatesiteconfig: "update_site_config",
  set_site_config: "update_site_config",
  setsiteconfig: "update_site_config"
}

function parseArgs(argv: string[]) {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (!item.startsWith("--")) continue
    const key = item.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith("--")) {
      args.set(key, "true")
      continue
    }
    args.set(key, next)
    i += 1
  }
  return args
}

function toInt(value: string | undefined, fallback: number) {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return parsed
}

function toEvalMode(value: string | undefined): EvalMode {
  const raw = (value ?? "text").trim().toLowerCase()
  return raw === "ops-json" ? "ops-json" : "text"
}

function normalizeOp(value: unknown): CanonicalOp | null {
  if (typeof value !== "string") return null
  const key = value.toLowerCase().trim().replace(/[\s-]+/g, "_")
  if ((CANONICAL_OPS as readonly string[]).includes(key)) return key as CanonicalOp
  return OP_ALIASES[key] ?? null
}

function parseExpectedOps(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const normalized = Array.from(new Set(value.map((item) => normalizeOp(item)).filter((item): item is CanonicalOp => !!item)))
  return normalized.length > 0 ? normalized : undefined
}

function extractResponsesText(source: unknown): string {
  const direct = (source as { output_text?: unknown } | null)?.output_text
  if (typeof direct === "string" && direct.trim().length > 0) return direct

  const output = (source as { output?: unknown } | null)?.output
  if (!Array.isArray(output)) return ""

  const parts: string[] = []
  for (const item of output) {
    if (!item || typeof item !== "object") continue
    const content = (item as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const chunk of content) {
      if (!chunk || typeof chunk !== "object") continue
      const text = (chunk as { text?: unknown }).text
      if (typeof text === "string" && text.trim().length > 0) parts.push(text)
    }
  }
  return parts.join("\n")
}

function extractChatText(source: unknown): string {
  const choices = (source as { choices?: unknown } | null)?.choices
  if (!Array.isArray(choices) || choices.length === 0) return ""
  const message = (choices[0] as { message?: unknown } | null)?.message as { content?: unknown } | undefined
  const content = message?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  const parts: string[] = []
  for (const item of content) {
    if (!item || typeof item !== "object") continue
    const text = (item as { text?: unknown }).text
    if (typeof text === "string" && text.trim().length > 0) parts.push(text)
  }
  return parts.join("\n")
}

function buildOpsJsonEvalUserPrompt(prompt: string, cardinality: OpsCardinality) {
  const cardinalityInstruction =
    cardinality === "single"
      ? "Return exactly ONE op in the array. Choose the most specific primary command."
      : "Return ONE OR MORE ops in the array when the request clearly includes multiple actions."
  return [
    "Task: infer website-editor operation command(s) for this request.",
    "Allowed commands only:",
    "create_page, add_block, update_props, remove_block, move_block, duplicate_block, add_item, update_item, remove_item, move_item, rename_page, remove_page, move_page, duplicate_page, update_page_meta, update_site_config.",
    "Return strict JSON only in this exact shape: {\"ops\":[{\"op\":\"...\"}]}",
    cardinalityInstruction,
    "Use only allowed command names.",
    "User request:",
    prompt
  ].join("\n")
}

function parseOpsFromJsonOutput(text: string, cardinality: OpsCardinality): CanonicalOp[] {
  if (!text.trim()) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start < 0 || end <= start) return []
    try {
      parsed = JSON.parse(text.slice(start, end + 1))
    } catch {
      return []
    }
  }

  if (!parsed || typeof parsed !== "object") return []
  const opsRaw = (parsed as { ops?: unknown }).ops
  if (!Array.isArray(opsRaw)) return []

  const ops: CanonicalOp[] = []
  for (const item of opsRaw) {
    if (typeof item === "string") {
      const normalized = normalizeOp(item)
      if (normalized) ops.push(normalized)
      continue
    }
    if (!item || typeof item !== "object") continue
    const op = normalizeOp((item as { op?: unknown }).op)
    if (op) ops.push(op)
  }
  const unique = Array.from(new Set(ops))
  return cardinality === "single" ? unique.slice(0, 1) : unique
}

function detectOpsFromText(text: string): CanonicalOp[] {
  if (!text.trim()) return []
  const detected = new Set<CanonicalOp>()
  const lowered = text.toLowerCase()

  const opJsonRegex = /"op"\s*:\s*"([^"]+)"/g
  for (;;) {
    const match = opJsonRegex.exec(text)
    if (!match) break
    const normalized = normalizeOp(match[1])
    if (normalized) detected.add(normalized)
  }

  const contains = (pattern: RegExp, op: CanonicalOp) => {
    if (pattern.test(lowered)) detected.add(op)
  }
  contains(/\bcreate[_\s-]?page\b|\bnew\s+page\b/, "create_page")
  contains(/\badd[_\s-]?block\b|\binsert[_\s-]?block\b/, "add_block")
  contains(/\bupdate[_\s-]?(props|block)\b|\bedit[_\s-]?block\b/, "update_props")
  contains(/\b(remove|delete)[_\s-]?block\b/, "remove_block")
  contains(/\b(move|reorder)[_\s-]?block\b/, "move_block")
  contains(/\b(duplicate|copy|clone)[_\s-]?block\b/, "duplicate_block")
  contains(/\b(add|insert|append)[_\s-]?item\b/, "add_item")
  contains(/\b(update|edit)[_\s-]?item\b/, "update_item")
  contains(/\b(remove|delete)[_\s-]?item\b/, "remove_item")
  contains(/\b(move|reorder)[_\s-]?item\b/, "move_item")
  contains(/\brename[_\s-]?page\b/, "rename_page")
  contains(/\b(remove|delete)[_\s-]?page\b/, "remove_page")
  contains(/\b(move|reorder)[_\s-]?page\b/, "move_page")
  contains(/\b(duplicate|copy|clone)[_\s-]?page\b/, "duplicate_page")
  contains(/\bupdate[_\s-]?page[_\s-]?meta\b|\bset[_\s-]?page[_\s-]?meta\b|\bseo[_\s-]?(title|desc|meta)\b|\bpage[_\s-]?meta\b/, "update_page_meta")
  contains(/\bupdate[_\s-]?site[_\s-]?config\b|\bset[_\s-]?site[_\s-]?config\b|\bsite[_\s-]?(name|config|settings)\b/, "update_site_config")

  return Array.from(detected)
}

function evaluateCommandMatch(expectedOps: string[] | undefined, text: string): CommandEval | undefined {
  if (!expectedOps || expectedOps.length === 0) return undefined
  const expected = Array.from(new Set(expectedOps.map((item) => normalizeOp(item)).filter((item): item is CanonicalOp => !!item)))
  if (expected.length === 0) return undefined

  const predicted = detectOpsFromText(text)
  const predictedSet = new Set(predicted)
  const expectedSet = new Set(expected)
  const intersection = expected.filter((op) => predictedSet.has(op))
  const missing = expected.filter((op) => !predictedSet.has(op))
  const unexpected = predicted.filter((op) => !expectedSet.has(op))
  const precision = predicted.length > 0 ? intersection.length / predicted.length : 0
  const recall = expected.length > 0 ? intersection.length / expected.length : 0
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
  const exactMatch = missing.length === 0 && unexpected.length === 0

  return {
    expectedOps: expected,
    predictedOps: predicted,
    missingOps: missing,
    unexpectedOps: unexpected,
    precision,
    recall,
    f1,
    exactMatch
  }
}

function evaluateCommandMatchFromPredicted(expectedOps: string[] | undefined, predicted: CanonicalOp[]): CommandEval | undefined {
  if (!expectedOps || expectedOps.length === 0) return undefined
  const expected = Array.from(new Set(expectedOps.map((item) => normalizeOp(item)).filter((item): item is CanonicalOp => !!item)))
  if (expected.length === 0) return undefined

  const predictedSet = new Set(predicted)
  const expectedSet = new Set(expected)
  const intersection = expected.filter((op) => predictedSet.has(op))
  const missing = expected.filter((op) => !predictedSet.has(op))
  const unexpected = predicted.filter((op) => !expectedSet.has(op))
  const precision = predicted.length > 0 ? intersection.length / predicted.length : 0
  const recall = expected.length > 0 ? intersection.length / expected.length : 0
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
  const exactMatch = missing.length === 0 && unexpected.length === 0

  return {
    expectedOps: expected,
    predictedOps: predicted,
    missingOps: missing,
    unexpectedOps: unexpected,
    precision,
    recall,
    f1,
    exactMatch
  }
}

function parsePrompts(raw: string): PromptCase[] {
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error("prompts file must be a JSON array")
  }
  const items: PromptCase[] = []
  for (const [index, value] of parsed.entries()) {
    if (typeof value === "string") {
      const prompt = value.trim()
      if (!prompt) continue
      items.push({ id: `prompt-${index + 1}`, prompt })
      continue
    }
    if (!value || typeof value !== "object") continue
    const candidate = value as { id?: unknown; prompt?: unknown; input?: unknown; expectedOps?: unknown; expected_ops?: unknown }
    const promptRaw = typeof candidate.prompt === "string" ? candidate.prompt : typeof candidate.input === "string" ? candidate.input : ""
    const prompt = promptRaw.trim()
    if (!prompt) continue
    const id = typeof candidate.id === "string" && candidate.id.trim().length > 0 ? candidate.id.trim() : `prompt-${index + 1}`
    const expectedOps = parseExpectedOps(candidate.expectedOps ?? candidate.expected_ops)
    items.push({ id, prompt, expectedOps })
  }
  if (items.length === 0) {
    throw new Error("prompts file contains no valid prompts")
  }
  return items
}

function expandPromptCases(baseCases: PromptCase[], variants: number): PromptCase[] {
  if (variants <= 1) return baseCases
  const templates = [
    (prompt: string) => `Please apply this request: ${prompt}`,
    (prompt: string) => `Editor task: ${prompt}`,
    (prompt: string) => `${prompt}\n\nKeep the operation precise and minimal.`,
    (prompt: string) => `Can you do this website update?\n${prompt}`,
    (prompt: string) => `Need this implemented now: ${prompt}`
  ]

  const out: PromptCase[] = []
  for (const item of baseCases) {
    out.push(item)
    for (let i = 1; i < variants; i += 1) {
      const template = templates[(i - 1) % templates.length]
      const id = `${item.id}__v${i + 1}`
      out.push({
        id,
        prompt: template(item.prompt),
        expectedOps: item.expectedOps
      })
    }
  }
  return out
}

function chooseProvider(model: string, mode: ProviderMode): Provider {
  if (mode === "openai") return "openai"
  if (mode === "anthropic") return "anthropic"
  return model.toLowerCase().startsWith("claude") ? "anthropic" : "openai"
}

function chooseEndpoint(model: string, mode: EndpointMode, provider: Provider): Exclude<EndpointMode, "auto"> {
  if (provider === "anthropic") return "messages"
  if (mode === "chat" || mode === "responses") return mode
  if (model.toLowerCase().includes("codex")) return "responses"
  return "chat"
}

function extractAnthropicText(source: unknown): string {
  const content = (source as { content?: unknown } | null)?.content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
    if (!block || typeof block !== "object") continue
    if (block.type !== "text") continue
    if (typeof block.text === "string" && block.text.trim().length > 0) parts.push(block.text)
  }
  return parts.join("\n")
}

function extractAnthropicUsage(source: unknown): Usage {
  const usage = (source as { usage?: unknown } | null)?.usage as Record<string, unknown> | undefined
  if (!usage) return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0
  return {
    inputTokens: Math.max(0, inputTokens),
    outputTokens: Math.max(0, outputTokens),
    totalTokens: Math.max(0, inputTokens + outputTokens)
  }
}

function extractUsage(source: unknown): Usage {
  const usage = (source as { usage?: unknown } | null)?.usage as Record<string, unknown> | undefined
  if (!usage) return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }

  const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0
  const completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : promptTokens
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : completionTokens
  const totalTokens =
    typeof usage.total_tokens === "number" ? usage.total_tokens : Math.max(0, inputTokens) + Math.max(0, outputTokens)
  return {
    inputTokens: Math.max(0, inputTokens),
    outputTokens: Math.max(0, outputTokens),
    totalTokens: Math.max(0, totalTokens)
  }
}

function estimateUsd(model: string, usage: Usage) {
  const pricing = USD_PER_MTOK[model]
  if (!pricing) return null
  return usage.inputTokens / 1_000_000 * pricing.input + usage.outputTokens / 1_000_000 * pricing.output
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))))
  return sorted[idx]
}

function mean(values: number[]) {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function formatUsd(value: number | null) {
  if (value === null) return "n/a"
  if (value >= 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(6)}`
}

function aggregate(rows: RunResult[]): Aggregate {
  const okRows = rows.filter((row) => !row.error)
  const latencies = okRows.map((row) => row.latencyMs)
  const usdValues = okRows.map((row) => row.estimatedUsd).filter((row): row is number => typeof row === "number")
  return {
    ok: okRows.length,
    total: rows.length,
    successRate: rows.length > 0 ? okRows.length / rows.length : 0,
    p50LatencyMs: Math.round(percentile(latencies, 50)),
    p95LatencyMs: Math.round(percentile(latencies, 95)),
    avgInputTokens: mean(okRows.map((row) => row.usage.inputTokens)),
    avgOutputTokens: mean(okRows.map((row) => row.usage.outputTokens)),
    avgUsd: usdValues.length > 0 ? mean(usdValues) : null,
    totalUsd: usdValues.length > 0 ? usdValues.reduce((sum, value) => sum + value, 0) : null
  }
}

function aggregateCommand(rows: RunResult[]) {
  const evaluated = rows.map((row) => row.commandEval).filter((item): item is CommandEval => !!item)
  return {
    cases: evaluated.length,
    exactMatchRate: evaluated.length > 0 ? mean(evaluated.map((item) => (item.exactMatch ? 1 : 0))) : 0,
    avgPrecision: evaluated.length > 0 ? mean(evaluated.map((item) => item.precision)) : 0,
    avgRecall: evaluated.length > 0 ? mean(evaluated.map((item) => item.recall)) : 0,
    avgF1: evaluated.length > 0 ? mean(evaluated.map((item) => item.f1)) : 0
  }
}

function normalize(value: number, min: number, max: number) {
  if (max <= min) return 1
  return (value - min) / (max - min)
}

function inverseNormalize(value: number, min: number, max: number) {
  return 1 - normalize(value, min, max)
}

function winnerLabel(scored: ScoredAggregate | undefined) {
  if (!scored) return "n/a"
  return `${scored.model} (${scored.score.toFixed(3)})`
}

function printPromptWinners(
  promptIds: string[],
  models: string[],
  rows: RunResult[],
  weightedByPrompt: Map<string, ScoredAggregate[]>
) {
  console.log("\nPer Prompt Winners")
  console.log("prompt | fastest (p50 ms) | cheapest (avg $/req) | most reliable (ok/total) | weighted winner")

  for (const promptId of promptIds) {
    const aggregates = models
      .map((model) => {
        const promptRows = rows.filter((row) => row.promptId === promptId && row.model === model)
        return { model, aggregate: aggregate(promptRows) }
      })
      .filter((item) => item.aggregate.total > 0)
    const withSuccess = aggregates.filter((item) => item.aggregate.ok > 0)

    const fastest = withSuccess.sort((a, b) => a.aggregate.p50LatencyMs - b.aggregate.p50LatencyMs)[0]
    const cheapest = withSuccess
      .filter((item) => item.aggregate.avgUsd !== null)
      .sort((a, b) => (a.aggregate.avgUsd as number) - (b.aggregate.avgUsd as number))[0]
    const reliable = aggregates.sort((a, b) => b.aggregate.successRate - a.aggregate.successRate || b.aggregate.ok - a.aggregate.ok)[0]
    const weightedWinner = weightedByPrompt.get(promptId)?.[0]

    const fastestLabel = fastest ? `${fastest.model} (${fastest.aggregate.p50LatencyMs})` : "n/a"
    const cheapestLabel = cheapest ? `${cheapest.model} (${formatUsd(cheapest.aggregate.avgUsd)})` : "n/a"
    const reliableLabel =
      reliable && reliable.aggregate.successRate > 0 ? `${reliable.model} (${reliable.aggregate.ok}/${reliable.aggregate.total})` : "n/a"
    console.log(`${promptId} | ${fastestLabel} | ${cheapestLabel} | ${reliableLabel} | ${winnerLabel(weightedWinner)}`)
  }
}

function printCommandAccuracy(prompts: PromptCase[], models: string[], rows: RunResult[]) {
  const promptsWithExpected = prompts.filter((prompt) => Array.isArray(prompt.expectedOps) && prompt.expectedOps.length > 0)
  if (promptsWithExpected.length === 0) return

  console.log("\nCommand Accuracy (expected op coverage)")
  console.log("model | cases | exact match | avg f1 | avg recall | avg precision")
  for (const model of models) {
    const modelRows = rows.filter((row) => row.model === model)
    const summary = aggregateCommand(modelRows)
    if (summary.cases === 0) continue
    console.log(
      `${model} | ${summary.cases} | ${(summary.exactMatchRate * 100).toFixed(1)}% | ${summary.avgF1.toFixed(3)} | ${summary.avgRecall.toFixed(3)} | ${summary.avgPrecision.toFixed(3)}`
    )
  }

  console.log("\nPer Prompt Command Accuracy")
  console.log("prompt | expected ops | best model (f1) | exact match")
  for (const prompt of promptsWithExpected) {
    const byModel = models
      .map((model) => {
        const promptRows = rows.filter((row) => row.model === model && row.promptId === prompt.id)
        const summary = aggregateCommand(promptRows)
        return { model, summary }
      })
      .filter((item) => item.summary.cases > 0)
      .sort((a, b) => b.summary.avgF1 - a.summary.avgF1 || b.summary.exactMatchRate - a.summary.exactMatchRate)
    const best = byModel[0]
    const bestLabel = best ? `${best.model} (${best.summary.avgF1.toFixed(3)})` : "n/a"
    const exactLabel = best ? `${(best.summary.exactMatchRate * 100).toFixed(1)}%` : "n/a"
    console.log(`${prompt.id} | ${(prompt.expectedOps as string[]).join(",")} | ${bestLabel} | ${exactLabel}`)
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2))
  if (args.has("help")) {
    console.log(`Usage:
  pnpm -C apps/orchestrator benchmark:models [options]

Options:
  --model gpt-4o-mini
  --models "gpt-4o-mini,gpt-4o,gpt-5.2,gpt-5.2-codex"
  --runs 3
  --endpoint auto|chat|responses
  --provider auto|openai|anthropic
  --eval-mode text|ops-json
  --ops-cardinality single|multi
  --variants 1
  --max-output-tokens 400
  --weight-reliability 0.4
  --weight-latency 0.35
  --weight-cost 0.25
  --prompts /absolute/or/relative/path/to/prompts.json
  --out ../../.data/model-benchmark.json

Prompts file format:
  JSON array of strings, or objects with { id, prompt, expectedOps }.
`)
    return
  }

  const modelArg = args.get("model")?.trim()
  const modelsArg = args.get("models")
  const rawModels = modelArg && modelArg.length > 0 ? modelArg : (modelsArg ?? DEFAULT_MODELS.join(","))
  const models = rawModels
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  if (models.length === 0) throw new Error("No models provided")

  const runs = toInt(args.get("runs"), 3)
  const variants = toInt(args.get("variants"), 1)
  const maxOutputTokens = toInt(args.get("max-output-tokens"), 400)
  const evalMode = toEvalMode(args.get("eval-mode"))
  const opsCardinalityRaw = (args.get("ops-cardinality") ?? "single").trim().toLowerCase()
  const opsCardinality: OpsCardinality = opsCardinalityRaw === "multi" ? "multi" : "single"
  const providerModeRaw = (args.get("provider") ?? "auto").trim().toLowerCase()
  const providerMode: ProviderMode =
    providerModeRaw === "openai" || providerModeRaw === "anthropic" || providerModeRaw === "auto"
      ? providerModeRaw
      : "auto"
  const endpointModeRaw = (args.get("endpoint") ?? "auto").trim()
  const endpointMode: EndpointMode =
    endpointModeRaw === "chat" || endpointModeRaw === "responses" || endpointModeRaw === "messages" || endpointModeRaw === "auto"
      ? endpointModeRaw
      : "auto"
  const promptsFile = args.get("prompts")
  const basePrompts = promptsFile ? parsePrompts(await readFile(resolve(process.cwd(), promptsFile), "utf8")) : DEFAULT_PROMPTS
  const prompts = expandPromptCases(basePrompts, variants)
  const outPath = args.get("out") ? resolve(process.cwd(), args.get("out") as string) : null
  const rawWeights = {
    reliability: Number.parseFloat(args.get("weight-reliability") ?? "0.4"),
    latency: Number.parseFloat(args.get("weight-latency") ?? "0.35"),
    cost: Number.parseFloat(args.get("weight-cost") ?? "0.25")
  }
  const safeWeights = {
    reliability: Number.isFinite(rawWeights.reliability) && rawWeights.reliability >= 0 ? rawWeights.reliability : 0.4,
    latency: Number.isFinite(rawWeights.latency) && rawWeights.latency >= 0 ? rawWeights.latency : 0.35,
    cost: Number.isFinite(rawWeights.cost) && rawWeights.cost >= 0 ? rawWeights.cost : 0.25
  }
  const weightTotal = safeWeights.reliability + safeWeights.latency + safeWeights.cost
  const weights =
    weightTotal > 0
      ? {
          reliability: safeWeights.reliability / weightTotal,
          latency: safeWeights.latency / weightTotal,
          cost: safeWeights.cost / weightTotal
        }
      : { reliability: 0.4, latency: 0.35, cost: 0.25 }

  const needsOpenAI = models.some((model) => chooseProvider(model, providerMode) === "openai")
  const needsAnthropic = models.some((model) => chooseProvider(model, providerMode) === "anthropic")
  if (needsOpenAI && !process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set. Add it to your environment or .env file.")
  }
  if (needsAnthropic && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it to your environment or .env file.")
  }

  const openaiClient = needsOpenAI ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null
  const anthropicClient = needsAnthropic ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null
  const startedAt = new Date().toISOString()
  const results: RunResult[] = []
  const totalRuns = models.length * prompts.length * runs
  let completed = 0

  for (const model of models) {
    const provider = chooseProvider(model, providerMode)
    const endpoint = chooseEndpoint(model, endpointMode, provider)
    for (const promptCase of prompts) {
      for (let runIndex = 0; runIndex < runs; runIndex += 1) {
        const label = `${model} | ${promptCase.id} | run ${runIndex + 1}/${runs}`
        const begin = Date.now()
        try {
          if (endpoint === "messages") {
            if (!anthropicClient) throw new Error("Anthropic client is not configured.")
            const system =
              evalMode === "ops-json"
                ? "You classify website editor requests into operation command(s). Output strict JSON only: {\"ops\":[{\"op\":\"...\"}]}"
                : "You are a concise assistant."
            const user = evalMode === "ops-json" ? buildOpsJsonEvalUserPrompt(promptCase.prompt, opsCardinality) : promptCase.prompt
            const response = await anthropicClient.messages.create({
              model,
              max_tokens: maxOutputTokens,
              system,
              messages: [{ role: "user", content: user }]
            })
            const usage = extractAnthropicUsage(response)
            const outputText = extractAnthropicText(response)
            const predictedOps = evalMode === "ops-json" ? parseOpsFromJsonOutput(outputText, opsCardinality) : undefined
            results.push({
              model,
              promptId: promptCase.id,
              run: runIndex + 1,
              endpoint,
              provider,
              latencyMs: Date.now() - begin,
              usage,
              estimatedUsd: estimateUsd(model, usage),
              outputTextPreview: outputText.slice(0, 500),
              commandEval:
                evalMode === "ops-json"
                  ? evaluateCommandMatchFromPredicted(promptCase.expectedOps, predictedOps ?? [])
                  : evaluateCommandMatch(promptCase.expectedOps, outputText),
              evalMode
            })
          } else if (endpoint === "responses") {
            if (!openaiClient) throw new Error("OpenAI client is not configured.")
            const input =
              evalMode === "ops-json"
                ? [
                    {
                      role: "system" as const,
                      content:
                        "You classify website editor requests into operation command(s). Output strict JSON only: {\"ops\":[{\"op\":\"...\"}]}"
                    },
                    { role: "user" as const, content: buildOpsJsonEvalUserPrompt(promptCase.prompt, opsCardinality) }
                  ]
                : promptCase.prompt
            const response = await openaiClient.responses.create({
              model,
              input,
              max_output_tokens: maxOutputTokens
            })
            const usage = extractUsage(response)
            const outputText = extractResponsesText(response)
            const predictedOps = evalMode === "ops-json" ? parseOpsFromJsonOutput(outputText, opsCardinality) : undefined
            results.push({
              model,
              promptId: promptCase.id,
              run: runIndex + 1,
              endpoint,
              provider,
              latencyMs: Date.now() - begin,
              usage,
              estimatedUsd: estimateUsd(model, usage),
              outputTextPreview: outputText.slice(0, 500),
              commandEval:
                evalMode === "ops-json"
                  ? evaluateCommandMatchFromPredicted(promptCase.expectedOps, predictedOps ?? [])
                  : evaluateCommandMatch(promptCase.expectedOps, outputText),
              evalMode
            })
          } else {
            if (!openaiClient) throw new Error("OpenAI client is not configured.")
            const messages =
              evalMode === "ops-json"
                ? [
                    {
                      role: "system",
                      content:
                        "You classify website editor requests into operation command(s). Output strict JSON only: {\"ops\":[{\"op\":\"...\"}]}"
                    },
                    { role: "user", content: buildOpsJsonEvalUserPrompt(promptCase.prompt, opsCardinality) }
                  ]
                : [{ role: "user", content: promptCase.prompt }]
            const options: Record<string, unknown> = {
              model,
              messages
            }
            if (model.startsWith("gpt-5")) {
              options.max_completion_tokens = maxOutputTokens
            } else {
              options.max_tokens = maxOutputTokens
            }
            // gpt-5 family rejects temperature=0 in chat.completions.
            if (!model.startsWith("gpt-5")) options.temperature = 0

            const completion = await openaiClient.chat.completions.create(options as never)
            const usage = extractUsage(completion)
            const outputText = extractChatText(completion)
            const predictedOps = evalMode === "ops-json" ? parseOpsFromJsonOutput(outputText, opsCardinality) : undefined
            results.push({
              model,
              promptId: promptCase.id,
              run: runIndex + 1,
              endpoint,
              provider,
              latencyMs: Date.now() - begin,
              usage,
              estimatedUsd: estimateUsd(model, usage),
              outputTextPreview: outputText.slice(0, 500),
              commandEval:
                evalMode === "ops-json"
                  ? evaluateCommandMatchFromPredicted(promptCase.expectedOps, predictedOps ?? [])
                  : evaluateCommandMatch(promptCase.expectedOps, outputText),
              evalMode
            })
          }
          completed += 1
          console.log(`[${completed}/${totalRuns}] OK ${label}`)
        } catch (error) {
          completed += 1
          const message = error instanceof Error ? error.message : "unknown error"
          results.push({
            model,
            promptId: promptCase.id,
            run: runIndex + 1,
            endpoint,
            provider,
            latencyMs: Date.now() - begin,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            estimatedUsd: null,
            commandEval: evaluateCommandMatch(promptCase.expectedOps, ""),
            evalMode,
            error: message
          })
          console.log(`[${completed}/${totalRuns}] ERR ${label}: ${message}`)
        }
      }
    }
  }

  const byModel = new Map<string, RunResult[]>()
  for (const result of results) {
    const current = byModel.get(result.model) ?? []
    current.push(result)
    byModel.set(result.model, current)
  }

  const overallByModel = new Map<string, Aggregate>()
  for (const model of models) {
    overallByModel.set(model, aggregate(byModel.get(model) ?? []))
  }

  const modelRowsForScoring = models
    .map((model) => ({ model, aggregate: overallByModel.get(model) as Aggregate }))
    .filter((item) => item.aggregate.ok > 0)
  const latencyValues = modelRowsForScoring.map((item) => item.aggregate.p50LatencyMs)
  const costValues = modelRowsForScoring.map((item) => item.aggregate.avgUsd ?? Number.POSITIVE_INFINITY).filter(Number.isFinite)
  const minLatency = latencyValues.length > 0 ? Math.min(...latencyValues) : 0
  const maxLatency = latencyValues.length > 0 ? Math.max(...latencyValues) : 0
  const minCost = costValues.length > 0 ? Math.min(...costValues) : 0
  const maxCost = costValues.length > 0 ? Math.max(...costValues) : 0

  const overallScored: ScoredAggregate[] = modelRowsForScoring
    .map((item) => {
      const latencyScore = inverseNormalize(item.aggregate.p50LatencyMs, minLatency, maxLatency)
      const costScore =
        item.aggregate.avgUsd === null ? 0 : inverseNormalize(item.aggregate.avgUsd, minCost, maxCost)
      const reliabilityScore = item.aggregate.successRate
      const performanceScore = latencyScore * weights.latency + costScore * weights.cost
      const score = reliabilityScore * weights.reliability + performanceScore * reliabilityScore
      return { ...item, score }
    })
    .sort((a, b) => b.score - a.score)

  const weightedByPrompt = new Map<string, ScoredAggregate[]>()
  for (const prompt of prompts) {
    const promptRows = models
      .map((model) => {
        const rows = results.filter((row) => row.promptId === prompt.id && row.model === model)
        return { model, aggregate: aggregate(rows) }
      })
      .filter((item) => item.aggregate.total > 0 && item.aggregate.ok > 0)

    const promptLatencies = promptRows.map((item) => item.aggregate.p50LatencyMs)
    const promptCosts = promptRows.map((item) => item.aggregate.avgUsd ?? Number.POSITIVE_INFINITY).filter(Number.isFinite)
    const promptMinLatency = promptLatencies.length > 0 ? Math.min(...promptLatencies) : 0
    const promptMaxLatency = promptLatencies.length > 0 ? Math.max(...promptLatencies) : 0
    const promptMinCost = promptCosts.length > 0 ? Math.min(...promptCosts) : 0
    const promptMaxCost = promptCosts.length > 0 ? Math.max(...promptCosts) : 0

    const scored = promptRows
      .map((item) => {
        const latencyScore = inverseNormalize(item.aggregate.p50LatencyMs, promptMinLatency, promptMaxLatency)
        const costScore =
          item.aggregate.avgUsd === null ? 0 : inverseNormalize(item.aggregate.avgUsd, promptMinCost, promptMaxCost)
        const reliabilityScore = item.aggregate.successRate
        const performanceScore = latencyScore * weights.latency + costScore * weights.cost
        const score = reliabilityScore * weights.reliability + performanceScore * reliabilityScore
        return { ...item, score }
      })
      .sort((a, b) => b.score - a.score)
    weightedByPrompt.set(prompt.id, scored)
  }

  console.log("\nModel Summary")
  console.log("model | ok/total | p50 ms | p95 ms | avg in tok | avg out tok | avg $/req | total $")
  for (const model of models) {
    const agg = overallByModel.get(model) as Aggregate
    console.log(
      `${model} | ${agg.ok}/${agg.total} | ${agg.p50LatencyMs} | ${agg.p95LatencyMs} | ${agg.avgInputTokens.toFixed(1)} | ${agg.avgOutputTokens.toFixed(1)} | ${formatUsd(agg.avgUsd)} | ${formatUsd(agg.totalUsd)}`
    )
  }

  printPromptWinners(
    prompts.map((prompt) => prompt.id),
    models,
    results,
    weightedByPrompt
  )
  printCommandAccuracy(prompts, models, results)

  console.log("\nWeighted Overall Ranking")
  console.log(
    `weights: reliability=${weights.reliability.toFixed(2)}, latency=${weights.latency.toFixed(2)}, cost=${weights.cost.toFixed(2)}`
  )
  console.log("rank | model | weighted score | reliability | p50 ms | avg $/req")
  for (const [index, item] of overallScored.entries()) {
    console.log(
      `${index + 1} | ${item.model} | ${item.score.toFixed(3)} | ${(item.aggregate.successRate * 100).toFixed(1)}% | ${item.aggregate.p50LatencyMs} | ${formatUsd(item.aggregate.avgUsd)}`
    )
  }

  const finishedAt = new Date().toISOString()
  const report = {
    startedAt,
    finishedAt,
    config: {
      models,
      runs,
      endpointMode,
      evalMode,
      opsCardinality,
      maxOutputTokens,
      scoringWeights: weights,
      prompts: prompts.map((item) => ({ id: item.id, prompt: item.prompt, expectedOps: item.expectedOps ?? [] }))
    },
    pricingUsdPerMillionTokens: USD_PER_MTOK,
    modelSummary: Object.fromEntries(models.map((model) => [model, overallByModel.get(model)])),
    commandAccuracy: {
      modelSummary: Object.fromEntries(
        models.map((model) => {
          const modelRows = results.filter((row) => row.model === model)
          return [model, aggregateCommand(modelRows)]
        })
      ),
      perPrompt: Object.fromEntries(
        prompts
          .filter((prompt) => Array.isArray(prompt.expectedOps) && prompt.expectedOps.length > 0)
          .map((prompt) => [
            prompt.id,
            Object.fromEntries(
              models.map((model) => {
                const promptRows = results.filter((row) => row.model === model && row.promptId === prompt.id)
                return [model, aggregateCommand(promptRows)]
              })
            )
          ])
      )
    },
    promptWinners: Object.fromEntries(
      prompts.map((prompt) => [
        prompt.id,
        (weightedByPrompt.get(prompt.id) ?? []).map((item) => ({ model: item.model, score: item.score, aggregate: item.aggregate }))
      ])
    ),
    overallRanking: overallScored.map((item) => ({ model: item.model, score: item.score, aggregate: item.aggregate })),
    results
  }

  if (outPath) {
    await mkdir(dirname(outPath), { recursive: true })
    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
    console.log(`\nReport written to ${outPath}`)
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : "unknown error"
  console.error(`Benchmark failed: ${message}`)
  process.exit(1)
})
