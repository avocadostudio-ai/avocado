import OpenAI from "openai"
import { z } from "zod"
import {
  allowedBlockTypes,
  blockSchemas,
  editPlanSchema,
  type BlockManifest,
  type EditPlan,
  type Operation,
  type PageDoc
} from "@ai-site-editor/shared"
import { buildIntentParserSystemPrompt, buildPlannerSystemPrompt } from "./prompts.js"
import { isDemoModeEnabled } from "../demo-mode.js"

// ---------------------------------------------------------------------------
// Singleton OpenAI client — reuses connection pool across requests.
// ---------------------------------------------------------------------------
let _openaiSingleton: OpenAI | null = null
function getOpenAIClient(): OpenAI {
  if (!_openaiSingleton) {
    _openaiSingleton = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  }
  return _openaiSingleton
}

/** Reset the singleton (useful for tests that swap API keys). */
export function resetOpenAIClient() {
  _openaiSingleton = null
}
import {
  type ParsedIntent,
  extractAudienceTarget,
  blockContractsSummary,
  fetchImageAsBase64,
  pageMetaContractSummary,
  intentSchema,
  plannerContextPack
} from "../nlp/deterministic-planner.js"
import { isBatchAddRequest, isBatchRemoveRequest, isBatchReorderRequest, isPageWideRewriteRequest } from "../nlp/intent-detection.js"
import {
  extractJsonObject,
  inferBlockTypeFromText,
  normalizePlanCandidate,
  repairJson,
  repairAndParseJson,
  repairAndParseJsonWithMeta
} from "../nlp/plan-normalizer.js"
import { type TokenUsage, extractUsage, ZERO_USAGE } from "../telemetry/usage.js"
import { intentJsonSchema } from "./plan-json-schema.js"
import type { ToolRuntime } from "../tools/runtime.js"
import type { ToolExecutionEvent } from "../tools/types.js"
import {
  PlannerError,
  isPlannerError,
  type PlannerFailureReasonCategory
} from "../errors.js"

// Re-export for backward compatibility
export { PlannerError, isPlannerError }
export type { PlannerFailureReasonCategory }

/** @deprecated Use `PlannerError` instead. */
export const PlannerOutputError = PlannerError
/** @deprecated Use `isPlannerError` instead. */
export const isPlannerOutputError = isPlannerError

const rawPlanCandidateSchema = z.looseObject({
  intent: z.enum(["edit_plan", "needs_clarification", "content_answer"]).optional().catch(undefined),
  summary_for_user: z.string().optional(),
  change_log: z.union([z.array(z.string()), z.string()]).optional(),
  ops: z.array(z.record(z.string(), z.unknown())).optional(),
  suggested_next_actions: z.union([z.array(z.string()), z.string()]).optional()
})

function asObject(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null
}

function toPlannerError(category: PlannerFailureReasonCategory, message: string, retryable = false) {
  return new PlannerError(message, { reasonCategory: category, retryable })
}

function extractCompletionRefusal(completion: unknown): string | null {
  const choices = asObject(completion)?.choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const choice = asObject(choices[0])
  const message = asObject(choice?.message)
  const refusal = message?.refusal
  return typeof refusal === "string" && refusal.trim().length > 0 ? refusal.trim() : null
}

function extractResponsesOutcome(response: unknown): { refusal: string | null; incomplete: boolean } {
  const directRefusal = asObject(response)?.refusal
  if (typeof directRefusal === "string" && directRefusal.trim().length > 0) {
    return { refusal: directRefusal.trim(), incomplete: false }
  }
  const status = asObject(response)?.status
  if (status === "incomplete") return { refusal: null, incomplete: true }
  const output = asObject(response)?.output
  if (Array.isArray(output)) {
    for (const item of output) {
      const refusal = asObject(item)?.refusal
      if (typeof refusal === "string" && refusal.trim().length > 0) return { refusal: refusal.trim(), incomplete: false }
      const itemStatus = asObject(item)?.status
      if (itemStatus === "incomplete") return { refusal: null, incomplete: true }
    }
  }
  return { refusal: null, incomplete: false }
}

export function isChatStrictPrimaryOpMode() {
  return /^(1|true|yes|on)$/i.test((process.env.CHAT_STRICT_PRIMARY_OP_MODE ?? "").trim())
}

export function isPageWideTranslationRequest(message: string) {
  const lower = message.toLowerCase()
  const asksTranslation =
    /\btranslate\b/.test(lower) ||
    /\btranslation\b/.test(lower) ||
    /\blocaliz/.test(lower) ||
    /\bgerman\b/.test(lower) ||
    /\bdeutsch\b/.test(lower)
  if (!asksTranslation) return false
  return (
    /\b(this|the|entire|whole|full)\s+(\w+\s+)*page\b/.test(lower) ||
    /\bwhole\s+site\b/.test(lower) ||
    /\ball\s+sections?\b/.test(lower) ||
    /\btranslate\s+(\w+\s+)*page\b/.test(lower)
  )
}

export type PlannerContractMode = "minimal" | "targeted" | "full"

