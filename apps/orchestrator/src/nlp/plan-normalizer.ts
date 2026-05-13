import {
  allowedBlockTypes,
  defaultPropsForType as sharedDefaultPropsForType,
  type BlockType,
  type Operation,
  type PageDoc
} from "@avocadostudio-ai/shared"
import {
  extractRouteMentions,
  firstRouteMention,
  normalizeRouteCandidate,
  parseCreatePageRequest
} from "./intent-helpers.js"

// ---------------------------------------------------------------------------
// Op reordering: create_page must precede ops targeting the same slug
// ---------------------------------------------------------------------------

function reorderCreatePageFirst(ops: unknown[]): unknown[] {
  const createOps: Array<{ index: number; slug: string }> = []
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] as Record<string, unknown> | null
    if (!op || typeof op !== "object") continue
    if (op.op !== "create_page") continue
    const page = op.page as Record<string, unknown> | undefined
    const slug = typeof page?.slug === "string" ? page.slug : undefined
    if (slug) createOps.push({ index: i, slug })
  }
  if (createOps.length === 0) return ops

  const createSlugs = new Set(createOps.map((c) => c.slug))
  const result: unknown[] = []
  const deferred: unknown[] = []

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] as Record<string, unknown> | null
    if (!op || typeof op !== "object") { result.push(ops[i]); continue }

    if (op.op === "create_page") {
      result.push(op)
      // Flush any deferred ops that target this page
      const page = op.page as Record<string, unknown> | undefined
      const slug = typeof page?.slug === "string" ? page.slug : undefined
      if (slug) {
        const flushed: number[] = []
        for (let j = 0; j < deferred.length; j++) {
          const d = deferred[j] as Record<string, unknown>
          if (d.pageSlug === slug) { result.push(d); flushed.push(j) }
        }
        for (let j = flushed.length - 1; j >= 0; j--) deferred.splice(flushed[j], 1)
      }
    } else if (typeof op.pageSlug === "string" && createSlugs.has(op.pageSlug) && !result.some((r) => {
      const ro = r as Record<string, unknown> | null
      return ro && ro.op === "create_page" && (ro.page as Record<string, unknown>)?.slug === op.pageSlug
    })) {
      // This op targets a page that will be created later — defer it
      deferred.push(op)
    } else {
      result.push(op)
    }
  }
  // Append any remaining deferred ops (shouldn't happen if create_page exists)
  result.push(...deferred)
  return result
}

// ---------------------------------------------------------------------------
// JSON extraction & repair
// ---------------------------------------------------------------------------

export function extractJsonObject(input: string) {
  const start = input.indexOf("{")
  const end = input.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) return null
  return input.slice(start, end + 1)
}

/**
 * Attempt to repair common JSON malformations from LLM output:
 * - Bare `-` used as markdown bullets inside arrays: `[- "item"]` → `["item"]`
 * - Trailing commas before `]` or `}`
 * Returns repaired string or original if no repair was needed.
 */
export function repairJson(raw: string): string {
  let result = raw
  // Escape unescaped control characters (newlines, tabs, etc.) inside JSON
  // string values. LLMs with eager_input_streaming often emit literal control
  // chars in markdown-formatted text.
  result = escapeControlCharsInStrings(result)
  // Fix markdown bullets inside JSON arrays: [- "...", - "..."] → ["...", "..."]
  // Match `- ` after `[` or `,` (with optional whitespace) when not inside a string
  result = result.replace(/(\[|,)\s*-\s+(?=")/g, "$1 ")
  // Fix trailing commas: [item,] or {key: value,}
  result = result.replace(/,\s*([}\]])/g, "$1")
  return result
}

/**
 * Escape unescaped control characters (newlines, tabs, etc.) that appear
 * inside JSON string values. Walks character-by-character tracking string
 * context so control chars outside strings are left untouched.
 */
function escapeControlCharsInStrings(raw: string): string {
  const out: string[] = []
  let inString = false
  let escaped = false
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    if (escaped) {
      escaped = false
      out.push(raw[i])
      continue
    }
    if (raw[i] === "\\") {
      escaped = true
      out.push(raw[i])
      continue
    }
    if (raw[i] === '"') {
      inString = !inString
      out.push(raw[i])
      continue
    }
    if (inString && code <= 0x1f) {
      // Replace unescaped control characters inside strings
      if (code === 0x0a) { out.push("\\n"); continue }
      if (code === 0x0d) { out.push("\\r"); continue }
      if (code === 0x09) { out.push("\\t"); continue }
      out.push("\\u" + code.toString(16).padStart(4, "0"))
      continue
    }
    out.push(raw[i])
  }
  return out.join("")
}

/**
 * Close unclosed braces, brackets, and strings in a truncated JSON string.
 * Walks the string tracking nesting context and appends the necessary
 * closing characters.
 */
function closeOpenBrackets(input: string): string {
  const stack: string[] = []
  let inStr = false
  let esc = false
  for (const ch of input) {
    if (esc) { esc = false; continue }
    if (ch === "\\") { esc = true; continue }
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === "{") stack.push("}")
    else if (ch === "[") stack.push("]")
    else if (ch === "}" || ch === "]") stack.pop()
  }
  let result = input
  if (inStr) result += '"'
  while (stack.length > 0) result += stack.pop()
  return result
}

export type JsonRepairStrategy = "basic_repair" | "bare_minus_fix" | "close_brackets" | "truncate_at_boundary" | "none"

export type JsonRepairResult = {
  parsed: unknown
  strategy: JsonRepairStrategy
  /** Number of character-level mutations applied (for bare_minus_fix). */
  mutationCount?: number
  /** Bytes discarded by truncation strategies. */
  discardedBytes?: number
}

/**
 * Attempt multiple JSON repair strategies. Returns the first one that
 * produces parseable JSON along with metadata about what was done,
 * or throws the original error.
 */
export function repairAndParseJsonWithMeta(raw: string): JsonRepairResult {
  // Strategy 1: basic repair (includes control char escaping + markdown bullet fix)
  const basic = repairJson(raw)
  try { return { parsed: JSON.parse(basic), strategy: "basic_repair" } } catch {}

  // Strategy 2: fix "no number after minus sign" by replacing bare `-`
  // outside of string literals with `0`. Walk character by character to
  // track whether we're inside a JSON string.
  try {
    const chars = [...basic]
    let inString = false
    let escaped = false
    let mutations = 0
    for (let i = 0; i < chars.length; i++) {
      if (escaped) { escaped = false; continue }
      if (chars[i] === "\\") { escaped = true; continue }
      if (chars[i] === '"') { inString = !inString; continue }
      if (!inString && chars[i] === "-") {
        const next = chars[i + 1]
        if (next === undefined || !/\d/.test(next)) {
          // Bare minus not followed by digit — replace with 0
          chars[i] = "0"
          mutations += 1
        }
      }
    }
    return { parsed: JSON.parse(chars.join("")), strategy: "bare_minus_fix", mutationCount: mutations }
  } catch {}

  // Strategy 3: truncated output — close open braces/brackets in correct order
  try {
    return { parsed: JSON.parse(closeOpenBrackets(basic)), strategy: "close_brackets" }
  } catch {}

  // Strategy 4: truncate at last valid key-value boundary
  // The model produced valid JSON for some fields but then broke into raw
  // markdown (e.g., bare bullet lists instead of JSON arrays). Collect all
  // comma positions outside strings, then try truncating at each from right
  // to left until we get valid JSON.
  try {
    const commaPositions: number[] = []
    let inStr4 = false
    let esc4 = false
    for (let i = 0; i < basic.length; i++) {
      if (esc4) { esc4 = false; continue }
      if (basic[i] === "\\") { esc4 = true; continue }
      if (basic[i] === '"') { inStr4 = !inStr4; continue }
      if (!inStr4 && basic[i] === ",") commaPositions.push(i)
    }
    // Try last 10 positions max — truncating further is unlikely to yield useful content
    const startIdx = Math.max(0, commaPositions.length - 10)
    for (let ci = commaPositions.length - 1; ci >= startIdx; ci--) {
      const truncated = basic.slice(0, commaPositions[ci]!)
      try {
        return { parsed: JSON.parse(closeOpenBrackets(truncated)), strategy: "truncate_at_boundary", discardedBytes: raw.length - commaPositions[ci]! }
      } catch {}
    }
  } catch {}

  // All strategies failed — throw original parse error
  return { parsed: JSON.parse(raw), strategy: "none" }
}

