import { z } from "zod"
import {
  blockSchemas,
  operationSchema,
  type BlockDefinition,
  type BlockManifest,
  type BlockType,
  type Operation,
  type PageDoc,
  validateBlockProps,
  validateByJsonSchemaLike,
  isChrome
} from "@ai-site-editor/shared"
import { normalizeRouteCandidate } from "../nlp/intent-helpers.js"
import { pageIdFromSlug, pageTitleFromSlug } from "../nlp/plan-normalizer.js"
import {
  type GuardrailErrorCategory,
  OperationError,
  toErrorDetail as _unifiedToErrorDetail
} from "../errors.js"
import { isDemoModeEnabled, enforceDemoOps } from "../demo-mode.js"
import type { ContentSource } from "../state/content-source.js"
import { acquireSessionLock } from "../state/session-lock.js"
import {
  getSessionDraft,
  orderSlugsHomeFirst,
  setPage,
  getPage,
  getSiteConfig,
  setSiteConfig
} from "../state/session-state.js"

// ---------------------------------------------------------------------------
// Passthrough Zod schema cache — avoids allocating a new ZodObject per call
// ---------------------------------------------------------------------------

const _passthroughSchemaCache = new Map<string, z.ZodObject<any>>()

function _getPassthroughSchema(blockType: string): z.ZodObject<any> | undefined {
  const cached = _passthroughSchemaCache.get(blockType)
  if (cached) return cached
  const schema = blockSchemas[blockType as BlockType]
  if (!schema) return undefined
  const pt = schema.passthrough()
  _passthroughSchemaCache.set(blockType, pt)
  return pt
}

// ---------------------------------------------------------------------------
// Route link rewriting (used by rename_page operation)
// ---------------------------------------------------------------------------

function remapRouteReference(value: string, fromSlug: string, toSlug: string) {
  if (!value.startsWith("/")) return value
  if (fromSlug === "/") {
    if (value === "/") return toSlug
    if (value.startsWith("/?") || value.startsWith("/#")) return `${toSlug}${value.slice(1)}`
    return value
  }
  if (value === fromSlug) return toSlug
  if (value.startsWith(`${fromSlug}/`) || value.startsWith(`${fromSlug}?`) || value.startsWith(`${fromSlug}#`)) {
    return `${toSlug}${value.slice(fromSlug.length)}`
  }
  return value
}

function rewriteRouteLinksInValue(input: unknown, fromSlug: string, toSlug: string): { value: unknown; changed: boolean } {
  if (typeof input === "string") {
    const mapped = remapRouteReference(input, fromSlug, toSlug)
    return { value: mapped, changed: mapped !== input }
  }

  if (Array.isArray(input)) {
    let changed = false
    const next = input.map((item) => {
      const mapped = rewriteRouteLinksInValue(item, fromSlug, toSlug)
      if (mapped.changed) changed = true
      return mapped.value
    })
    return { value: changed ? next : input, changed }
  }

  if (!input || typeof input !== "object") return { value: input, changed: false }
  const source = input as Record<string, unknown>
  let changed = false
  const next: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && key.toLowerCase().includes("href")) {
      const mapped = remapRouteReference(value, fromSlug, toSlug)
      if (mapped !== value) changed = true
      next[key] = mapped
      continue
    }
    if (typeof value === "string" && key === "body") {
      const rewritten = value.replace(/\]\((\/[^)\s]+)\)/g, (full, routeCandidate: string) => {
        const mapped = remapRouteReference(routeCandidate, fromSlug, toSlug)
        if (mapped !== routeCandidate) return `](${mapped})`
        return full
      })
      if (rewritten !== value) changed = true
      next[key] = rewritten
      continue
    }
    const mapped = rewriteRouteLinksInValue(value, fromSlug, toSlug)
    if (mapped.changed) changed = true
    next[key] = mapped.value
  }

  return { value: changed ? next : input, changed }
}