export type PlannerSchemaContextMeta = {
  contractMode: PlannerContractMode
  contractBytes: number
  contractBlockCount: number
  targetBlockTypes: string[]
  strictJsonEnabled: boolean
}

type PlannerSchemaContextPayload = {
  blockContracts?: ReturnType<typeof blockContractsSummary>
  pageMetaContract?: ReturnType<typeof pageMetaContractSummary>
  knownBlockTypes?: string[]
  editPlanShape?: {
    intent: string
    summary_for_user: string
    change_log: string[]
    ops: string[]
    suggested_next_actions: string[]
  }
}

const EDIT_PLAN_SHAPE_HINT = {
  intent: "edit_plan | needs_clarification",
  summary_for_user: "string",
  change_log: ["string"],
  ops: ["Operation[]"],
  suggested_next_actions: ["string (optional, 2-4 items)"]
}

export function isStrictJsonResponseEnabled() {
  return /^(1|true|yes|on)$/i.test((process.env.CHAT_STRICT_JSON_RESPONSE ?? "").trim())
}

export function isAdaptiveSchemaContextEnabled() {
  return /^(1|true|yes|on)$/i.test((process.env.CHAT_ADAPTIVE_SCHEMA_CONTEXT ?? "").trim())
}

function schemaBudgetBytes() {
  const parsed = Number(process.env.CHAT_SCHEMA_BUDGET_BYTES ?? "9000")
  if (!Number.isFinite(parsed) || parsed <= 0) return 9000
  return Math.max(512, Math.trunc(parsed))
}

function bytesForPayload(value: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8")
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

function uniqueBlockTypes(values: unknown[]) {
  const known = new Set(allowedBlockTypes.map((type) => type.toLowerCase()))
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue
    const normalized = value.toLowerCase()
    if (!known.has(normalized) || seen.has(normalized)) continue
    seen.add(normalized)
    const canonical = allowedBlockTypes.find((type) => type.toLowerCase() === normalized)
    if (canonical) out.push(canonical)
  }
  return out
}

function pickTargetBlockTypes(args: {
  message: string
  contextPack: ReturnType<typeof plannerContextPack>
}) {
  const selectedType = typeof args.contextPack.selected.blockType === "string" ? args.contextPack.selected.blockType : null
  const inferredFromMessage = inferBlockTypeFromText(args.message)
  const referencedTypes = [
    args.contextPack.resolvedReferences.target?.type,
    args.contextPack.resolvedReferences.anchor?.type,
    ...args.contextPack.resolvedReferences.mentionedBlocks.map((item) => item.type)
  ]
  return uniqueBlockTypes([selectedType, inferredFromMessage, ...referencedTypes])
}

function shouldUseMinimalContracts(message: string) {
  const lower = message.toLowerCase()
  if (/\b(seo|meta|metadata|og\s*image|open\s*graph)\b/.test(lower)) return false
  if (/\b(translate|translation|localiz)\b/.test(lower)) return false
  if (/\b(create|add|insert|build|generate|update|change|edit|rewrite|rephrase)\b/.test(lower)) return false
  return (
    /\b(remove|delete|move|reorder|rename)\b/.test(lower) ||
    /\b(remove|delete|move|reorder|rename)\b.*\bpage\b/.test(lower)
  )
}

function shouldUseFullContracts(args: {
  message: string
  batchOverride: boolean
  pageWideTranslation: boolean
  forceFullContracts: boolean
  targetBlockTypes: string[]
}) {
  if (args.forceFullContracts) return true
  if (args.pageWideTranslation || args.batchOverride) return true
  const lower = args.message.toLowerCase()
  const structuralGeneration =
    /\b(create|add|insert|build|generate)\b/.test(lower) &&
    !/\b(page|meta|seo)\b/.test(lower) &&
    args.targetBlockTypes.length === 0
  if (structuralGeneration) return true
  return false
}

function buildContractsForMode(args: {
  mode: PlannerContractMode
  targetBlockTypes: string[]
  includePageMetaContract: boolean
  allContracts: ReturnType<typeof blockContractsSummary>
  knownBlockTypes: string[]
}): PlannerSchemaContextPayload {
  const payload: PlannerSchemaContextPayload = {
    knownBlockTypes: args.knownBlockTypes,
    editPlanShape: EDIT_PLAN_SHAPE_HINT
  }
  const allContracts = args.allContracts

  if (args.mode === "full") {
    payload.blockContracts = allContracts
  } else if (args.mode === "targeted") {
    const filtered: Record<string, ReturnType<typeof blockContractsSummary>[string]> = {}
    for (const type of args.targetBlockTypes) {
      if (type in allContracts) filtered[type] = allContracts[type]!
    }
    if (Object.keys(filtered).length > 0) payload.blockContracts = filtered
  }

  if (args.includePageMetaContract) payload.pageMetaContract = pageMetaContractSummary()
  return payload
}