/**
 * Attempt multiple JSON repair strategies. Returns the first one that
 * produces parseable JSON, or throws the original error.
 */
export function repairAndParseJson(raw: string): unknown {
  return repairAndParseJsonWithMeta(raw).parsed
}

// ---------------------------------------------------------------------------
// Operation name normalisation
// ---------------------------------------------------------------------------

export function normalizeOpName(op: unknown) {
  if (typeof op !== "string") return op
  const key = op.toLowerCase().replace(/[\s-]/g, "_")
  const aliases: Record<string, Operation["op"]> = {
    create: "create_page",
    create_page: "create_page",
    createpage: "create_page",
    add: "add_block",
    add_block: "add_block",
    addblock: "add_block",
    insert_block: "add_block",
    insertblock: "add_block",
    update: "update_props",
    update_props: "update_props",
    updateprops: "update_props",
    update_block: "update_props",
    updateblock: "update_props",
    edit_block: "update_props",
    editblock: "update_props",
    remove: "remove_block",
    remove_block: "remove_block",
    removeblock: "remove_block",
    delete: "remove_block",
    delete_block: "remove_block",
    deleteblock: "remove_block",
    move: "move_block",
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
    rename: "rename_page",
    rename_page: "rename_page",
    renamepage: "rename_page",
    remove_page: "remove_page",
    removepage: "remove_page",
    delete_page: "remove_page",
    deletepage: "remove_page",
    update_site_config: "update_site_config",
    updatesiteconfig: "update_site_config",
    update_page_meta: "update_page_meta",
    updatepagemeta: "update_page_meta"
  }
  return aliases[key] ?? op
}

// ---------------------------------------------------------------------------
// Slug / page-id helpers
// ---------------------------------------------------------------------------

export function pageIdFromSlug(slug: string) {
  if (slug === "/") return "p_home"
  const core = slug
    .slice(1)
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
  return `p_${core || "page"}`
}

export function pageTitleFromSlug(slug: string) {
  if (slug === "/") return "Home"
  const text = slug
    .slice(1)
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[-_]/g, " "))
    .join(" ")
    .trim()
  if (!text) return "Untitled Page"
  return text
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

// ---------------------------------------------------------------------------
// Block type inference
// ---------------------------------------------------------------------------

export function inferBlockTypeFromText(text: string): BlockType | undefined {
  const normalized = text.toLowerCase()
  if (normalized.includes("hero")) return "Hero"
  if (normalized.includes("featuregrid") || normalized.includes("feature grid") || normalized.includes("features") || /\bfeture/.test(normalized)) return "FeatureGrid"
  if (normalized.includes("testimonial") || normalized.includes("testomonial") || normalized.includes("social proof") || normalized.includes("review") || (/\bquote\b/.test(normalized) && !normalized.includes("blockquote"))) return "Testimonials"
  if (normalized.includes("faq")) return "FAQAccordion"
  if (normalized.includes("twocolumn") || normalized.includes("two column") || normalized.includes("2 column")) return "TwoColumn"
  if (normalized.includes("stats") || normalized.includes("statistics") || normalized.includes("metrics") || normalized.includes("numbers")) return "Stats"
  if (normalized.includes("cta") || normalized.includes("call-to-action") || normalized.includes("call to action")) return "CTA"
  if (normalized.includes("cardgrid") || normalized.includes("card grid") || normalized.includes("pricing")) return "CardGrid"
  if (normalized.includes("card")) return "Card"
  if (normalized.includes("richtext") || normalized.includes("rich text") || normalized.includes("rich-text") || normalized.includes("prose") || normalized.includes("text block") || normalized.includes("paragraph") || normalized.includes("copy")) return "RichText"
  if (normalized.includes("benefit") || normalized.includes("advantage")) return "FeatureGrid"
  if (normalized.includes("carousel") || normalized.includes("slideshow") || normalized.includes("slider")) return "Carousel"
  if (normalized.includes("gallery") || normalized.includes("image grid")) return "Gallery"
  if (normalized.includes("tabs") || normalized.includes("tabbed")) return "Tabs"
  if (normalized.includes("table")) return "Table"
  if (normalized.includes("blockquote")) return "Quote"
  if (normalized.includes("video")) return "Video"
  if (normalized.includes("embed") || normalized.includes("iframe") || normalized.includes("map")) return "Embed"
  if (normalized.includes("banner") || normalized.includes("announcement")) return "Banner"
  return undefined
}

// ---------------------------------------------------------------------------
// Block ID generation
// ---------------------------------------------------------------------------

export function nextBlockId(type: BlockType, page: PageDoc) {
  const base = `b_${type.toLowerCase()}_${Date.now()}`
  if (!page.blocks.some((b) => b.id === base)) return base
  let i = 1
  while (page.blocks.some((b) => b.id === `${base}_${i}`)) i += 1
  return `${base}_${i}`
}

// ---------------------------------------------------------------------------
// Default block props
// ---------------------------------------------------------------------------

export function defaultPropsForType(type: BlockType) {
  return sharedDefaultPropsForType(type)
}

// ---------------------------------------------------------------------------
// Patch helpers
// ---------------------------------------------------------------------------

export function patchObject(rawPatch: unknown) {
  if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) return null
  if (
    "props" in (rawPatch as Record<string, unknown>) &&
    (rawPatch as { props?: unknown }).props &&
    typeof (rawPatch as { props?: unknown }).props === "object" &&
    !Array.isArray((rawPatch as { props?: unknown }).props)
  ) {
    return (rawPatch as { props: Record<string, unknown> }).props
  }
  return rawPatch as Record<string, unknown>
}

function parseListItemPath(path: unknown): { listKey: string; index: number } | null {
  if (typeof path !== "string") return null
  const trimmed = path.trim()
  const match = trimmed.match(/^\/?([a-zA-Z0-9_]+)\[(\d+)\](?:\.[\w.-]+)?$/)
  if (!match) return null
  const listKey = match[1]
  const index = Number(match[2])
  if (!listKey || !Number.isInteger(index) || index < 0) return null
  return { listKey, index }
}