function rewriteLinksToRenamedPage(page: PageDoc, fromSlug: string, toSlug: string) {
  let changed = false
  const nextBlocks = page.blocks.map((block) => {
    const mapped = rewriteRouteLinksInValue(block.props, fromSlug, toSlug)
    if (!mapped.changed) return block
    changed = true
    return { ...block, props: mapped.value as Record<string, unknown> }
  })
  if (!changed) return { changed: false, page }
  return { changed: true, page: { ...page, blocks: nextBlocks, updatedAt: new Date().toISOString() } }
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

// Re-export the canonical toErrorDetail from errors.ts for backward compat
export const toErrorDetail = _unifiedToErrorDetail

export function isNoEffectiveChangeError(reason: string) {
  return /No effective prop change/i.test(reason)
}

export function classifyGuardrailError(reason: string): GuardrailErrorCategory {
  const lower = reason.toLowerCase()
  if (isNoEffectiveChangeError(reason)) return "no_effective_change"
  if (lower.includes("refused planning output")) return "planner_refusal"
  if (lower.includes("incomplete planning output") || lower.includes("returned no planning output")) return "incomplete_output"
  if (
    lower.includes("did not return json") ||
    lower.includes("malformed json") ||
    lower.includes("raw planner output shape is invalid") ||
    lower.includes("expected ',' or '}'") ||
    lower.includes("no number after minus") ||
    lower.includes("unexpected token") ||
    lower.includes("in json at position")
  ) {
    return "malformed_output"
  }
  if (
    lower.includes("page not found") ||
    lower.includes("blockid") ||
    lower.includes("afterblockid") ||
    lower.includes("not found")
  ) {
    return "not_found"
  }
  if (lower.includes("ambiguous") || lower.includes("clarify") || lower.includes("unclear")) {
    return "ambiguity"
  }
  if (
    lower.includes("invalid") ||
    lower.includes("required") ||
    lower.includes("unknown props") ||
    lower.includes("out of range") ||
    lower.includes("must be")
  ) {
    return "schema_violation"
  }
  return "internal_error"
}

export function formatValidationError(reason: string) {
  return `${classifyGuardrailError(reason)}: ${reason}`
}

export function isDeterministicRepairEligible(reason: string) {
  return classifyGuardrailError(reason) === "schema_violation"
}

/**
 * Extracts structured fields from a planner schema_violation reason so the
 * repair prompt can tell the LLM exactly which path to fix and what kind of
 * violation it was. The reason format produced by planner.ts is:
 *   `<zodMessage> at <path>. Parsed sample: <truncated json>`
 *
 * Falls back gracefully when fields are missing (e.g. non-zod failures that
 * still classify as schema_violation via the keyword matcher).
 */
export function parseSchemaViolationReason(reason: string): {
  path: string | null
  zodMessage: string
  kind:
    | "unknown_key"
    | "missing_required"
    | "type_mismatch"
    | "invalid_enum"
    | "invalid_discriminator"
    | "out_of_range"
    | "string_constraint"
    | "unknown"
} {
  const sampleStripped = reason.replace(/\.\s*Parsed sample:.*$/s, "").trim()
  const pathMatch = /\s+at\s+([^\s.]+(?:\.[^\s.]+)*)\s*$/.exec(sampleStripped)
  const path = pathMatch ? pathMatch[1].trim() : null
  const zodMessage = (path ? sampleStripped.slice(0, pathMatch!.index).trim() : sampleStripped)
    .replace(/\.$/, "")
    .trim()
  const lower = zodMessage.toLowerCase()

  let kind: ReturnType<typeof parseSchemaViolationReason>["kind"] = "unknown"
  if (lower.startsWith("unrecognized key") || lower.includes("unknown props")) kind = "unknown_key"
  else if (lower === "required" || lower.startsWith("required") || lower.includes("is required") || lower.includes("missing"))
    kind = "missing_required"
  else if (lower.startsWith("invalid discriminator")) kind = "invalid_discriminator"
  else if (lower.startsWith("invalid enum")) kind = "invalid_enum"
  else if (lower.startsWith("expected ") && lower.includes("received ")) kind = "type_mismatch"
  else if (lower.includes("out of range") || lower.includes("greater than") || lower.includes("less than")) kind = "out_of_range"
  else if (
    lower.includes("must contain at least") ||
    lower.includes("must contain at most") ||
    lower.includes("too short") ||
    lower.includes("too long")
  )
    kind = "string_constraint"

  return { path, zodMessage, kind }
}

export function buildDeterministicRepairFeedback(reason: string) {
  const parsed = parseSchemaViolationReason(reason)
  const pathLine = parsed.path ? `Violation path: ${parsed.path}.` : ""
  const messageLine = parsed.zodMessage ? `Validator said: ${parsed.zodMessage}.` : ""

  const kindGuidance = (() => {
    switch (parsed.kind) {
      case "unknown_key":
        return "Action: remove the unknown key from the op's patch. Only use prop keys defined in that block type's blockContract. Do NOT invent new props (e.g. no 'color', 'colorful', 'style' unless they appear in the contract)."
      case "missing_required":
        return "Action: add the missing required field. If the op is update_props, required fields you omitted must either stay absent (no-op for that field) or be provided with a concrete value — do not set them to null or empty string unless the contract allows it."
      case "invalid_discriminator":
        return "Action: fix the op type. Use one of the allowed operation names exactly: create_page, add_block, update_props, remove_block, move_block, duplicate_block, add_item, update_item, remove_item, move_item, rename_page, remove_page, move_page, duplicate_page, update_page_meta, update_site_config."
      case "invalid_enum":
        return "Action: replace the invalid value with one of the allowed enum values. Check the blockContract for the set of permitted values."
      case "type_mismatch":
        return "Action: fix the type. Strings must be quoted strings, numbers bare numbers, booleans true/false. Do not wrap primitives in objects, do not pass arrays where strings are expected."
      case "out_of_range":
        return "Action: adjust the index/number to be within bounds. Indices are zero-based and must be < array length. For insertions, use afterIndex = array.length - 1 to append."
      case "string_constraint":
        return "Action: adjust the string length to satisfy the constraint. Most required text fields reject empty strings — provide actual content."
      default:
        return "Action: re-read the block's contract and re-emit the plan with strictly valid shapes."
    }
  })()

  return [
    "Repair strictly for schema compliance only. Do not change user intent, drop ops the user asked for, or rewrite copy semantics.",
    pathLine,
    messageLine,
    kindGuidance,
    "Keep every op the original plan had and every field/patch the user asked for — only fix the specific violation above.",
  ]
    .filter((line) => line.length > 0)
    .join(" ")
}

export type SkippedOperation = {
  index: number
  op: Operation["op"]
  reason: "empty_patch" | "unchanged_value"
  pageSlug?: string
  blockId?: string
}

export type FuzzyMatch = {
  requestedId: string
  resolvedId: string
  resolvedIndex: number
  strategy: "strip_copy_suffix" | "type_prefix"
}

export type ApplyOpsOptions = {
  componentsManifest?: BlockManifest
  contentSource?: ContentSource
}

export function isStructuralOperation(op: Operation) {
  return (
    op.op === "add_block" ||
    op.op === "remove_block" ||
    op.op === "move_block" ||
    op.op === "duplicate_block" ||
    op.op === "add_item" ||
    op.op === "remove_item" ||
    op.op === "move_item"
  )
}

// ---------------------------------------------------------------------------
// Helpers for atomic operation application (module-level for testability)
// ---------------------------------------------------------------------------

function _nextUniqueBlockId(blocks: Array<{ id: string }>, preferred: string) {
  const base = preferred.trim()
  if (base.length > 0 && !blocks.some((b) => b.id === base)) return base
  const root = base.length > 0 ? base : "b_block_copy"
  let i = 1
  while (blocks.some((b) => b.id === `${root}_${i}`)) i += 1
  return `${root}_${i}`
}

/**
 * Resolve a blockId to its index in the blocks array.
 * Exact match first, then fuzzy fallback:
 *  1. Strip trailing `_copy`, `_copy_N` suffix and retry exact match
 *  2. Match by block-type prefix — only when a single block matches (rejects ambiguous)
 *
 * Pushes a FuzzyMatch entry when a fallback strategy succeeds.
 */
function _resolveBlockIndex(blocks: Array<{ id: string; type?: string }>, blockId: string, fuzzyMatches?: FuzzyMatch[]): number {
  // Exact match
  const exact = blocks.findIndex((b) => b.id === blockId)
  if (exact !== -1) return exact

  // Fuzzy 1: strip _copy / _copy_N suffix and retry
  const stripped = blockId.replace(/_copy(?:_\d+)?$/, "")
  if (stripped !== blockId) {
    const idx = blocks.findIndex((b) => b.id === stripped)
    if (idx !== -1) {
      fuzzyMatches?.push({ requestedId: blockId, resolvedId: blocks[idx].id, resolvedIndex: idx, strategy: "strip_copy_suffix" })
      return idx
    }
  }

  // Fuzzy 2: match by block-type prefix — reject if ambiguous (>1 match)
  const typeMatch = blockId.match(/^b_([a-z]+)/i)
  if (typeMatch) {
    const typePrefix = `b_${typeMatch[1].toLowerCase()}_`
    const matches: number[] = []
    for (let i = 0; i < blocks.length; i += 1) {
      if (blocks[i].id.startsWith(typePrefix)) matches.push(i)
    }
    if (matches.length === 1) {
      const idx = matches[0]
      fuzzyMatches?.push({ requestedId: blockId, resolvedId: blocks[idx].id, resolvedIndex: idx, strategy: "type_prefix" })
      return idx
    }
    // Ambiguous: >1 block of same type — don't guess
  }

  return -1
}

function _nextDuplicateSlug(candidateMap: Map<string, PageDoc>, sourceSlug: string) {
  const base = sourceSlug === "/" ? "/home-copy" : `${sourceSlug.replace(/\/+$/, "")}-copy`
  if (!candidateMap.has(base)) return base
  let i = 2
  while (candidateMap.has(`${base}-${i}`)) i += 1
  return `${base}-${i}`
}

function _rebuildOrderWithInserted(candidateMap: Map<string, PageDoc>, insertedSlug: string, afterPageSlug?: string) {
  const ordered = orderSlugsHomeFirst(Array.from(candidateMap.keys()))
  const withoutInserted = ordered.filter((slug) => slug !== insertedSlug)
  let insertIndex = 0
  if (afterPageSlug) {
    if (afterPageSlug === "/") insertIndex = 1
    else {
      const anchorIdx = withoutInserted.findIndex((slug) => slug === afterPageSlug)
      if (anchorIdx === -1) throw new OperationError(`afterPageSlug ${afterPageSlug} not found`, { category: "not_found" })
      insertIndex = anchorIdx + 1
    }
  }
  withoutInserted.splice(insertIndex, 0, insertedSlug)
  return withoutInserted
}

function _listValueForOp(block: PageDoc["blocks"][number], listKey: string) {
  const candidate = (block.props as Record<string, unknown>)[listKey]
  if (!Array.isArray(candidate)) throw new OperationError(`List ${listKey} not found on ${block.id}`, { category: "not_found" })
  return candidate
}

function _describeValidationIssue(error: z.ZodError) {
  const first = error.issues[0]
  const path = first?.path?.length ? first.path.join(".") : ""
  const message = first?.message ?? "Invalid value"
  return path ? `${path}: ${message}` : message
}

function _validateWithManifestIfPresent(
  manifestByType: Map<string, BlockDefinition>,
  blockType: string,
  nextProps: Record<string, unknown>
) {
  const manifestComponent = manifestByType.get(blockType)

  if (manifestComponent) {
    // Passthrough Zod keeps extra keys so site-specific fields survive coercion.
    const ptSchema = _getPassthroughSchema(blockType)
    let coerced = nextProps
    if (ptSchema) {
      const result = ptSchema.safeParse(nextProps)
      if (result.success) coerced = result.data as Record<string, unknown>
    }
    if (!validateByJsonSchemaLike(manifestComponent.propsSchema, coerced)) {
      throw new OperationError(`Invalid props for ${blockType}: does not match block manifest schema`, { category: "schema_violation" })
    }
    return coerced
  }

  // No manifest entry — Zod-only validation (strips unknown keys as before)
  const propCheck = validateBlockProps(blockType as BlockType, nextProps)
  if (!propCheck.success) throw new OperationError(`Invalid props for ${blockType}: ${_describeValidationIssue(propCheck.error)}`, { category: "schema_violation" })
  return propCheck.data as Record<string, unknown>
}

function _requireManifestComponent(
  manifestByType: Map<string, BlockDefinition>,
  blockType: string,
  operationName: string
) {
  if (manifestByType.size === 0) return
  if (manifestByType.has(blockType)) return
  throw new OperationError(`Cannot ${operationName} for "${blockType}" because it is not declared in components manifest`, { category: "not_found" })
}

function _allowedPatchKeysFromManifest(
  manifestByType: Map<string, BlockDefinition>,
  blockType: string,
  fallbackKeys: string[]
) {
  const manifestComponent = manifestByType.get(blockType)
  if (!manifestComponent) return fallbackKeys
  const schema = manifestComponent.propsSchema
  const schemaType = typeof schema.type === "string" ? schema.type : "object"
  if (schemaType !== "object") return fallbackKeys
  const properties = schema.properties
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return fallbackKeys
  return Object.keys(properties)
}

function _withValidatedBlockProps(
  manifestByType: Map<string, BlockDefinition>,
  block: PageDoc["blocks"][number],
  nextProps: Record<string, unknown>
) {
  return _validateWithManifestIfPresent(manifestByType, block.type, nextProps)
}

// ---------------------------------------------------------------------------
// Typed contract validation — validates Operation[] against Zod schema at
// the NLP → ops-engine boundary so post-planner transformations cannot
// silently introduce malformed operations.
// ---------------------------------------------------------------------------

const opsArraySchema = z.array(operationSchema)

/**
 * Validate an array of operations against the canonical Zod schema.
 * Returns the parsed (typed) operations or throws an `OperationError`
 * with category `schema_violation`.
 */
export function validateOperations(ops: unknown[]): Operation[] {
  const result = opsArraySchema.safeParse(ops)
  if (!result.success) {
    const first = result.error.issues[0]
    const path = first?.path?.length ? ` at ops${first.path.map((p) => typeof p === "number" ? `[${p}]` : `.${String(p)}`).join("")}` : ""
    const detail = first?.message ?? "Invalid operation"
    throw new OperationError(`Operation contract violation${path}: ${detail}`, { category: "schema_violation" })
  }
  return result.data
}

// ---------------------------------------------------------------------------
// Atomic operation application
// ---------------------------------------------------------------------------

export async function applyOpsAtomically(session: string, ops: Operation[], options?: ApplyOpsOptions) {
  const release = await acquireSessionLock(session)
  try {
    return await _applyOpsAtomicallyUnsafe(session, ops, options)
  } finally {
    release()
  }
}

async function _applyOpsAtomicallyUnsafe(session: string, ops: Operation[], options?: ApplyOpsOptions) {
  const manifestByType = new Map<string, BlockDefinition>()
  if (options?.componentsManifest) {
    for (const component of options.componentsManifest.blocks) {
      manifestByType.set(component.type, component)
    }
  }

  const cs = options?.contentSource
  const staged = new Map<string, PageDoc>()
  if (cs) {
    const pages = await cs.getSessionPages(session)
    for (const page of pages) staged.set(page.slug, structuredClone(page))
  } else {
    const sessionDraft = getSessionDraft(session)
    for (const [slug, page] of sessionDraft) staged.set(slug, structuredClone(page))
  }
  const touchedSlugs = new Set<string>()
  const deletedSlugs = new Set<string>()
  const skippedOps: SkippedOperation[] = []
  const fuzzyMatches: FuzzyMatch[] = []
  const duplicatedPages: Array<{ slug: string; blockIdMap: Record<string, string> }> = []
  let orderChanged = false
  let configChanged = false
  const originalSiteConfig = cs ? await cs.getSiteConfig(session) : getSiteConfig(session)
  let stagedSiteConfig = originalSiteConfig

  // Pre-check: reject plans with duplicate add_block IDs
  const addBlockIds = new Set<string>()
  for (const op of ops) {
    if (op.op === "add_block") {
      if (addBlockIds.has(op.block.id)) {
        throw new OperationError(`Duplicate block id "${op.block.id}" in plan — each add_block must use a unique id`, { category: "schema_violation" })
      }
      addBlockIds.add(op.block.id)
    }
  }

  // Demo-mode gate: when DEMO_MODE=1, only permit the narrow allow-list
  // (defaults to `update_props` on `Hero` blocks). Throws OperationError if
  // any op would fall outside the allow-list. Runs AFTER staging is built
  // so we can resolve blockId → blockType from the current draft.
  if (isDemoModeEnabled()) {
    enforceDemoOps(ops, staged)
  }

  for (let opIndex = 0; opIndex < ops.length; opIndex += 1) {
    const op = ops[opIndex]
    if (op.op === "update_site_config") {
      const merged = { ...stagedSiteConfig }
      if (op.patch.name !== undefined) merged.name = op.patch.name
      if (op.patch.logo !== undefined) merged.logo = op.patch.logo
      if (op.patch.navLabels !== undefined) {
        merged.navLabels = { ...(stagedSiteConfig.navLabels ?? {}), ...op.patch.navLabels }
      }
      if (op.patch.navGroups !== undefined) {
        merged.navGroups = op.patch.navGroups // full replacement — groups are atomic
      }
      stagedSiteConfig = merged
      configChanged = true
      continue
    }

    if (op.op === "create_page") {
      // Normalize required PageDoc fields the caller may have omitted. Agent
      // and chat callers only pass slug/title/blocks — the `id` and
      // `updatedAt` fields are required by `pageDocSchemaLenient`, and if
      // they're missing the site's draft fetcher rejects the page as
      // malformed and renders "Draft unavailable". Backfilling here covers
      // every create path (agent tool, chat planner, demo seeding, SDK).
      const incoming = structuredClone(op.page) as PageDoc
      const normalized: PageDoc = {
        ...incoming,
        id: incoming.id && incoming.id.length > 0 ? incoming.id : pageIdFromSlug(incoming.slug),
        slug: incoming.slug,
        title: incoming.title && incoming.title.trim().length > 0 ? incoming.title : pageTitleFromSlug(incoming.slug),
        updatedAt: incoming.updatedAt && incoming.updatedAt.length > 0 ? incoming.updatedAt : new Date().toISOString(),
      }
      staged.set(normalized.slug, normalized)
      touchedSlugs.add(normalized.slug)
      continue
    }

    if (op.op === "duplicate_page") {
      const source = staged.get(op.pageSlug)
      if (!source) throw new OperationError(`Page not found for slug ${op.pageSlug}`, { category: "not_found" })
      const nextSlug = normalizeRouteCandidate(op.newPageSlug) ?? _nextDuplicateSlug(staged, op.pageSlug)
      if (staged.has(nextSlug)) throw new OperationError(`Target page slug already exists: ${nextSlug}`, { category: "schema_violation" })
      op.newPageSlug = nextSlug
      const explicitNewTitle = typeof op.newTitle === "string" && op.newTitle.trim().length > 0 ? op.newTitle.trim() : undefined
      const blockIdMap: Record<string, string> = {}
      const nextBlocks = source.blocks.map((block) => {
        const newId = _nextUniqueBlockId(source.blocks, `${block.id}_copy`)
        blockIdMap[block.id] = newId
        return { ...block, id: newId }
      })
      // source was already deep-cloned at entry into `staged`; spread is sufficient
      // since all later mutations replace blocks/props wholesale rather than mutating in-place.
      const copy: PageDoc = {
        ...source,
        id: pageIdFromSlug(nextSlug),
        slug: nextSlug,
        title: explicitNewTitle ?? `${source.title} Copy`,
        updatedAt: new Date().toISOString(),
        blocks: nextBlocks,
        // When caller passes newTitle, keep meta.title in sync so SEO doesn't show
        // the source page's English title on a translated copy. Other meta fields
        // (description, ogImage) stay — caller can patch them with update_page_meta.
        meta: explicitNewTitle && source.meta
          ? { ...source.meta, title: explicitNewTitle }
          : explicitNewTitle
            ? { title: explicitNewTitle }
            : source.meta
      }
      staged.set(nextSlug, copy)
      touchedSlugs.add(nextSlug)
      duplicatedPages.push({ slug: nextSlug, blockIdMap })

      const finalOrder = _rebuildOrderWithInserted(staged, nextSlug, op.afterPageSlug ?? op.pageSlug)
      const reordered = new Map<string, PageDoc>()
      for (const route of finalOrder) {
        const page = staged.get(route)
        if (page) reordered.set(route, page)
      }
      staged.clear()
      for (const [route, page] of reordered) staged.set(route, page)
      orderChanged = true
      continue
    }

    if (op.op === "rename_page") {
      const page = staged.get(op.pageSlug)
      if (!page) throw new OperationError(`Page not found for slug ${op.pageSlug}`, { category: "not_found" })

      const incomingSlug = op.newPageSlug !== undefined ? normalizeRouteCandidate(op.newPageSlug) : undefined
      if (op.newPageSlug !== undefined && !incomingSlug) {
        throw new OperationError(`Invalid newPageSlug ${op.newPageSlug}`, { category: "schema_violation" })
      }

      const trimmedTitle = typeof op.newTitle === "string" ? op.newTitle.trim() : undefined
      const slugChanged = incomingSlug !== undefined && incomingSlug !== op.pageSlug
      const titleChanged = trimmedTitle !== undefined && trimmedTitle.length > 0 && trimmedTitle !== page.title

      if (!slugChanged && !titleChanged) {
        const slugSegment = incomingSlug !== undefined
          ? `newPageSlug=${JSON.stringify(incomingSlug)} matches current`
          : "newPageSlug not provided"
        const titleSegment = trimmedTitle !== undefined
          ? `newTitle=${JSON.stringify(trimmedTitle)} matches current title ${JSON.stringify(page.title)}`
          : `newTitle not provided (current title ${JSON.stringify(page.title)})`
        throw new OperationError(
          `No effective page change for ${op.pageSlug}: ${slugSegment}; ${titleSegment}. Provide newPageSlug different from ${JSON.stringify(op.pageSlug)} and/or newTitle different from ${JSON.stringify(page.title)}.`,
          { category: "no_effective_change" }
        )
      }

      if (slugChanged) {
        const nextSlug = incomingSlug!
        if (staged.has(nextSlug)) throw new OperationError(`Target page slug already exists: ${nextSlug}`, { category: "schema_violation" })
        deletedSlugs.add(op.pageSlug)
        const renamedPage = {
          ...page,
          id: pageIdFromSlug(nextSlug),
          slug: nextSlug,
          title: titleChanged ? trimmedTitle! : pageTitleFromSlug(nextSlug),
          updatedAt: new Date().toISOString()
        }
        touchedSlugs.add(nextSlug)

        // Rebuild the map to preserve the renamed page's position in nav order.
        const entries = Array.from(staged.entries())
        staged.clear()
        for (const [slug, p] of entries) {
          if (slug === op.pageSlug) {
            staged.set(nextSlug, renamedPage)
          } else {
            staged.set(slug, p)
          }
        }

        // Keep route references consistent after a slug change.
        for (const [slug, candidate] of staged) {
          const rewritten = rewriteLinksToRenamedPage(candidate, op.pageSlug, nextSlug)
          if (!rewritten.changed) continue
          staged.set(slug, rewritten.page)
          touchedSlugs.add(slug)
        }
      } else {
        // Title-only rename: same slug, new display title. No link rewriting needed.
        const renamedPage = {
          ...page,
          title: trimmedTitle!,
          updatedAt: new Date().toISOString()
        }
        staged.set(op.pageSlug, renamedPage)
        touchedSlugs.add(op.pageSlug)
      }
      continue
    }

    if (op.op === "remove_page") {
      if (op.pageSlug === "/") throw new OperationError("Cannot remove the home page (/)", { category: "schema_violation" })
      const page = staged.get(op.pageSlug)
      if (!page) throw new OperationError(`Page not found for slug ${op.pageSlug}`, { category: "not_found" })
      if (staged.size <= 1) throw new OperationError("Cannot remove the last remaining page", { category: "schema_violation" })
      staged.delete(op.pageSlug)
      deletedSlugs.add(op.pageSlug)
      continue
    }

    if (op.op === "move_page") {
      if (op.pageSlug === "/") throw new OperationError("Home page (/) cannot be moved", { category: "schema_violation" })
      if (!staged.has(op.pageSlug)) throw new OperationError(`Page not found for slug ${op.pageSlug}`, { category: "not_found" })

      const ordered = orderSlugsHomeFirst(Array.from(staged.keys()))
      const movable = ordered.filter((route) => route !== "/")
      const currentIdx = movable.findIndex((route) => route === op.pageSlug)
      if (currentIdx === -1) throw new OperationError(`Page not found for slug ${op.pageSlug}`, { category: "not_found" })
      const nextMovable = movable.filter((route) => route !== op.pageSlug)

      let insertIndex = 0
      if (op.afterPageSlug) {
        if (op.afterPageSlug === "/") insertIndex = 0
        else {
          const anchorIdx = nextMovable.findIndex((route) => route === op.afterPageSlug)
          if (anchorIdx === -1) throw new OperationError(`afterPageSlug ${op.afterPageSlug} not found`, { category: "not_found" })
          insertIndex = anchorIdx + 1
        }
      }

      nextMovable.splice(insertIndex, 0, op.pageSlug)
      const finalOrder = ordered.includes("/") ? ["/", ...nextMovable] : nextMovable

      const reordered = new Map<string, PageDoc>()
      for (const route of finalOrder) {
        const page = staged.get(route)
        if (!page) continue
        reordered.set(route, page)
      }
      staged.clear()
      for (const [route, page] of reordered) staged.set(route, page)
      orderChanged = true
      continue
    }

    if (op.op === "update_page_meta") {
      const page = staged.get(op.pageSlug)
      if (!page) throw new OperationError(`Page not found for slug ${op.pageSlug}`, { category: "not_found" })
      const patch = op.patch as Record<string, unknown>
      const patchKeys = Object.keys(patch).filter((k) => patch[k] !== undefined)
      if (patchKeys.length === 0) {
        throw new OperationError(
          `No effective meta change for ${op.pageSlug}: patch contained no defined keys. Provide at least one of title, description, ogImage with a non-undefined value.`,
          { category: "no_effective_change" }
        )
      }
      const current = page.meta ?? {}
      const next: Record<string, unknown> = { ...current }
      let changed = false
      for (const key of patchKeys) {
        const value = patch[key]
        if (typeof value === "string" && value.length === 0) {
          if ((current as Record<string, unknown>)[key] !== undefined) {
            delete next[key]
            changed = true
          }
        } else {
          if ((current as Record<string, unknown>)[key] !== value) {
            next[key] = value
            changed = true
          }
        }
      }
      if (!changed) {
        const incomingSummary = patchKeys
          .map((k) => `${k}=${JSON.stringify(patch[k])}`)
          .join(", ")
        const currentSummary = patchKeys
          .map((k) => `${k}=${JSON.stringify((current as Record<string, unknown>)[k])}`)
          .join(", ")
        throw new OperationError(
          `No effective meta change for ${op.pageSlug}: provided ${incomingSummary} already matches current ${currentSummary}.`,
          { category: "no_effective_change" }
        )
      }
      page.meta = Object.keys(next).length > 0 ? (next as PageDoc["meta"]) : undefined
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    const page = staged.get(op.pageSlug)
    if (!page) throw new OperationError(`Page not found for slug ${op.pageSlug}`, { category: "not_found" })

    if (op.op === "add_block") {
      if (isChrome(op.block.type)) throw new OperationError(`Cannot add chrome block type "${op.block.type}"`, { category: "schema_violation" })
      _requireManifestComponent(manifestByType, op.block.type, "add block")
      const validatedProps = _validateWithManifestIfPresent(manifestByType, op.block.type, op.block.props)

      const alreadyExists = page.blocks.some((b) => b.id === op.block.id)
      if (alreadyExists) throw new OperationError(`Block id ${op.block.id} already exists`, { category: "schema_violation" })

      if (!op.afterBlockId) {
        page.blocks.push({ ...op.block, props: validatedProps })
      } else {
        let idx = page.blocks.findIndex((b) => b.id === op.afterBlockId)
        // Fuzzy fallback: LLM batch plans sometimes use inconsistent IDs for
        // blocks added in earlier ops (e.g. "b_testimonials_about" vs
        // "b_testimonials_1772…"). Match by block type when exact ID fails.
        if (idx === -1) {
          const typeMatch = op.afterBlockId.match(/^b_([a-z]+)/i)
          if (typeMatch) {
            const typePrefix = `b_${typeMatch[1].toLowerCase()}_`
            for (let i = page.blocks.length - 1; i >= 0; i -= 1) {
              if (page.blocks[i].id.startsWith(typePrefix)) {
                idx = i
                break
              }
            }
          }
        }
        if (idx === -1) throw new OperationError(`afterBlockId ${op.afterBlockId} not found`, { category: "not_found" })
        page.blocks.splice(idx + 1, 0, { ...op.block, props: validatedProps })
      }
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "duplicate_block") {
      const idx = _resolveBlockIndex(page.blocks, op.blockId, fuzzyMatches)
      if (idx === -1) throw new OperationError(`blockId ${op.blockId} not found`, { category: "not_found" })
      const source = page.blocks[idx]
      if (isChrome(source.type)) throw new OperationError(`Cannot duplicate chrome block "${op.blockId}"`, { category: "schema_violation" })
      _requireManifestComponent(manifestByType, source.type, "duplicate block")
      const targetPageSlug = typeof op.toPageSlug === "string" && op.toPageSlug.length > 0 ? op.toPageSlug : op.pageSlug
      const targetPage = staged.get(targetPageSlug)
      if (!targetPage) throw new OperationError(`Target page not found for slug ${targetPageSlug}`, { category: "not_found" })
      const nextId = _nextUniqueBlockId(targetPage.blocks, typeof op.newBlockId === "string" ? op.newBlockId : `${source.id}_copy`)
      op.newBlockId = nextId
      // source is from `staged` (already deep-cloned at entry); spread suffices
      const duplicate = { ...source, id: nextId }

      if (!op.afterBlockId) {
        if (targetPageSlug === op.pageSlug) page.blocks.splice(idx + 1, 0, duplicate)
        else targetPage.blocks.push(duplicate)
      } else {
        const anchorIdx = targetPage.blocks.findIndex((b) => b.id === op.afterBlockId)
        if (anchorIdx === -1) throw new OperationError(`afterBlockId ${op.afterBlockId} not found`, { category: "not_found" })
        targetPage.blocks.splice(anchorIdx + 1, 0, duplicate)
      }
      targetPage.updatedAt = new Date().toISOString()
      touchedSlugs.add(targetPage.slug)
      continue
    }

    if (op.op === "add_item") {
      const blockIdx = _resolveBlockIndex(page.blocks, op.blockId, fuzzyMatches)
      if (blockIdx === -1) throw new OperationError(`blockId ${op.blockId} not found`, { category: "not_found" })
      const block = page.blocks[blockIdx]
      _requireManifestComponent(manifestByType, block.type, "add list items")
      const list = _listValueForOp(block, op.listKey)
      const nextList = [...list]
      const insertIndex = typeof op.afterIndex === "number" ? op.afterIndex + 1 : nextList.length
      if (insertIndex < 0 || insertIndex > nextList.length) {
        throw new OperationError(`afterIndex ${op.afterIndex} is out of range for ${op.listKey}`, { category: "schema_violation" })
      }
      nextList.splice(insertIndex, 0, structuredClone(op.item))
      const nextProps = { ...(block.props as Record<string, unknown>), [op.listKey]: nextList }
      page.blocks[blockIdx] = { ...block, props: _withValidatedBlockProps(manifestByType, block, nextProps) }
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "update_item") {
      const blockIdx = _resolveBlockIndex(page.blocks, op.blockId, fuzzyMatches)
      if (blockIdx === -1) throw new OperationError(`blockId ${op.blockId} not found`, { category: "not_found" })
      const block = page.blocks[blockIdx]
      _requireManifestComponent(manifestByType, block.type, "update list items")
      const list = _listValueForOp(block, op.listKey)
      if (op.index < 0 || op.index >= list.length) throw new OperationError(`index ${op.index} is out of range for ${op.listKey}`, { category: "schema_violation" })
      const currentItem = list[op.index]
      if (!currentItem || typeof currentItem !== "object" || Array.isArray(currentItem)) {
        throw new OperationError(`List item ${op.listKey}[${op.index}] is not an object`, { category: "schema_violation" })
      }
      const nextList = list.map((entry, idx) => {
        if (idx !== op.index) return entry
        return { ...(entry as Record<string, unknown>), ...(op.patch as Record<string, unknown>) }
      })
      const nextProps = { ...(block.props as Record<string, unknown>), [op.listKey]: nextList }
      page.blocks[blockIdx] = { ...block, props: _withValidatedBlockProps(manifestByType, block, nextProps) }
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "remove_item") {
      const blockIdx = _resolveBlockIndex(page.blocks, op.blockId, fuzzyMatches)
      if (blockIdx === -1) throw new OperationError(`blockId ${op.blockId} not found`, { category: "not_found" })
      const block = page.blocks[blockIdx]
      _requireManifestComponent(manifestByType, block.type, "remove list items")
      const list = _listValueForOp(block, op.listKey)
      if (op.index < 0 || op.index >= list.length) throw new OperationError(`index ${op.index} is out of range for ${op.listKey}`, { category: "schema_violation" })
      const nextList = [...list]
      nextList.splice(op.index, 1)
      const nextProps = { ...(block.props as Record<string, unknown>), [op.listKey]: nextList }
      page.blocks[blockIdx] = { ...block, props: _withValidatedBlockProps(manifestByType, block, nextProps) }
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "move_item") {
      const blockIdx = _resolveBlockIndex(page.blocks, op.blockId, fuzzyMatches)
      if (blockIdx === -1) throw new OperationError(`blockId ${op.blockId} not found`, { category: "not_found" })
      const block = page.blocks[blockIdx]
      _requireManifestComponent(manifestByType, block.type, "reorder list items")
      const list = _listValueForOp(block, op.listKey)
      if (op.index < 0 || op.index >= list.length) throw new OperationError(`index ${op.index} is out of range for ${op.listKey}`, { category: "schema_violation" })
      const nextList = [...list]
      const [item] = nextList.splice(op.index, 1)
      if (item === undefined) throw new OperationError(`index ${op.index} is out of range for ${op.listKey}`, { category: "schema_violation" })
      const normalizedAfterIndex =
        typeof op.afterIndex === "number" && op.afterIndex > op.index ? op.afterIndex - 1 : op.afterIndex
      const insertIndex = typeof normalizedAfterIndex === "number" ? normalizedAfterIndex + 1 : 0
      if (insertIndex < 0 || insertIndex > nextList.length) {
        throw new OperationError(`afterIndex ${op.afterIndex} is out of range for ${op.listKey}`, { category: "schema_violation" })
      }
      nextList.splice(insertIndex, 0, item)
      const nextProps = { ...(block.props as Record<string, unknown>), [op.listKey]: nextList }
      page.blocks[blockIdx] = { ...block, props: _withValidatedBlockProps(manifestByType, block, nextProps) }
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "update_props") {
      const idx = _resolveBlockIndex(page.blocks, op.blockId, fuzzyMatches)
      if (idx === -1) throw new OperationError(`blockId ${op.blockId} not found`, { category: "not_found" })
      const block = page.blocks[idx]
      _requireManifestComponent(manifestByType, block.type, "update props")
      const rawPatch = op.patch as Record<string, unknown>
      const patchCandidate =
        rawPatch && typeof rawPatch.props === "object" && rawPatch.props !== null && !Array.isArray(rawPatch.props)
          ? (rawPatch.props as Record<string, unknown>)
          : rawPatch

      const patchKeys = Object.keys(patchCandidate ?? {})
      const schemaForType = blockSchemas[block.type as BlockType]
      const schemaShape =
        schemaForType && typeof schemaForType === "object" && "shape" in schemaForType
          ? (schemaForType.shape as Record<string, unknown>)
          : null
      const fallbackAllowedKeys = schemaShape ? Object.keys(schemaShape) : Object.keys(block.props as Record<string, unknown>)
      const allowedPatchKeys = _allowedPatchKeysFromManifest(manifestByType, block.type, fallbackAllowedKeys)
      const invalidPatchKeys = patchKeys.filter((key) => !allowedPatchKeys.includes(key))
      if (invalidPatchKeys.length > 0) {
        throw new OperationError(
          `Patch for ${block.id} (${block.type}) used unknown props: ${invalidPatchKeys.join(", ")}. Allowed props: ${allowedPatchKeys.join(", ")}`,
          { category: "schema_violation" }
        )
      }

      const prevProps = block.props as Record<string, unknown>
      const nextProps = { ...prevProps } as Record<string, unknown>
      for (const key of patchKeys) {
        const oldVal = prevProps[key]
        const newVal = (patchCandidate as Record<string, unknown>)[key]
        // Deep-merge arrays of objects by index so partial items inherit existing fields
        if (Array.isArray(oldVal) && Array.isArray(newVal)) {
          nextProps[key] = newVal.map((item, i) => {
            const prev = oldVal[i]
            if (prev && typeof prev === "object" && !Array.isArray(prev) && item && typeof item === "object" && !Array.isArray(item)) {
              return { ...prev, ...item }
            }
            return item
          })
        } else {
          nextProps[key] = newVal
        }
      }

      const validatedProps = _validateWithManifestIfPresent(manifestByType, block.type, nextProps)
      if (patchKeys.length === 0) {
        skippedOps.push({
          index: opIndex + 1,
          op: op.op,
          reason: "empty_patch",
          pageSlug: op.pageSlug,
          blockId: op.blockId
        })
        continue
      }

      const hasEffectivePatchKey = patchKeys.some(
        (key) => JSON.stringify((block.props as Record<string, unknown>)[key]) !== JSON.stringify((validatedProps as Record<string, unknown>)[key])
      )
      if (!hasEffectivePatchKey) {
        // Treat unchanged patch values as no-op so one stale field does not fail the whole plan.
        skippedOps.push({
          index: opIndex + 1,
          op: op.op,
          reason: "unchanged_value",
          pageSlug: op.pageSlug,
          blockId: op.blockId
        })
        continue
      }
      page.blocks[idx] = { ...block, props: validatedProps }
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "remove_block") {
      const idx = _resolveBlockIndex(page.blocks, op.blockId, fuzzyMatches)
      if (idx === -1) throw new OperationError(`blockId ${op.blockId} not found`, { category: "not_found" })
      if (isChrome(page.blocks[idx].type)) throw new OperationError(`Cannot remove chrome block "${op.blockId}"`, { category: "schema_violation" })
      _requireManifestComponent(manifestByType, page.blocks[idx].type, "remove block")
      page.blocks.splice(idx, 1)
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "move_block") {
      const idx = _resolveBlockIndex(page.blocks, op.blockId, fuzzyMatches)
      if (idx === -1) throw new OperationError(`blockId ${op.blockId} not found`, { category: "not_found" })
      if (isChrome(page.blocks[idx].type)) throw new OperationError(`Cannot move chrome block "${op.blockId}"`, { category: "schema_violation" })
      _requireManifestComponent(manifestByType, page.blocks[idx].type, "move block")
      const [block] = page.blocks.splice(idx, 1)

      if (!op.afterBlockId) {
        page.blocks.unshift(block)
      } else {
        const afterIdx = page.blocks.findIndex((b) => b.id === op.afterBlockId)
        if (afterIdx === -1) throw new OperationError(`afterBlockId ${op.afterBlockId} not found`, { category: "not_found" })
        page.blocks.splice(afterIdx + 1, 0, block)
      }

      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
    }
  }

  if (touchedSlugs.size === 0 && deletedSlugs.size === 0 && !orderChanged && !configChanged) {
    if (skippedOps.length > 0 && skippedOps.length === ops.length) {
      throw new OperationError("No effective prop change across plan. All update patches matched existing values.", { category: "no_effective_change" })
    }
    throw new OperationError("Edit plan produced no changes", { category: "no_effective_change" })
  }

  if (cs) {
    // Async write-back through ContentSource
    const currentSlugs = await cs.getSlugs(session)
    for (const slug of currentSlugs) {
      if (!staged.has(slug)) await cs.removePage(session, slug)
    }
    for (const [, page] of staged) await cs.setPage(session, page)
    if (configChanged) await cs.setSiteConfig(session, stagedSiteConfig)
  } else {
    const sessionDraft = getSessionDraft(session)
    sessionDraft.clear()
    for (const [, page] of staged) setPage(session, page)
    if (configChanged) setSiteConfig(session, stagedSiteConfig)
  }
  return {
    appliedCount: Math.max(0, ops.length - skippedOps.length),
    skippedOps,
    fuzzyMatches,
    duplicatedPages
  }
}

// ---------------------------------------------------------------------------
// Post-apply helpers
// ---------------------------------------------------------------------------

export function pickFocusBlockId(ops: Operation[]) {
  const add = ops.find((op) => op.op === "add_block")
  if (add && add.op === "add_block") return add.block.id

  const duplicate = ops.find((op) => op.op === "duplicate_block")
  if (duplicate && duplicate.op === "duplicate_block" && typeof duplicate.newBlockId === "string") return duplicate.newBlockId

  const listOp = ops.find(
    (op) => op.op === "add_item" || op.op === "update_item" || op.op === "remove_item" || op.op === "move_item"
  )
  if (listOp && "blockId" in listOp && typeof listOp.blockId === "string") return listOp.blockId

  const move = ops.find((op) => op.op === "move_block")
  if (move && move.op === "move_block") return move.blockId

  const update = ops.find((op) => op.op === "update_props")
  if (update && update.op === "update_props") return update.blockId

  return undefined
}

export function pickUpdatedSlug(session: string, currentSlug: string, ops: Operation[]) {
  const createdPages = ops.filter((op) => op.op === "create_page")
  if (createdPages.length === 1 && createdPages[0].op === "create_page") return createdPages[0].page.slug
  // multiple create_page ops → fall through, no auto-nav; mentionedSlugs handles navigation
  const duplicate = ops.find((op) => op.op === "duplicate_page" && op.pageSlug === currentSlug)
  if (duplicate && duplicate.op === "duplicate_page") return duplicate.newPageSlug
  const rename = ops.find((op) => op.op === "rename_page" && op.pageSlug === currentSlug)
  if (rename && rename.op === "rename_page") return rename.newPageSlug ?? rename.pageSlug
  const current = getPage(session, currentSlug)
  if (current) return undefined
  const draft = getSessionDraft(session)
  const first = orderSlugsHomeFirst(Array.from(draft.keys()))[0]
  return first
}