export function buildPlannerSchemaContext(args: {
  message: string
  contextPack: ReturnType<typeof plannerContextPack>
  batchOverride: boolean
  pageWideTranslation: boolean
  legacyIncludeContracts: boolean
  forceFullContracts?: boolean
  componentsManifest?: BlockManifest
  effectiveBlockTypes?: string[]
}): { payload: PlannerSchemaContextPayload; meta: PlannerSchemaContextMeta } {
  const strictJsonEnabled = isStrictJsonResponseEnabled()
  const targetBlockTypes = pickTargetBlockTypes({ message: args.message, contextPack: args.contextPack })
  const includePageMetaContract = /\b(seo|meta|metadata|og\s*image|open\s*graph|description|structured\s*data|schema\.org)\b/i.test(args.message) || /\d{2,3}\s*char/i.test(args.message)
  const knownTypes = args.effectiveBlockTypes
    ?? (args.componentsManifest ? args.componentsManifest.blocks.map(c => c.type) : Object.keys(blockSchemas))
  const allContracts = blockContractsSummary(args.componentsManifest)

  if (!isAdaptiveSchemaContextEnabled()) {
    const payload: PlannerSchemaContextPayload = args.legacyIncludeContracts
      ? {
          blockContracts: allContracts,
          pageMetaContract: pageMetaContractSummary(),
          knownBlockTypes: knownTypes,
          editPlanShape: EDIT_PLAN_SHAPE_HINT
        }
      : {}
    const contractBlockCount = payload.blockContracts ? Object.keys(payload.blockContracts).length : 0
    return {
      payload,
      meta: {
        contractMode: args.legacyIncludeContracts ? "full" : "minimal",
        contractBytes: bytesForPayload(payload),
        contractBlockCount,
        targetBlockTypes,
        strictJsonEnabled
      }
    }
  }

  const forceFullContracts = args.forceFullContracts === true
  const preferredMode: PlannerContractMode = shouldUseFullContracts({
    message: args.message,
    batchOverride: args.batchOverride,
    pageWideTranslation: args.pageWideTranslation,
    forceFullContracts,
    targetBlockTypes
  })
    ? "full"
    : shouldUseMinimalContracts(args.message)
      ? "minimal"
      : "targeted"
  const fallbackOrder: PlannerContractMode[] =
    preferredMode === "full"
      ? ["full", "targeted", "minimal"]
      : preferredMode === "targeted"
        ? ["targeted", "minimal"]
        : ["minimal"]

  const budget = schemaBudgetBytes()
  let selectedMode = fallbackOrder[0]!
  let selectedPayload = buildContractsForMode({
    mode: selectedMode,
    targetBlockTypes,
    includePageMetaContract,
    allContracts,
    knownBlockTypes: knownTypes
  })
  let selectedBytes = bytesForPayload(selectedPayload)

  for (const mode of fallbackOrder) {
    const payload = buildContractsForMode({ mode, targetBlockTypes, includePageMetaContract, allContracts, knownBlockTypes: knownTypes })
    const bytes = bytesForPayload(payload)
    selectedMode = mode
    selectedPayload = payload
    selectedBytes = bytes
    if (bytes <= budget) break
  }

  const contractBlockCount = selectedPayload.blockContracts ? Object.keys(selectedPayload.blockContracts).length : 0
  return {
    payload: selectedPayload,
    meta: {
      contractMode: selectedMode,
      contractBytes: selectedBytes,
      contractBlockCount,
      targetBlockTypes,
      strictJsonEnabled
    }
  }
}

export type PlannerOpenAIClient = {
  chat: {
    completions: {
      create: (args: unknown) => any
    }
  }
  responses: {
    create: (args: unknown) => any
  }
}