function inferPreferredListItemTextKey(allowedKeys: string[]) {
  const lowered = new Map(allowedKeys.map((key) => [key.toLowerCase(), key] as const))
  const preference = ["title", "label", "q", "quote", "heading", "description", "author", "value"]
  for (const candidate of preference) {
    const mapped = lowered.get(candidate)
    if (mapped) return mapped
  }
  return allowedKeys[0]
}

function remapListItemPatchKeys(args: { patchRaw: unknown; allowedKeys: string[] }) {
  const patch = patchObject(args.patchRaw)
  if (!patch || args.allowedKeys.length === 0) return patch

  const loweredToAllowed = new Map<string, string>()
  for (const key of args.allowedKeys) loweredToAllowed.set(key.toLowerCase(), key)
  const preferredTextKey = inferPreferredListItemTextKey(args.allowedKeys)

  const aliasToPreferred = new Set(["label", "name", "text", "heading", "headline"])
  const out: Record<string, unknown> = {}
  for (const [rawKey, value] of Object.entries(patch)) {
    const trimmed = rawKey.trim()
    const lowered = trimmed.toLowerCase()
    const mapped =
      loweredToAllowed.get(lowered) ??
      (aliasToPreferred.has(lowered) ? preferredTextKey : undefined)
    out[mapped ?? trimmed] = value
  }
  return out
}

// ---------------------------------------------------------------------------
// Plan candidate normalisation
// ---------------------------------------------------------------------------