export function openAIChatOptionsForModel(model: string) {
  // o-series and gpt-5 family reject temperature in chat.completions; omit to use model default.
  const lower = model.toLowerCase()
  if (lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4") || lower.startsWith("gpt-5")) return {}
  return { temperature: 0 as const }
}

export function isResponsesOnlyModel(_model: string) {
  // No current OpenAI model requires the Responses API exclusively; all supported models
  // use chat.completions. Update this if a future model mandates the Responses API.
  return false
}

export function extractResponsesOutputText(response: unknown) {
  const direct = (response as { output_text?: unknown } | null)?.output_text
  if (typeof direct === "string" && direct.length > 0) return direct

  const output = (response as { output?: unknown } | null)?.output
  if (!Array.isArray(output)) return ""

  const chunks: string[] = []
  for (const item of output as Array<{ content?: unknown }>) {
    if (!item || typeof item !== "object") continue
    const content = item.content
    if (!Array.isArray(content)) continue
    for (const part of content as Array<{ text?: unknown; type?: unknown }>) {
      if (!part || typeof part !== "object") continue
      if (part.type === "output_text" && typeof part.text === "string") chunks.push(part.text)
    }
  }
  return chunks.join("")
}

export function extractSummaryFromPlanBuffer(raw: string): { summary: string | null; changeLog: string[] } {
  // Extract summary_for_user value (may be partial if string is still open)
  let summary: string | null = null
  const summaryKey = '"summary_for_user"'
  const summaryKeyIdx = raw.indexOf(summaryKey)
  if (summaryKeyIdx >= 0) {
    const afterKey = raw.indexOf(":", summaryKeyIdx + summaryKey.length)
    if (afterKey >= 0) {
      const quoteStart = raw.indexOf('"', afterKey + 1)
      if (quoteStart >= 0) {
        // Scan for closing quote respecting escapes
        let escape = false
        let closeIdx = -1
        for (let i = quoteStart + 1; i < raw.length; i++) {
          const ch = raw[i]!
          if (escape) { escape = false; continue }
          if (ch === "\\") { escape = true; continue }
          if (ch === '"') { closeIdx = i; break }
        }
        if (closeIdx >= 0) {
          // Closed string — use JSON.parse for correct decoding (handles \uXXXX etc.)
          try {
            summary = JSON.parse(raw.slice(quoteStart, closeIdx + 1)) as string
          } catch {
            // Fallback: return raw content without quotes
            summary = raw.slice(quoteStart + 1, closeIdx)
          }
        } else {
          // Still open (partial/streaming) — manual decode is acceptable
          let value = ""
          let esc = false
          for (let i = quoteStart + 1; i < raw.length; i++) {
            const ch = raw[i]!
            if (esc) {
              if (ch === "n") value += "\n"
              else if (ch === "t") value += "\t"
              else if (ch === "r") value += "\r"
              else value += ch
              esc = false
              continue
            }
            if (ch === "\\") { esc = true; continue }
            value += ch
          }
          if (value.length > 0) summary = value
        }
      }
    }
  }

  // Extract change_log string entries
  const changeLog: string[] = []
  const clKey = '"change_log"'
  const clKeyIdx = raw.indexOf(clKey)
  if (clKeyIdx >= 0) {
    const arrStart = raw.indexOf("[", clKeyIdx + clKey.length)
    if (arrStart >= 0) {
      let inString = false
      let escape = false
      let strStart = -1
      let depth = 0
      for (let i = arrStart; i < raw.length; i++) {
        const ch = raw[i]!
        if (inString) {
          if (escape) { escape = false; continue }
          if (ch === "\\") { escape = true; continue }
          if (ch === '"') {
            inString = false
            if (depth === 1 && strStart >= 0) {
              try {
                const parsed = JSON.parse(raw.slice(strStart, i + 1)) as string
                changeLog.push(parsed)
              } catch { /* partial */ }
              strStart = -1
            }
          }
          continue
        }
        if (ch === '"') { inString = true; strStart = i; continue }
        if (ch === "[") { depth++; continue }
        if (ch === "]") { if (--depth <= 0) break; continue }
      }
    }
  }

  return { summary, changeLog }
}

export function extractOpsFromPlanBuffer(raw: string, emittedCount: number) {
  const opsKeyIdx = raw.indexOf('"ops"')
  if (opsKeyIdx < 0) return { nextEmittedCount: emittedCount, newOps: [] as Operation[] }
  const arrStart = raw.indexOf("[", opsKeyIdx)
  if (arrStart < 0) return { nextEmittedCount: emittedCount, newOps: [] as Operation[] }

  const extracted: Operation[] = []
  let inString = false
  let escape = false
  let arrDepth = 0
  let objDepth = 0
  let objStart = -1

  for (let i = arrStart; i < raw.length; i += 1) {
    const ch = raw[i]!
    if (inString) {
      if (escape) {
        escape = false
      } else if (ch === "\\") {
        escape = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === "[") {
      arrDepth += 1
      continue
    }
    if (ch === "]") {
      if (arrDepth > 0) arrDepth -= 1
      if (arrDepth === 0) break
      continue
    }
    if (arrDepth !== 1) continue
    if (ch === "{") {
      if (objDepth === 0) objStart = i
      objDepth += 1
      continue
    }
    if (ch === "}") {
      if (objDepth > 0) objDepth -= 1
      if (objDepth === 0 && objStart >= 0) {
        const json = raw.slice(objStart, i + 1)
        try {
          const parsed = JSON.parse(json) as Operation
          extracted.push(parsed)
        } catch {
          // Ignore partial/invalid object fragments while streaming.
        }
        objStart = -1
      }
    }
  }

  if (extracted.length <= emittedCount) {
    return { nextEmittedCount: emittedCount, newOps: [] as Operation[] }
  }
  return {
    nextEmittedCount: extracted.length,
    newOps: extracted.slice(emittedCount)
  }
}

export type StreamedFieldDraft = {
  opIndex: number
  blockId: string
  editablePath: string
  value: string
}

function decodeJsonStringFragment(fragment: string) {
  let out = ""
  for (let i = 0; i < fragment.length; i += 1) {
    const ch = fragment[i]!
    if (ch !== "\\") {
      out += ch
      continue
    }
    const next = fragment[i + 1]
    if (!next) break
    i += 1
    if (next === "n") out += "\n"
    else if (next === "t") out += "\t"
    else if (next === "r") out += "\r"
    else if (next === "b") out += "\b"
    else if (next === "f") out += "\f"
    else if (next === '"' || next === "\\" || next === "/") out += next
    else if (next === "u") {
      const hex = fragment.slice(i + 1, i + 5)
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(Number.parseInt(hex, 16))
        i += 4
      }
    } else {
      out += next
    }
  }
  return out
}

function parseJsonStringValueFragment(rawValue: string, closed: boolean) {
  if (closed) {
    try {
      return JSON.parse(`"${rawValue}"`) as string
    } catch {
      // Fall through to permissive decoder for malformed edge fragments.
    }
  }
  return decodeJsonStringFragment(rawValue)
}

function findFirstObjectLiteral(raw: string, fromIndex: number) {
  let inString = false
  let escape = false
  let depth = 0
  let objStart = -1
  for (let i = fromIndex; i < raw.length; i += 1) {
    const ch = raw[i]!
    if (inString) {
      if (escape) escape = false
      else if (ch === "\\") escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === "{") {
      if (depth === 0) objStart = i
      depth += 1
      continue
    }
    if (ch === "}") {
      if (depth > 0) depth -= 1
      if (depth === 0 && objStart >= 0) {
        return { body: raw.slice(objStart + 1, i), closed: true as const }
      }
      continue
    }
  }
  if (objStart >= 0) {
    return { body: raw.slice(objStart + 1), closed: false as const }
  }
  return null
}

function extractUpdatePropsDraftsFromPartialOp(raw: string, opIndex: number) {
  const opMatch = /"op"\s*:\s*"((?:\\.|[^"\\])*)(?:"|$)/.exec(raw)
  if (opMatch) {
    const opClosed = opMatch[0].endsWith('"')
    const opName = parseJsonStringValueFragment(opMatch[1] ?? "", opClosed).trim()
    if (opName && opName !== "update_props") return [] as StreamedFieldDraft[]
  } else if (/"(?:listKey|index)"\s*:/.test(raw)) {
    // Ignore update_item-like partial ops before "op" arrives.
    return [] as StreamedFieldDraft[]
  }

  const blockIdMatch = /"blockId"\s*:\s*"((?:\\.|[^"\\])*)(?:"|$)/.exec(raw)
  if (!blockIdMatch) return [] as StreamedFieldDraft[]
  const blockIdClosed = blockIdMatch[0].endsWith('"')
  const blockId = parseJsonStringValueFragment(blockIdMatch[1] ?? "", blockIdClosed).trim()
  if (!blockId) return [] as StreamedFieldDraft[]

  const patchKeyIdx = raw.indexOf('"patch"')
  if (patchKeyIdx < 0) return [] as StreamedFieldDraft[]
  const patchObj = findFirstObjectLiteral(raw, patchKeyIdx)
  if (!patchObj) return [] as StreamedFieldDraft[]

  const drafts: StreamedFieldDraft[] = []
  const entryRegex = /"([^"\\]+)"\s*:\s*"((?:\\.|[^"\\])*)(?:"|$)/g
  let match: RegExpExecArray | null
  while ((match = entryRegex.exec(patchObj.body)) !== null) {
    const editablePath = match[1]?.trim()
    if (!editablePath) continue
    const fullMatch = match[0] ?? ""
    const valueClosed = fullMatch.endsWith('"')
    const value = parseJsonStringValueFragment(match[2] ?? "", valueClosed)
    drafts.push({ opIndex, blockId, editablePath, value })
  }
  return drafts
}

function extractUpdatePropsDraftsFromCompleteOp(raw: string, opIndex: number) {
  try {
    const parsed = JSON.parse(raw) as Operation
    if (parsed.op !== "update_props") return [] as StreamedFieldDraft[]
    const blockId = String(parsed.blockId ?? "").trim()
    if (!blockId) return [] as StreamedFieldDraft[]
    const patch = parsed.patch && typeof parsed.patch === "object" ? parsed.patch as Record<string, unknown> : null
    if (!patch) return [] as StreamedFieldDraft[]
    return Object.entries(patch)
      .filter(([, value]) => typeof value === "string")
      .map(([editablePath, value]) => ({ opIndex, blockId, editablePath, value: value as string }))
  } catch {
    return [] as StreamedFieldDraft[]
  }
}

export function extractUpdatePropsFieldDraftsFromPlanBuffer(raw: string) {
  const opsKeyIdx = raw.indexOf('"ops"')
  if (opsKeyIdx < 0) return [] as StreamedFieldDraft[]
  const arrStart = raw.indexOf("[", opsKeyIdx)
  if (arrStart < 0) return [] as StreamedFieldDraft[]

  const objectSnippets: Array<{ opIndex: number; snippet: string; complete: boolean }> = []
  let inString = false
  let escape = false
  let arrDepth = 0
  let objDepth = 0
  let objStart = -1
  let objectCount = 0
  let arrayClosed = false

  for (let i = arrStart; i < raw.length; i += 1) {
    const ch = raw[i]!
    if (inString) {
      if (escape) {
        escape = false
      } else if (ch === "\\") {
        escape = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === "[") {
      arrDepth += 1
      continue
    }
    if (ch === "]") {
      if (arrDepth > 0) arrDepth -= 1
      if (arrDepth === 0) {
        arrayClosed = true
        break
      }
      continue
    }
    if (arrDepth !== 1) continue

    if (ch === "{") {
      if (objDepth === 0) objStart = i
      objDepth += 1
      continue
    }
    if (ch === "}") {
      if (objDepth > 0) objDepth -= 1
      if (objDepth === 0 && objStart >= 0) {
        objectCount += 1
        objectSnippets.push({ opIndex: objectCount, snippet: raw.slice(objStart, i + 1), complete: true })
        objStart = -1
      }
    }
  }

  if (!arrayClosed && arrDepth >= 1 && objDepth > 0 && objStart >= 0) {
    objectCount += 1
    objectSnippets.push({ opIndex: objectCount, snippet: raw.slice(objStart), complete: false })
  }

  const drafts: StreamedFieldDraft[] = []
  for (const entry of objectSnippets) {
    if (entry.complete) {
      drafts.push(...extractUpdatePropsDraftsFromCompleteOp(entry.snippet, entry.opIndex))
    } else {
      drafts.push(...extractUpdatePropsDraftsFromPartialOp(entry.snippet, entry.opIndex))
    }
  }
  return drafts
}

export async function parseIntentWithOpenAI(args: {
  message: string
  slug: string
  currentPage: PageDoc
  activeBlockId?: string
  activeBlockType?: string
  activeEditablePath?: string
  model: string
  client?: PlannerOpenAIClient
}): Promise<ParsedIntent> {
  const client = args.client ?? (getOpenAIClient() as unknown as PlannerOpenAIClient)
  const system = buildIntentParserSystemPrompt()

  const user = {
    request: args.message,
    slug: args.slug,
    activeBlockId: args.activeBlockId ?? null,
    activeBlockType: args.activeBlockType ?? null,
    activeEditablePath: args.activeEditablePath ?? null,
    availableBlockTypes: allowedBlockTypes,
    blocks: args.currentPage.blocks.map((b) => ({ id: b.id, type: b.type, props: Object.keys(b.props) }))
  }

  const completion = await client.chat.completions.create({
    model: args.model,
    ...openAIChatOptionsForModel(args.model),
    response_format: {
      type: "json_schema" as const,
      json_schema: { name: "IntentResult", schema: intentJsonSchema, strict: true }
    },
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(user) }
    ]
  })

  const raw = completion.choices[0]?.message?.content ?? ""
  if (!raw.trim()) throw new Error("Intent parser did not return JSON")
  // json_schema strict mode guarantees valid JSON matching our schema
  const normalized = JSON.parse(raw) as Record<string, unknown>

  // Nulls from the schema become undefined for Zod optional fields
  for (const key of Object.keys(normalized)) {
    if (normalized[key] === null) delete normalized[key]
  }

  const parsed = intentSchema.safeParse(normalized)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const detail = issue?.message ?? "Invalid intent parser output"
    const at = issue?.path?.length ? ` at ${issue.path.join(".")}` : ""
    throw new Error(`${detail}${at}`)
  }
  return parsed.data
}

export async function generatePlanWithOpenAI(args: {
  message: string
  slug: string
  currentPage: PageDoc
  contextPack: ReturnType<typeof plannerContextPack>
  model: string
  history?: Array<{ role: "user" | "assistant"; content: string }>
  feedback?: string
  onToken?: (token: string) => void
  onFieldDraft?: (draft: { blockId: string; editablePath: string; value: string }) => void
  onPlannedOp?: (op: Operation, index: number) => void
  onSummaryChunk?: (text: string) => void
  onChangeLogEntry?: (entry: string) => void
  onToolExecution?: (event: ToolExecutionEvent) => void
  toolRuntime?: ToolRuntime
  toolCallContext?: { siteId: string; sessionId: string; userId?: string; traceId: string; gdriveFolderId?: string }
  client?: PlannerOpenAIClient
  siteContextBlock?: string | null
  forceFullSchemaContracts?: boolean
  componentsManifest?: BlockManifest
  lightweight?: boolean
  signal?: AbortSignal
  locale?: string
}): Promise<{ plan: EditPlan; usage: TokenUsage; schemaContext: PlannerSchemaContextMeta }> {
  const client = args.client ?? (getOpenAIClient() as unknown as PlannerOpenAIClient)
  const effectiveBlockTypes = args.componentsManifest ? args.componentsManifest.blocks.map(c => c.type) : allowedBlockTypes
  const batchOverride = isBatchAddRequest(args.message) || isBatchRemoveRequest(args.message) || isBatchReorderRequest(args.message) || isPageWideRewriteRequest(args.message)
  const pageWideRewrite = isPageWideRewriteRequest(args.message)
  const pageWideTranslation = isPageWideTranslationRequest(args.message)
  const chatStrictPrimaryOpMode = isChatStrictPrimaryOpMode() && !batchOverride && !pageWideTranslation
  const selectedBlockId = String(args.contextPack.selected.blockId ?? "")
  const audienceHint = extractAudienceTarget(args.message)
  const explicitOtherReference =
    selectedBlockId.length > 0 &&
    Array.isArray(args.contextPack.resolvedReferences.mentionedBlocks) &&
    args.contextPack.resolvedReferences.mentionedBlocks.some(
      (entry) => entry && typeof entry === "object" && "id" in entry && (entry as { id?: unknown }).id !== selectedBlockId
    )

  const system = buildPlannerSystemPrompt({
    provider: "openai",
    lightweight: !!args.lightweight,
    selectedBlockId,
    explicitOtherReference: !!explicitOtherReference,
    chatStrictPrimaryOpMode,
    pageWideTranslation,
    pageWideRewrite,
    effectiveBlockTypes,
    siteContextBlock: args.siteContextBlock,
    imageUrlForVision: args.contextPack.selected?.imageUrlForVision,
    editablePath: args.contextPack.selected?.editablePath,
    blockId: args.contextPack.selected?.blockId,
    locale: args.locale,
    demoMode: isDemoModeEnabled(),
  })

  const lowerMsg = args.message.toLowerCase()
  const includeContracts =
    !args.lightweight && (
      batchOverride ||
      pageWideTranslation ||
      /\b(create|add|insert|build|generate)\b/.test(lowerMsg) ||
      /\b(seo|meta|metadata|og\s*image|open\s*graph|description|structured\s*data|schema\.org)\b/.test(lowerMsg) ||
      /\d{2,3}\s*char/i.test(args.message) ||
      // Multi-field updates need block contracts to know valid prop names
      (lowerMsg.match(/['''"""\u201C\u201D\u2018\u2019]/g)?.length ?? 0) >= 4
    )
  const schemaContext = args.lightweight
    ? {
        payload: {} as PlannerSchemaContextPayload,
        meta: {
          contractMode: "minimal" as PlannerContractMode,
          contractBytes: 0,
          contractBlockCount: 0,
          targetBlockTypes: [] as string[],
          strictJsonEnabled: false
        }
      }
    : buildPlannerSchemaContext({
        message: args.message,
        contextPack: args.contextPack,
        batchOverride,
        pageWideTranslation,
        legacyIncludeContracts: includeContracts,
        forceFullContracts: args.forceFullSchemaContracts,
        componentsManifest: args.componentsManifest
      })

  const user = {
    request: args.message,
    audienceHint: audienceHint ?? null,
    slug: args.slug,
    contextPack: args.contextPack,
    ...schemaContext.payload,
    feedback: args.feedback ?? null
  }

  const imageUrlForVision = typeof args.contextPack.selected?.imageUrlForVision === "string"
    ? args.contextPack.selected.imageUrlForVision
    : null
  const imageBase64 = imageUrlForVision ? await fetchImageAsBase64(imageUrlForVision) : null
  const visionImageUrl = imageBase64
    ? `data:${imageBase64.mediaType};base64,${imageBase64.base64}`
    : imageUrlForVision
  const openaiUserContent: Array<{ type: string; text?: string; image_url?: { url: string; detail: string } }> | string =
    visionImageUrl
      ? [
          { type: "image_url", image_url: { url: visionImageUrl, detail: "low" } },
          { type: "text", text: JSON.stringify(user) }
        ]
      : JSON.stringify(user)

  let raw = ""
  let usage: TokenUsage = { ...ZERO_USAGE }
  let streamedOpsCount = 0
  let lastSummaryLen = 0
  let emittedChangeLogCount = 0
  const emittedFieldDraftByKey = new Map<string, string>()
  if (isResponsesOnlyModel(args.model)) {
    const response = await client.responses.create({
      model: args.model,
      instructions: system,
      input: JSON.stringify(user)
    })
    const responsesOutcome = extractResponsesOutcome(response)
    if (responsesOutcome.refusal) {
      throw toPlannerError("planner_refusal", `Model refused planning output: ${responsesOutcome.refusal}`)
    }
    if (responsesOutcome.incomplete) {
      throw toPlannerError("incomplete_output", "Model returned incomplete planning output")
    }
    raw = extractResponsesOutputText(response)
    usage = extractUsage(response)
    if (args.onToken && raw.length > 0) args.onToken(raw)
  } else if (args.onToken) {
    const stream = await client.chat.completions.create({
      model: args.model,
      ...openAIChatOptionsForModel(args.model),
      stream: true,
      response_format: { type: "json_object" as const },
      messages: [
        { role: "system", content: system },
        ...(args.history ?? []),
        { role: "user", content: openaiUserContent }
      ],
    })
    let sawRefusal = false
    for await (const chunk of stream) {
      const deltaRefusal = (chunk as { choices?: Array<{ delta?: { refusal?: unknown } }> })?.choices?.[0]?.delta?.refusal
      if (typeof deltaRefusal === "string" && deltaRefusal.trim().length > 0) {
        sawRefusal = true
        raw += deltaRefusal
        continue
      }
      const delta = chunk.choices[0]?.delta?.content
      if (typeof delta !== "string" || delta.length === 0) continue
      raw += delta
      args.onToken(delta)
      if (args.onFieldDraft) {
        const fieldDrafts = extractUpdatePropsFieldDraftsFromPlanBuffer(raw)
        for (const draft of fieldDrafts) {
          const key = `${draft.opIndex}:${draft.blockId}:${draft.editablePath}`
          const prev = emittedFieldDraftByKey.get(key)
          if (prev === draft.value) continue
          emittedFieldDraftByKey.set(key, draft.value)
          args.onFieldDraft({ blockId: draft.blockId, editablePath: draft.editablePath, value: draft.value })
        }
      }
      if (args.onSummaryChunk || args.onChangeLogEntry) {
        const extracted = extractSummaryFromPlanBuffer(raw)
        if (extracted.summary && extracted.summary.length > lastSummaryLen) {
          args.onSummaryChunk?.(extracted.summary.slice(lastSummaryLen))
          lastSummaryLen = extracted.summary.length
        }
        for (let i = emittedChangeLogCount; i < extracted.changeLog.length; i++) {
          args.onChangeLogEntry?.(extracted.changeLog[i]!)
        }
        emittedChangeLogCount = extracted.changeLog.length
      }
      if (args.onPlannedOp) {
        const next = extractOpsFromPlanBuffer(raw, streamedOpsCount)
        streamedOpsCount = next.nextEmittedCount
        for (let idx = 0; idx < next.newOps.length; idx += 1) {
          args.onPlannedOp(next.newOps[idx]!, streamedOpsCount - next.newOps.length + idx + 1)
        }
      }
    }
    if (sawRefusal) {
      throw toPlannerError("planner_refusal", `Model refused planning output: ${raw.slice(0, 300)}`)
    }
    if (raw.trim().length === 0) {
      throw toPlannerError("incomplete_output", "Model returned no planning output")
    }
    // Streaming doesn't return per-chunk usage; leave as zero
  } else {
    const completion = await client.chat.completions.create({
      model: args.model,
      ...openAIChatOptionsForModel(args.model),
      response_format: { type: "json_object" as const },
      messages: [
        { role: "system", content: system },
        ...(args.history ?? []),
        { role: "user", content: openaiUserContent }
      ],
    })
    const refusal = extractCompletionRefusal(completion)
    if (refusal) {
      throw toPlannerError("planner_refusal", `Model refused planning output: ${refusal}`)
    }
    raw = completion.choices[0]?.message?.content ?? ""
    if (raw.trim().length === 0) {
      throw toPlannerError("incomplete_output", "Model returned no planning output")
    }
    usage = extractUsage(completion)
  }
  const jsonText = extractJsonObject(raw)
  if (!jsonText) {
    throw toPlannerError("malformed_output", "Model did not return JSON", true)
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(jsonText)
  } catch (err) {
    // Attempt multiple repair strategies before giving up
    try {
      const meta = repairAndParseJsonWithMeta(jsonText)
      parsedJson = meta.parsed
      if (meta.strategy !== "none") {
        console.warn(`[planner] JSON repaired via ${meta.strategy}${meta.mutationCount ? ` (${meta.mutationCount} mutations)` : ""}${meta.discardedBytes ? ` (${meta.discardedBytes}B discarded)` : ""}`)
      }
    } catch {
      const posMatch = err instanceof SyntaxError ? /position (\d+)/i.exec(err.message) : null
      const pos = posMatch?.[1]
      const snippet = pos ? jsonText.slice(Math.max(0, Number(pos) - 30), Number(pos) + 30) : jsonText.slice(0, 200)
      throw toPlannerError("malformed_output", `Model returned malformed JSON: ${(err as Error).message}. Near: …${snippet}…`, true)
    }
  }

  const rawCandidateResult = rawPlanCandidateSchema.safeParse(parsedJson)
  if (!rawCandidateResult.success) {
    const first = rawCandidateResult.error.issues[0]
    const at = first?.path?.length ? ` at ${first.path.join(".")}` : ""
    const detail = first?.message ?? "Raw planner output shape is invalid"
    throw toPlannerError("malformed_output", `${detail}${at}`, true)
  }

  const parsed = normalizePlanCandidate(rawCandidateResult.data, {
    defaultSlug: args.slug,
    currentPage: args.currentPage,
    userMessage: args.message
  })
  const planResult = editPlanSchema.safeParse(parsed)
  if (!planResult.success) {
    const first = planResult.error.issues[0]
    const message = first?.message ?? "Invalid model output"
    const path = first?.path?.length ? ` at ${first.path.join(".")}` : ""
    const sample = JSON.stringify(parsed).slice(0, 700)
    throw toPlannerError("schema_violation", `${message}${path}. Parsed sample: ${sample}`, true)
  }

  if (chatStrictPrimaryOpMode && planResult.data.intent === "edit_plan" && planResult.data.ops.length > 1) {
    return {
      plan: {
        ...planResult.data,
        ops: [planResult.data.ops[0]]
      },
      usage,
      schemaContext: schemaContext.meta
    }
  }
  return { plan: planResult.data, usage, schemaContext: schemaContext.meta }
}