export function normalizePlanCandidate(input: unknown, args?: { defaultSlug?: string; currentPage?: PageDoc; userMessage?: string }) {
  if (!input || typeof input !== "object") return input
  const root = input as Record<string, unknown>
  const hasInlineOp = !Array.isArray(root.ops) && !Array.isArray(root.operations) && Boolean(root.op ?? root.operation ?? root.action ?? root.kind)
  const ops = Array.isArray(root.ops) ? root.ops : Array.isArray(root.operations) ? root.operations : hasInlineOp ? [root] : []
  const userMessage = (args?.userMessage ?? "").toLowerCase()
  const requestedRoute = firstRouteMention(args?.userMessage)
  const routeMentions = extractRouteMentions(args?.userMessage)
  const requestedCreateSlug = parseCreatePageRequest(args?.userMessage ?? "")
  const createPageIntent = Boolean(requestedCreateSlug)
  const refersToCurrentPage = /\b(this|current|selected|the)\s+page\b/.test(userMessage)

  const resolvePageSlug = (candidate: unknown) => {
    const normalized = normalizeRouteCandidate(candidate)
    if (normalized) return normalized

    if (args?.currentPage) {
      if (typeof candidate !== "string") return args?.defaultSlug
      if (candidate === args.currentPage.id) return args.currentPage.slug
      if (candidate.toLowerCase() === "home" && args.currentPage.slug === "/") return "/"
    }

    return args?.defaultSlug
  }

  const beforeToAfter = (beforeId: unknown) => {
    if (!args?.currentPage || typeof beforeId !== "string") return undefined
    const idx = args.currentPage.blocks.findIndex((block) => block.id === beforeId)
    if (idx <= 0) return undefined
    return args.currentPage.blocks[idx - 1]?.id
  }

  const usedBlockIds = new Set<string>(
    (args?.currentPage?.blocks ?? []).map((b: { id: string }) => b.id)
  )

  let createdPageSlug: string | undefined
  let droppedPageLevelUpdate = false
  const normalizedOps = ops.flatMap((item) => {
    if (!item || typeof item !== "object") return item
    const source = item as Record<string, unknown>
    const raw = { ...source }

    // Accept malformed one-key op objects like { "move_block": { ...fields } }.
    if (!raw.op && !raw.operation && !raw.action && !raw.kind) {
      for (const key of [
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
        "duplicate_page"
      ] as const) {
        const value = source[key]
        if (value && typeof value === "object" && !Array.isArray(value)) {
          Object.assign(raw, value as Record<string, unknown>)
          raw.op = key
          break
        }
      }
    }

    raw.op = normalizeOpName(raw.op ?? raw.operation ?? raw.action ?? raw.kind)
    const rawType =
      raw.type ?? raw.blockType ?? raw.block_type ?? raw.newBlockType ?? raw.new_block_type ?? raw.target_block_type ?? raw.targetBlockType
    const normalizedType =
      typeof rawType === "string"
        ? allowedBlockTypes.find((type) => type.toLowerCase() === rawType.toLowerCase()) ?? inferBlockTypeFromText(rawType)
        : undefined

    const isListOperation = raw.op === "add_item" || raw.op === "update_item" || raw.op === "remove_item" || raw.op === "move_item"
    const pathLooksLikeListKey = typeof raw.path === "string" && !raw.path.startsWith("/")
    const listPathParsed =
      parseListItemPath(raw.itemPath ?? raw.item_path ?? raw.itempath ?? raw.itemPtr ?? raw.item_ptr) ??
      parseListItemPath(raw.path)
    raw.pageSlug = resolvePageSlug(raw.pageSlug ?? raw.page_slug ?? raw.slug ?? raw.page ?? (isListOperation ? undefined : raw.path) ?? raw.route ?? raw.from)
    raw.newPageSlug = normalizeRouteCandidate(
      raw.newPageSlug ?? raw.new_page_slug ?? raw.targetSlug ?? raw.target_slug ?? raw.toPageSlug ?? raw.to_page_slug ?? raw.to
    )
    if (!raw.blockId) {
      const pathCandidate = typeof raw.path === "string" && raw.path.startsWith("b_") ? raw.path : undefined
      raw.blockId =
        raw.block_id ??
        raw.targetBlockId ??
        raw.target_block_id ??
        raw.sourceBlockId ??
        raw.source_block_id ??
        raw.fromBlockId ??
        raw.from_block_id ??
        raw.id ??
        pathCandidate
    }
    // Infer blockId from currentPage when op needs it but model omitted it
    if (!raw.blockId && args?.currentPage) {
      const needsBlockId =
        raw.op === "update_props" || raw.op === "remove_block" || raw.op === "move_block" || raw.op === "duplicate_block"
      if (needsBlockId) {
        // Try type from explicit op fields first, then from user message keywords
        const typeHint = normalizedType ?? inferBlockTypeFromText(userMessage)
        if (typeHint) {
          const matches = args.currentPage.blocks.filter((b) => b.type === typeHint)
          if (matches.length === 1) {
            raw.blockId = matches[0].id
          }
        }
        // Fallback: if patch keys clearly map to only one block's props
        if (!raw.blockId && raw.op === "update_props") {
          const patch = patchObject(raw.patch ?? raw.props ?? raw.changes)
          if (patch) {
            const patchKeys = Object.keys(patch)
            const candidates = args.currentPage.blocks.filter((b) => {
              const bProps = b.props as Record<string, unknown> | undefined
              if (!bProps) return false
              return patchKeys.some((k) => k in bProps)
            })
            if (candidates.length === 1) raw.blockId = candidates[0].id
          }
        }
      }
    }
    if (!raw.listKey) {
      raw.listKey =
        raw.list_key ??
        raw.arrayKey ??
        raw.array_key ??
        raw.arrayProp ??
        raw.array_prop ??
        raw.collection ??
        raw.itemsKey ??
        raw.items_key ??
        listPathParsed?.listKey
      if (!raw.listKey && isListOperation && pathLooksLikeListKey) raw.listKey = raw.path
      if (!raw.listKey && isListOperation && typeof raw.path === "string") {
        const keyCandidate = raw.path.trim().replace(/^\/+/, "")
        if (keyCandidate && !keyCandidate.includes("/")) raw.listKey = keyCandidate
      }
      // Infer listKey from the target block's props when there is exactly one array field
      if (!raw.listKey && isListOperation && typeof raw.blockId === "string" && args?.currentPage) {
        const targetBlock = args.currentPage.blocks.find((b) => b.id === raw.blockId)
        const targetProps = targetBlock?.props as Record<string, unknown> | undefined
        if (targetProps) {
          const arrayKeys = Object.keys(targetProps).filter((k) => Array.isArray(targetProps[k]))
          if (arrayKeys.length === 1) raw.listKey = arrayKeys[0]
        }
      }
    }
    if (isListOperation && typeof raw.listKey === "string") raw.listKey = raw.listKey.replace(/^\/+/, "")
    if (isListOperation && typeof raw.listKey === "string" && typeof raw.pageSlug === "string" && raw.pageSlug === `/${raw.listKey}` && args?.defaultSlug) {
      raw.pageSlug = args.defaultSlug
    }
    if (typeof raw.index !== "number") {
      const indexRaw = raw.index ?? raw.itemIndex ?? raw.item_index ?? raw.fromIndex ?? raw.from_index ?? listPathParsed?.index
      const normalizedIndex = typeof indexRaw === "string" ? Number(indexRaw) : indexRaw
      if (typeof normalizedIndex === "number" && Number.isFinite(normalizedIndex)) raw.index = Math.trunc(normalizedIndex)
    }
    if (typeof raw.afterIndex !== "number") {
      const afterIndexRaw = raw.afterIndex ?? raw.after_index ?? raw.toIndex ?? raw.to_index ?? raw.targetIndex ?? raw.target_index
      const normalizedAfter = typeof afterIndexRaw === "string" ? Number(afterIndexRaw) : afterIndexRaw
      if (typeof normalizedAfter === "number" && Number.isFinite(normalizedAfter)) raw.afterIndex = Math.trunc(normalizedAfter)
    }
    if (!raw.item) {
      const sourceItem = raw.newItem ?? raw.new_item ?? raw.value
      if (sourceItem && typeof sourceItem === "object" && !Array.isArray(sourceItem)) raw.item = sourceItem
    }
    if (raw.op === "add_item" && (!raw.item || typeof raw.item !== "object" || Array.isArray(raw.item))) {
      const listKey = typeof raw.listKey === "string" ? raw.listKey.replace(/^\/+/, "") : ""
      const blockId = typeof raw.blockId === "string" ? raw.blockId : ""
      const currentBlock = blockId ? args?.currentPage?.blocks.find((block) => block.id === blockId) : undefined
      const currentProps = currentBlock?.props as Record<string, unknown> | undefined
      const listValue = listKey ? currentProps?.[listKey] : undefined
      const firstItem = Array.isArray(listValue) ? listValue.find((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) : undefined
      if (firstItem) {
        raw.item = structuredClone(firstItem as Record<string, unknown>)
      } else if (currentBlock?.type === "FAQAccordion") {
        raw.item = { q: "New question", a: "New answer" }
      } else if (currentBlock?.type === "FeatureGrid") {
        raw.item = { title: "New feature", description: "Feature description" }
      } else if (currentBlock?.type === "Testimonials") {
        raw.item = { quote: "New testimonial", author: "Customer" }
      } else if (currentBlock?.type === "CardGrid") {
        raw.item = { title: "New card", description: "Card description", ctaText: "Learn more", ctaHref: "/" }
      }
    }
    if (!raw.newBlockId) {
      raw.newBlockId = raw.new_block_id ?? raw.targetBlockId ?? raw.target_block_id ?? raw.copiedBlockId ?? raw.copied_block_id
    }
    if (!raw.afterBlockId) {
      raw.afterBlockId =
        raw.after_block_id ?? raw.after ?? raw.insertAfterId ?? beforeToAfter(raw.beforeId ?? raw.insertBeforeId)
    }
    if (!raw.afterPageSlug) {
      raw.afterPageSlug =
        raw.afterPageSlug ??
        raw.after_page_slug ??
        raw.afterPage ??
        raw.after_page ??
        raw.anchorPageSlug ??
        raw.anchor_page_slug ??
        raw.after
    }
    raw.afterPageSlug = resolvePageSlug(raw.afterPageSlug)
    raw.beforePageSlug = resolvePageSlug(raw.beforePageSlug ?? raw.before_page_slug ?? raw.beforePage ?? raw.before_page)
    if (!raw.patch) {
      raw.patch = raw.props ?? raw.changes
    }
    // LLMs sometimes put prop values directly on the op object instead of
    // nesting them under "patch". Extract non-structural keys as the patch.
    if (!raw.patch && raw.op === "update_props") {
      const structuralKeys = new Set([
        "op", "pageSlug", "page_slug", "blockId", "block_id", "patch", "props", "changes",
        "type", "blockType", "block_type", "newBlockType", "new_block_type", "targetBlockType", "target_block_type",
        "newPageSlug", "new_page_slug", "targetSlug", "target_slug", "toPageSlug", "to_page_slug",
        "afterBlockId", "after_block_id", "afterPageSlug", "after_page_slug", "beforePageSlug", "before_page_slug",
        "newBlockId", "new_block_id", "listKey", "list_key", "block",
        "path", "index", "item", "afterIndex", "itemPath",
      ])
      const extracted: Record<string, unknown> = {}
      let found = false
      for (const key of Object.keys(raw)) {
        if (!structuralKeys.has(key)) {
          extracted[key] = raw[key]
          found = true
        }
      }
      if (found) raw.patch = extracted
    }
    // Remap update_props patch keys: heading→title for non-Hero, question→q/answer→a in list items
    if (raw.op === "update_props" && raw.patch && typeof raw.patch === "object" && !Array.isArray(raw.patch) && typeof raw.blockId === "string") {
      const patch = raw.patch as Record<string, unknown>
      const targetBlock = args?.currentPage?.blocks.find((b) => b.id === raw.blockId)
      const blockType = targetBlock?.type ?? ""
      if (blockType !== "Hero" && "heading" in patch && !("title" in patch)) {
        patch.title = patch.heading
        delete patch.heading
      }
      const itemKeyAliases: Record<string, string> = { question: "q", answer: "a", testimonial: "quote", review: "quote" }
      for (const [propKey, propVal] of Object.entries(patch)) {
        if (!Array.isArray(propVal)) continue
        patch[propKey] = propVal.map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return item
          const entry = item as Record<string, unknown>
          let changed = false
          const mapped: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(entry)) {
            const alias = itemKeyAliases[k.toLowerCase()]
            if (alias && !(alias in entry)) {
              mapped[alias] = v
              changed = true
            } else {
              mapped[k] = v
            }
          }
          return changed ? mapped : entry
        })
      }

      // Block-specific prop key remapping and type coercion (mirrors add_block path)
      for (const k of ["autoplay", "loop", "striped"]) {
        if (typeof patch[k] === "boolean") patch[k] = patch[k] ? "true" : "false"
      }
      if (blockType === "Carousel" && Array.isArray(patch.slides) && !patch.items) {
        patch.items = patch.slides
        delete patch.slides
      }
      if (blockType === "Gallery") {
        const alt = patch.photos ?? patch.pictures
        if (Array.isArray(alt) && !patch.images) {
          patch.images = alt
          delete patch.photos
          delete patch.pictures
        }
        if (typeof patch.columns === "number") patch.columns = String(patch.columns)
      }
      if (blockType === "Table") {
        if (Array.isArray(patch.columns) && !patch.headers) {
          patch.headers = patch.columns
          delete patch.columns
        }
        if (Array.isArray(patch.data) && !patch.rows) {
          patch.rows = patch.data
          delete patch.data
        }
      }
    }

    // Convert update_props with appended array items → add_item ops.
    // When the LLM returns the full array (existing + new), extract only the new items as add_item ops
    // to avoid overwriting existing items with potentially stale copies.
    if (raw.op === "update_props" && typeof raw.blockId === "string" && raw.patch && typeof raw.patch === "object" && !Array.isArray(raw.patch) && args?.currentPage) {
      const patch = raw.patch as Record<string, unknown>
      const targetBlock = args.currentPage.blocks.find((b) => b.id === raw.blockId)
      if (targetBlock) {
        const blockProps = targetBlock.props as Record<string, unknown>
        for (const [key, patchVal] of Object.entries(patch)) {
          if (!Array.isArray(patchVal)) continue
          const existing = blockProps[key]
          if (!Array.isArray(existing) || existing.length === 0) continue
          if (patchVal.length <= existing.length) continue
          // The patch array is longer — likely existing items + new appended items.
          // Convert new tail items to add_item ops.
          const newItems = patchVal.slice(existing.length)
          if (newItems.length > 0 && newItems.every((it: unknown) => it && typeof it === "object" && !Array.isArray(it))) {
            delete patch[key]
            const slug = raw.pageSlug ?? args.defaultSlug ?? "/"
            const addItemOps = newItems.map((item: unknown) => ({
              op: "add_item",
              pageSlug: slug,
              blockId: raw.blockId,
              listKey: key,
              item
            }))
            // If patch has no remaining keys, replace this op entirely with add_item ops
            if (Object.keys(patch).length === 0) {
              return addItemOps
            }
            // Otherwise keep the update_props for scalar changes and append add_item ops
            return [raw, ...addItemOps]
          }
        }
      }
    }

    if (raw.op === "update_item" && typeof raw.blockId === "string" && typeof raw.listKey === "string") {
      const block = args?.currentPage?.blocks.find((candidate) => candidate.id === raw.blockId)
      const blockProps = block?.props as Record<string, unknown> | undefined
      const list = blockProps?.[raw.listKey]
      if (Array.isArray(list)) {
        const index = typeof raw.index === "number" ? raw.index : -1
        const itemAtIndex = index >= 0 ? list[index] : undefined
        const referenceItem =
          itemAtIndex && typeof itemAtIndex === "object" && !Array.isArray(itemAtIndex)
            ? (itemAtIndex as Record<string, unknown>)
            : (list.find((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) as Record<string, unknown> | undefined)
        const allowedKeys = referenceItem ? Object.keys(referenceItem) : []
        const remapped = remapListItemPatchKeys({ patchRaw: raw.patch, allowedKeys })
        if (remapped) raw.patch = remapped
      }
    }

    if (
      raw.op === "update_props" &&
      (!raw.blockId || typeof raw.blockId !== "string") &&
      args?.defaultSlug
    ) {
      const patch = patchObject(raw.patch)
      const newSlugFromPatch = normalizeRouteCandidate(patch?.slug ?? patch?.path ?? patch?.route)
      const newSlugFromPath = typeof raw.path === "string" && raw.path.startsWith("/") ? normalizeRouteCandidate(raw.path) : null
      const fromSlugFromMentions = routeMentions[0]
      const toSlugFromMentions = routeMentions.length >= 2 ? routeMentions[routeMentions.length - 1] : undefined
      const nextSlug = raw.newPageSlug ?? newSlugFromPatch ?? newSlugFromPath ?? toSlugFromMentions
      const fromSlug = resolvePageSlug(raw.pageSlug ?? raw.fromPageSlug ?? raw.from_page_slug ?? raw.oldSlug ?? fromSlugFromMentions)
      if (fromSlug && nextSlug && fromSlug !== nextSlug) {
        raw.op = "rename_page"
        raw.pageSlug = fromSlug
        raw.newPageSlug = nextSlug
        delete raw.patch
      }
    }

    if (raw.op === "remove_block" && (!raw.blockId || typeof raw.blockId !== "string")) {
      const asksDeletePage = /\b(delete|remove)\b.*\bpage\b/.test(userMessage)
      if (asksDeletePage) {
        raw.op = "remove_page"
        raw.pageSlug = resolvePageSlug(raw.pageSlug ?? raw.path ?? raw.slug ?? raw.route ?? routeMentions[0] ?? args?.defaultSlug)
      }
    }

    // Convert remove_block → remove_item when user is removing a list item (e.g., "remove the first question")
    if (raw.op === "remove_block" && typeof raw.blockId === "string" && args?.currentPage) {
      const asksRemoveItem = /\b(question|item|faq|entry|testimonial|card|feature|first|second|third|last)\b/i.test(userMessage)
      if (asksRemoveItem) {
        const block = args.currentPage.blocks.find((b) => b.id === raw.blockId)
        if (block) {
          const bProps = block.props as Record<string, unknown> | undefined
          if (bProps) {
            for (const [key, val] of Object.entries(bProps)) {
              if (!Array.isArray(val) || val.length === 0) continue
              // Determine which index to remove
              let idx = 0
              if (/\blast\b/i.test(userMessage)) idx = val.length - 1
              else if (/\bsecond\b/i.test(userMessage)) idx = 1
              else if (/\bthird\b/i.test(userMessage)) idx = 2
              raw.op = "remove_item"
              raw.listKey = key
              raw.index = idx
              break
            }
          }
        }
      }
    }

    if (raw.op === "rename_page") {
      const nextSlug =
        raw.newPageSlug ??
        normalizeRouteCandidate(raw.path) ??
        normalizeRouteCandidate(raw.route) ??
        normalizeRouteCandidate(raw.slug) ??
        (routeMentions.length >= 2 ? routeMentions[routeMentions.length - 1] : undefined)
      raw.pageSlug = resolvePageSlug(raw.pageSlug ?? raw.fromPageSlug ?? raw.from_page_slug ?? raw.oldSlug ?? routeMentions[0])
      raw.newPageSlug = nextSlug
      if (!raw.newTitle && typeof raw.title === "string" && raw.title.trim().length > 0) raw.newTitle = raw.title.trim()
      if (
        typeof raw.pageSlug === "string" &&
        typeof raw.newPageSlug === "string" &&
        raw.pageSlug === raw.newPageSlug
      ) {
        return null
      }
    }

    if (raw.op === "remove_page") {
      raw.pageSlug = resolvePageSlug(raw.pageSlug ?? raw.path ?? raw.slug ?? raw.route ?? routeMentions[0] ?? args?.defaultSlug)
    }

    if (raw.op === "move_page") {
      raw.pageSlug = resolvePageSlug(raw.pageSlug ?? raw.path ?? raw.slug ?? raw.route ?? routeMentions[0] ?? args?.defaultSlug)
      if (!raw.afterPageSlug && raw.beforePageSlug && args?.currentPage) {
        if (raw.beforePageSlug === "/") raw.afterPageSlug = undefined
        else if (raw.beforePageSlug === args.currentPage.slug) raw.afterPageSlug = undefined
      }
      if (!raw.afterPageSlug && routeMentions.length >= 2) {
        const lower = userMessage
        if (/\b(after|below|under)\b/.test(lower)) raw.afterPageSlug = routeMentions[1]
      }
    }

    if (raw.op === "duplicate_page") {
      raw.pageSlug = resolvePageSlug(raw.pageSlug ?? raw.path ?? raw.slug ?? raw.route ?? raw.from ?? routeMentions[0] ?? args?.defaultSlug)
      raw.newPageSlug = normalizeRouteCandidate(
        raw.newPageSlug ?? raw.new_page_slug ?? raw.targetSlug ?? raw.target_slug ?? raw.toPageSlug ?? raw.to_page_slug ?? raw.to
      )
      if (!raw.afterPageSlug && routeMentions.length >= 2) {
        const lower = userMessage
        if (/\b(after|below|under)\b/.test(lower)) raw.afterPageSlug = routeMentions[1]
      }
    }

    if (raw.op === "duplicate_block") {
      raw.toPageSlug = resolvePageSlug(
        raw.toPageSlug ?? raw.to_page_slug ?? raw.targetPageSlug ?? raw.target_page_slug ?? raw.newPageSlug ?? raw.new_page_slug
      )
    }
    if (!raw.block) {
      raw.block = raw.newBlock ?? raw.new_block
      if (!raw.block && (raw.op === "add_block" || raw.op === "create_page") && normalizedType) {
        let generatedId =
          typeof raw.blockId === "string" && raw.blockId.length > 0
            ? raw.blockId
            : `b_${String(normalizedType).toLowerCase()}_${Date.now()}`
        // Dedup against both existing page blocks and earlier ops in this batch
        let suffix = 0
        while (usedBlockIds.has(generatedId)) {
          suffix++
          generatedId = `b_${String(normalizedType).toLowerCase()}_${Date.now()}_${suffix}`
        }
        usedBlockIds.add(generatedId)
        const incomingPatch = patchObject(raw.props ?? raw.patch ?? raw.changes) ?? {}
        raw.block = {
          id: generatedId,
          type: normalizedType,
          props: { ...defaultPropsForType(normalizedType), ...incomingPatch }
        }
      }
    }
    if (raw.op === "add_block" && raw.block && typeof raw.block === "object" && !Array.isArray(raw.block)) {
      const block = raw.block as Record<string, unknown>
      if (typeof block.type === "string") {
        const fixed = allowedBlockTypes.find((t) => t.toLowerCase() === (block.type as string).toLowerCase()) ?? inferBlockTypeFromText(block.type as string)
        if (fixed) block.type = fixed
      } else if (normalizedType) {
        block.type = normalizedType
      }
      if (!block.props || typeof block.props !== "object" || Array.isArray(block.props)) {
        if (raw.patch || raw.props || raw.changes) {
          block.props = patchObject(raw.patch ?? raw.props ?? raw.changes) ?? {}
        } else if (typeof block.type === "string") {
          // LLM omitted props entirely — seed with schema defaults so validation passes
          block.props = defaultPropsForType(block.type as BlockType)
        } else {
          block.props = {}
        }
      }
      if ((!block.id || typeof block.id !== "string") && typeof block.type === "string") {
        let fallbackId = `b_${String(block.type).toLowerCase()}_${Date.now()}`
        let sfx = 0
        while (usedBlockIds.has(fallbackId)) {
          sfx++
          fallbackId = `b_${String(block.type).toLowerCase()}_${Date.now()}_${sfx}`
        }
        usedBlockIds.add(fallbackId)
        block.id = fallbackId
      }
      raw.block = block

      // Remap heading→title for non-Hero blocks (LLMs often confuse heading/title)
      if (block.props && typeof block.props === "object" && !Array.isArray(block.props)) {
        const bProps = block.props as Record<string, unknown>
        const blockType = typeof block.type === "string" ? block.type : ""
        if (blockType !== "Hero" && "heading" in bProps && !("title" in bProps)) {
          bProps.title = bProps.heading
          delete bProps.heading
        }
      }

      // Remap list item keys inside add_block props (e.g., question→q, answer→a)
      if (block.props && typeof block.props === "object" && !Array.isArray(block.props)) {
        const bProps = block.props as Record<string, unknown>
        const itemKeyAliases: Record<string, string> = { question: "q", answer: "a", testimonial: "quote", review: "quote" }
        for (const [propKey, propVal] of Object.entries(bProps)) {
          if (!Array.isArray(propVal)) continue
          bProps[propKey] = propVal.map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return item
            const entry = item as Record<string, unknown>
            let changed = false
            const mapped: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(entry)) {
              const alias = itemKeyAliases[k.toLowerCase()]
              if (alias && !(alias in entry)) {
                mapped[alias] = v
                changed = true
              } else {
                mapped[k] = v
              }
            }
            return changed ? mapped : entry
          })
        }
      }

      // Block-specific prop key remapping and type coercion
      if (typeof block.type === "string" && block.props && typeof block.props === "object" && !Array.isArray(block.props)) {
        const cProps = block.props as Record<string, unknown>
        const bt = block.type

        // Coerce boolean→string for "true"/"false" enum props (Carousel, Video, Table)
        for (const k of ["autoplay", "loop", "striped"]) {
          if (typeof cProps[k] === "boolean") cProps[k] = cProps[k] ? "true" : "false"
        }

        // Carousel: slides→items
        if (bt === "Carousel" && Array.isArray(cProps.slides) && !cProps.items) {
          cProps.items = cProps.slides
          delete cProps.slides
        }
        // Gallery: photos/pictures→images, numeric columns→string
        if (bt === "Gallery") {
          const alt = cProps.photos ?? cProps.pictures
          if (Array.isArray(alt) && !cProps.images) {
            cProps.images = alt
            delete cProps.photos
            delete cProps.pictures
          }
          if (typeof cProps.columns === "number") cProps.columns = String(cProps.columns)
        }
        // Table: columns→headers, data→rows
        if (bt === "Table") {
          if (Array.isArray(cProps.columns) && !cProps.headers) {
            cProps.headers = cProps.columns
            delete cProps.columns
          }
          if (Array.isArray(cProps.data) && !cProps.rows) {
            cProps.rows = cProps.data
            delete cProps.data
          }
        }
      }
    }

    // Convert add_block → add_item when targeting an existing single-instance block with list items
    if (raw.op === "add_block" && raw.block && typeof raw.block === "object" && !Array.isArray(raw.block) && args?.currentPage) {
      const block = raw.block as Record<string, unknown>
      const blockType = typeof block.type === "string" ? block.type : undefined
      if (blockType) {
        const existingBlocks = args.currentPage.blocks.filter((b) => b.type === blockType)
        if (existingBlocks.length === 1) {
          const existing = existingBlocks[0]
          const existingProps = existing.props as Record<string, unknown> | undefined
          const newProps = block.props as Record<string, unknown> | undefined
          if (existingProps && newProps) {
            for (const [key, val] of Object.entries(existingProps)) {
              if (!Array.isArray(val)) continue
              const newVal = newProps[key]
              if (!Array.isArray(newVal) || newVal.length === 0) continue
              const newItem = newVal[0]
              if (newItem && typeof newItem === "object" && !Array.isArray(newItem)) {
                raw.op = "add_item"
                raw.blockId = existing.id
                raw.listKey = key
                raw.item = newItem
                raw.pageSlug = raw.pageSlug ?? args?.defaultSlug
                delete raw.block
                break
              }
            }
          }
        }
      }
    }

    const createSlugCandidate = resolvePageSlug(raw.pageSlug ?? raw.path ?? raw.slug ?? requestedRoute)
    const explicitCreateTarget = createSlugCandidate && createSlugCandidate !== args?.defaultSlug

    // If user asked to create a page and model emitted add_block on a new route, synthesize create_page.
    if (raw.op === "add_block" && createPageIntent && explicitCreateTarget && !createdPageSlug) {
      const createSlug = createSlugCandidate ?? requestedRoute ?? args?.defaultSlug ?? "/"
      const nowIso = new Date().toISOString()

      let firstBlock: PageDoc["blocks"][number] | null = null
      if (raw.block && typeof raw.block === "object" && !Array.isArray(raw.block)) {
        const block = raw.block as Record<string, unknown>
        const typeRaw = typeof block.type === "string" ? block.type : normalizedType
        const blockType =
          typeof typeRaw === "string"
            ? allowedBlockTypes.find((t) => t.toLowerCase() === typeRaw.toLowerCase()) ?? inferBlockTypeFromText(typeRaw)
            : undefined
        if (blockType) {
          const id = typeof block.id === "string" && block.id.length > 0 ? block.id : `b_${blockType.toLowerCase()}_${Date.now()}`
          const props =
            block.props && typeof block.props === "object" && !Array.isArray(block.props)
              ? { ...defaultPropsForType(blockType), ...(block.props as Record<string, unknown>) }
              : defaultPropsForType(blockType)
          firstBlock = { id, type: blockType, props }
        }
      }

      if (!firstBlock) {
        firstBlock = {
          id: `b_hero_${Date.now()}`,
          type: "Hero",
          props: defaultPropsForType("Hero")
        }
      }

      raw.op = "create_page"
      raw.page = {
        id: pageIdFromSlug(createSlug),
        slug: createSlug,
        title: pageTitleFromSlug(createSlug),
        updatedAt: nowIso,
        blocks: [firstBlock]
      } satisfies PageDoc
      raw.pageSlug = createSlug
      createdPageSlug = createSlug
      return raw
    }

    // LLMs sometimes emit create_page when they actually mean add_block.
    if (
      raw.op === "create_page" &&
      !raw.page &&
      !explicitCreateTarget &&
      (raw.block || normalizedType || raw.blockId || raw.patch || raw.props)
    ) {
      raw.op = "add_block"
      raw.pageSlug = resolvePageSlug(raw.pageSlug ?? raw.path ?? args?.defaultSlug)
    }

    // LLMs also emit create_page with blocks[] for existing pages. Convert to add_block sequence.
    // But only when targeting the current page — if it's an explicit new route, let it fall
    // through to the create_page handler that synthesizes a proper PageDoc.
    if (
      raw.op === "create_page" &&
      !raw.page &&
      !explicitCreateTarget &&
      Array.isArray(raw.blocks) &&
      raw.blocks.length > 0
    ) {
      const pageSlug = resolvePageSlug(raw.pageSlug ?? raw.path ?? args?.defaultSlug) ?? args?.defaultSlug
      if (!pageSlug) return raw
      const out: Record<string, unknown>[] = []
      let previousId: string | undefined
      // Track blocks as we add them so nextBlockId generates unique IDs
      let pageSnapshot = args?.currentPage
      for (const candidate of raw.blocks) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue
        const block = { ...(candidate as Record<string, unknown>) }
        const typeRaw = typeof block.type === "string" ? block.type : ""
        const blockType =
          allowedBlockTypes.find((t) => t.toLowerCase() === typeRaw.toLowerCase()) ?? inferBlockTypeFromText(typeRaw)
        if (!blockType) continue
        if (typeof block.id !== "string" || block.id.length === 0) {
          block.id = pageSnapshot ? nextBlockId(blockType, pageSnapshot) : `b_${blockType.toLowerCase()}_${Date.now()}`
        }
        if (!block.props || typeof block.props !== "object" || Array.isArray(block.props)) {
          block.props = defaultPropsForType(blockType)
        }
        const addOp: Record<string, unknown> = {
          op: "add_block",
          pageSlug,
          block
        }
        if (previousId) addOp.afterBlockId = previousId
        previousId = block.id as string
        // Update snapshot so the next nextBlockId sees this block's ID
        if (pageSnapshot) {
          pageSnapshot = { ...pageSnapshot, blocks: [...pageSnapshot.blocks, { id: block.id as string, type: blockType, props: block.props as Record<string, unknown> }] }
        }
        out.push(addOp)
      }
      return out.length > 0 ? out : raw
    }

    // Accept lightweight or partial create_page operations and synthesize a valid PageDoc payload.
    if (raw.op === "create_page") {
      const pageInput =
        raw.page && typeof raw.page === "object" && !Array.isArray(raw.page) ? (raw.page as Record<string, unknown>) : {}
      const pageSlugInput =
        pageInput.slug ?? raw.pageSlug ?? raw.page_slug ?? raw.path ?? raw.slug ?? raw.route ?? requestedRoute ?? args?.defaultSlug ?? "/"
      const slug = resolvePageSlug(pageSlugInput) ?? requestedRoute ?? args?.defaultSlug ?? "/"
      const nowIso = new Date().toISOString()
      const blocks: PageDoc["blocks"] = []
      const shouldTreatAsCurrentPageEdit =
        !requestedCreateSlug && refersToCurrentPage && !!args?.defaultSlug && slug === args.defaultSlug

      // Blocks may be inside pageInput.blocks (page wrapper) or raw.blocks (flat format).
      const blocksSource = Array.isArray(pageInput.blocks) ? pageInput.blocks : Array.isArray(raw.blocks) ? raw.blocks : null
      if (blocksSource) {
        const usedIds = new Set<string>()
        for (const candidate of blocksSource) {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue
          const block = candidate as Record<string, unknown>
          const typeRaw = typeof block.type === "string" ? block.type : ""
          const blockType =
            allowedBlockTypes.find((t) => t.toLowerCase() === typeRaw.toLowerCase()) ?? inferBlockTypeFromText(typeRaw)
          if (!blockType) continue
          let id = typeof block.id === "string" && block.id.length > 0 ? block.id : `b_${blockType.toLowerCase()}_${Date.now()}`
          let suffix = 1
          while (usedIds.has(id)) { id = `b_${blockType.toLowerCase()}_${Date.now()}_${suffix++}` }
          usedIds.add(id)
          const props =
            block.props && typeof block.props === "object" && !Array.isArray(block.props)
              ? { ...defaultPropsForType(blockType), ...(block.props as Record<string, unknown>) }
              : defaultPropsForType(blockType)
          blocks.push({ id, type: blockType, props })
        }
      }

      if (shouldTreatAsCurrentPageEdit && blocks.length > 0) {
        let previousId: string | undefined
        const out: Record<string, unknown>[] = []
        for (const block of blocks) {
          const addOp: Record<string, unknown> = { op: "add_block", pageSlug: slug, block }
          if (previousId) addOp.afterBlockId = previousId
          previousId = block.id
          out.push(addOp)
        }
        return out
      }

      if (blocks.length === 0 && raw.block && typeof raw.block === "object" && !Array.isArray(raw.block)) {
        const block = { ...(raw.block as Record<string, unknown>) }
        const typeRaw = typeof block.type === "string" ? block.type : normalizedType
        const blockType =
          typeof typeRaw === "string"
            ? allowedBlockTypes.find((t) => t.toLowerCase() === typeRaw.toLowerCase()) ?? inferBlockTypeFromText(typeRaw)
            : undefined
        if (blockType) {
          const id = typeof block.id === "string" && block.id.length > 0 ? block.id : `b_${blockType.toLowerCase()}_${Date.now()}`
          const props =
            block.props && typeof block.props === "object" && !Array.isArray(block.props)
              ? { ...defaultPropsForType(blockType), ...(block.props as Record<string, unknown>) }
              : defaultPropsForType(blockType)
          blocks.push({ id, type: blockType, props })
        }
      }
      if (shouldTreatAsCurrentPageEdit && blocks.length > 0) {
        raw.op = "add_block"
        raw.pageSlug = slug
        raw.block = blocks[0]
        delete raw.page
        delete raw.page_slug
        delete raw.slug
        delete raw.path
        return raw
      }

      raw.page = {
        id: typeof pageInput.id === "string" && pageInput.id.trim().length > 0 ? pageInput.id.trim() : pageIdFromSlug(slug),
        slug,
        title:
          typeof pageInput.title === "string" && pageInput.title.trim().length > 0 ? pageInput.title.trim() : pageTitleFromSlug(slug),
        updatedAt:
          typeof pageInput.updatedAt === "string" && pageInput.updatedAt.trim().length > 0 ? pageInput.updatedAt.trim() : nowIso,
        blocks
      } satisfies PageDoc
      raw.pageSlug = slug
      createdPageSlug = slug
    }

    // If model mixes create_page + add_block and keeps add_block on the current route, move it to the new route.
    if (raw.op === "add_block" && createPageIntent && createdPageSlug && raw.pageSlug === args?.defaultSlug) {
      raw.pageSlug = createdPageSlug
    }

    // Intent repair: if user asked for bottom/end and model omitted an anchor, place at end.
    if (
      (raw.op === "move_block" || raw.op === "add_block") &&
      !raw.afterBlockId &&
      args?.currentPage &&
      (userMessage.includes("bottom") || userMessage.includes("end") || userMessage.includes("last"))
    ) {
      const movingId =
        typeof raw.blockId === "string"
          ? raw.blockId
          : raw.op === "add_block" && raw.block && typeof raw.block === "object" && typeof (raw.block as { id?: unknown }).id === "string"
            ? (raw.block as { id: string }).id
            : undefined
      const tail = [...args.currentPage.blocks].reverse().find((b) => b.id !== movingId)
      if (tail) raw.afterBlockId = tail.id
    }

    // Remap add_item item keys to match existing schema (e.g., question→q, answer→a)
    if (raw.op === "add_item" && raw.item && typeof raw.item === "object" && !Array.isArray(raw.item) && typeof raw.blockId === "string") {
      const targetBlock = args?.currentPage?.blocks.find((b) => b.id === raw.blockId)
      if (targetBlock) {
        const bProps = targetBlock.props as Record<string, unknown> | undefined
        const lk = typeof raw.listKey === "string" ? raw.listKey : undefined
        const list = lk ? bProps?.[lk] : undefined
        const refItem = Array.isArray(list)
          ? (list.find((e) => e && typeof e === "object" && !Array.isArray(e)) as Record<string, unknown> | undefined)
          : undefined
        if (refItem) {
          const allowedKeys = Object.keys(refItem)
          const remapped = remapListItemPatchKeys({ patchRaw: raw.item, allowedKeys })
          if (remapped) {
            // Semantic aliases for common key alternatives
            const extraAliases: Record<string, string> = { question: "q", answer: "a", testimonial: "quote", review: "quote" }
            const allowedSet = new Set(allowedKeys)
            const final: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(remapped)) {
              const alias = extraAliases[k.toLowerCase()]
              if (alias && allowedSet.has(alias) && !(alias in remapped)) {
                final[alias] = v
              } else {
                final[k] = v
              }
            }
            raw.item = final
          }
        }
      }
    }

    return raw
  })

  const sanitizedOps = normalizedOps.filter((item) => {
    if (!item) return false
    if (typeof item !== "object" || Array.isArray(item)) return true
    const raw = item as Record<string, unknown>
    if (normalizeOpName(raw.op) !== "update_props") return true
    if (typeof raw.blockId === "string" && raw.blockId.length > 0) return true
    const patch = patchObject(raw.patch)
    const hasPageLevelPatch =
      !!patch &&
      (typeof patch.slug === "string" || typeof patch.path === "string" || typeof patch.route === "string" || typeof patch.title === "string")
    const pathLooksLikeRoute = typeof raw.path === "string" && raw.path.startsWith("/")
    if (hasPageLevelPatch || pathLooksLikeRoute) {
      droppedPageLevelUpdate = true
      return false
    }
    return false
  })

  if (droppedPageLevelUpdate && sanitizedOps.length === 0) {
    return {
      ...root,
      intent: "needs_clarification",
      summary_for_user: "I could not infer a valid page operation. Specify the source and target routes explicitly.",
      change_log: [
        "Ignored an invalid page-level update_props operation that was missing blockId.",
        "Try: rename page from /old to /new, or delete page /path."
      ],
      ops: []
    }
  }

  // Reorder ops so create_page always precedes ops targeting the same slug.
  // The LLM may emit add_block ops before the corresponding create_page.
  const reorderedOps = reorderCreatePageFirst(sanitizedOps)

  // Ensure required EditPlan fields exist — smaller models sometimes omit them
  if (!root.intent) {
    root.intent = reorderedOps.length > 0 ? "edit_plan" : "needs_clarification"
  }
  if (!root.summary_for_user && typeof root.summary === "string") {
    root.summary_for_user = root.summary // common model alias
  }
  if (typeof root.suggested_next_actions === "string") {
    root.suggested_next_actions = root.suggested_next_actions
      .split(/\n|[,;]/)
      .map((s: string) => s.replace(/^\s*[-•*\d.)\]]+\s*/, "").trim())
      .filter(Boolean)
  }
  if (typeof root.change_log === "string") {
    root.change_log = root.change_log
      .split(/\n/)
      .map((s: string) => s.replace(/^\s*[-•*\d.)\]]+\s*/, "").trim())
      .filter(Boolean)
  }
  if (!Array.isArray(root.change_log)) {
    root.change_log = reorderedOps.map((op: any) => {
      const verb = op.op?.replace(/_/g, " ") ?? "modify"
      return `${verb} on ${op.pageSlug ?? "page"}`
    })
  }

  if (hasInlineOp) {
    if (reorderedOps.length === 1) return reorderedOps[0]
    return { ...root, ops: reorderedOps }
  }
  return { ...root, ops: reorderedOps }
}
