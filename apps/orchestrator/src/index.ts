import dotenv from "dotenv"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import Fastify from "fastify"
import cors from "@fastify/cors"
import OpenAI from "openai"
import { z } from "zod"
import {
  allowedBlockTypes,
  blockSchemas,
  demoPublishedPages,
  editPlanSchema,
  operationSchema,
  type BlockType,
  type EditPlan,
  type Operation,
  type PageDoc,
  validateBlockProps
} from "@ai-site-editor/shared"

const app = Fastify({ logger: true })
await app.register(cors, { origin: true })

const envCandidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]
for (const path of envCandidates) {
  if (existsSync(path)) {
    dotenv.config({ path })
    break
  }
}

const publishedPages = new Map<string, PageDoc>()
for (const page of demoPublishedPages()) publishedPages.set(page.slug, structuredClone(page))

const draftPages = new Map<string, Map<string, PageDoc>>()
const historyUndo = new Map<string, Map<string, PageDoc[]>>()
const historyRedo = new Map<string, Map<string, PageDoc[]>>()
const versions = new Map<string, number>()
const recentEdits = new Map<string, Array<{ slug: string; summary: string; ops: Operation[]; at: string }>>()

const modelLookup = {
  fast: process.env.OPENAI_MODEL_FAST ?? "gpt-4o-mini",
  balanced: process.env.OPENAI_MODEL_BALANCED ?? "gpt-5",
  reasoning: process.env.OPENAI_MODEL_REASONING ?? "gpt-5",
  codex: process.env.OPENAI_MODEL_CODEX ?? "gpt-5-codex"
} as const

type ModelKey = keyof typeof modelLookup
type ChatRequestBody = {
  session?: string
  slug?: string
  message?: string
  modelKey?: ModelKey
  activeBlockId?: string
  activeBlockType?: string
  activeEditablePath?: string
}

type ApplyOpsRequestBody = {
  session?: string
  ops?: unknown
}

type ChatResult = {
  status: string
  summary: string
  changes: string[]
  suggestions?: string[]
  validationErrors?: unknown
  previewVersion: number
  focusBlockId?: string
  plannerSource: "openai" | "demo"
  modelUsed: string
  modelKey: ModelKey
}

function openAIChatOptionsForModel(model: string) {
  // gpt-5 family rejects temperature=0 in chat.completions; omit to use model default.
  if (model.startsWith("gpt-5")) return {}
  return { temperature: 0 as const }
}

function isInfoQuery(message: string) {
  const m = message.toLowerCase()
  const normalized = m.replace(/\s+/g, " ").trim()
  const blockCatalogPatterns = [
    /\bwhat\s+(other\s+)?blocks?\s+can\s+(you|i)\s+add\b/,
    /\bwhich\s+(other\s+)?blocks?\s+can\s+(you|i)\s+add\b/,
    /\bwhat\s+(other\s+)?block\s+types?\s+can\s+(you|i)\s+add\b/,
    /\bwhich\s+(other\s+)?block\s+types?\s+can\s+(you|i)\s+add\b/,
    /\bwhat\s+else\s+can\s+i\s+add\b/,
    /\bwhat\s+other\s+content\b/,
    /\bavailable\s+blocks?\b/,
    /\bavailable\s+block\s+types?\b/
  ]
  if (blockCatalogPatterns.some((re) => re.test(normalized))) return true

  return (
    m.includes("what blocks can you add") ||
    m.includes("what block can you add") ||
    m.includes("which blocks can you add") ||
    m.includes("which block types can i add") ||
    m.includes("what block types can i add") ||
    m.includes("available blocks") ||
    m.includes("what can i change") ||
    m.includes("what can i edit") ||
    m.includes("what content") ||
    m.includes("content elements") ||
    m.includes("which fields") ||
    m.includes("what fields") ||
    m.includes("what properties") ||
    m.includes("what props")
  )
}

function isBlockCatalogQuery(message: string) {
  const m = message.toLowerCase().replace(/\s+/g, " ").trim()
  return (
    /\bwhat\s+(other\s+)?blocks?\s+can\s+(you|i)\s+add\b/.test(m) ||
    /\bwhich\s+(other\s+)?blocks?\s+can\s+(you|i)\s+add\b/.test(m) ||
    /\bwhat\s+(other\s+)?block\s+types?\s+can\s+(you|i)\s+add\b/.test(m) ||
    /\bwhich\s+(other\s+)?block\s+types?\s+can\s+(you|i)\s+add\b/.test(m) ||
    /\bwhat\s+else\s+can\s+i\s+add\b/.test(m) ||
    /\bavailable\s+blocks?\b/.test(m) ||
    /\bavailable\s+block\s+types?\b/.test(m)
  )
}

function editablePropsFromBlock(block: PageDoc["blocks"][number]) {
  if (!block || !block.props || typeof block.props !== "object") return []
  return Object.keys(block.props as Record<string, unknown>)
}

function promptFromPropKey(propKey: string) {
  const labels: Record<string, string> = {
    heading: "Change heading to \"...\"",
    subheading: "Change subheading to \"...\"",
    ctaText: "Change CTA text to \"...\"",
    ctaHref: "Change CTA link to \"/...\"",
    title: "Change title to \"...\"",
    description: "Change description to \"...\"",
    features: "Update feature list",
    items: "Update items",
    cards: "Update cards"
  }
  return labels[propKey] ?? `Change ${propKey} to \"...\"`
}

function childSuggestions(args: { selected: PageDoc["blocks"][number]; editablePath: string }) {
  const { selected, editablePath } = args
  const path = editablePath.trim()
  if (!path) return []
  const root = path.split(".")[0] ?? path

  if (selected.type === "CardGrid" && root.startsWith("cards[")) {
    return [
      `Update ${root}.title to \"...\"`,
      `Update ${root}.description to \"...\"`,
      `Update ${root}.ctaText to \"...\"`,
      `Update ${root}.ctaHref to \"/...\"`
    ]
  }

  if (selected.type === "FeatureGrid" && root.startsWith("features[")) {
    return [`Update ${root}.title to \"...\"`, `Update ${root}.description to \"...\"`]
  }

  if (selected.type === "Testimonials" && root.startsWith("items[")) {
    return [`Update ${root}.quote to \"...\"`, `Update ${root}.author to \"...\"`]
  }

  if (selected.type === "FAQAccordion" && root.startsWith("items[")) {
    return [`Update ${root}.q to \"...\"`, `Update ${root}.a to \"...\"`]
  }

  return [`Update ${root} ...`]
}

function infoResponse(args: {
  body: ChatRequestBody
  current: PageDoc
  plannerSource: "openai" | "demo"
  modelUsed: string
  modelKey: ModelKey
}): { code: number; payload: ChatResult } {
  const { body, current, plannerSource, modelUsed, modelKey } = args
  const lower = (body.message ?? "").toLowerCase()

  const asksBlockTypes =
    lower.includes("what blocks can you add") ||
    lower.includes("what block can you add") ||
    lower.includes("which blocks can you add") ||
    lower.includes("which block types can i add") ||
    lower.includes("what block types can i add") ||
    lower.includes("available blocks")

  if (asksBlockTypes) {
    return {
      code: 200,
      payload: {
        status: "info",
        summary: `You can add these block types: ${allowedBlockTypes.join(", ")}.`,
        changes: ["Tip: specify position, e.g. “add Testimonials below Hero”."],
        suggestions: [
          "Add Testimonials below Hero",
          "Add CardGrid at the end",
          "Add FeatureGrid after Hero",
          "Add FAQAccordion before CTA",
          "Add CTA at the end"
        ],
        previewVersion: versions.get(body.session ?? "dev") ?? 0,
        plannerSource,
        modelUsed,
        modelKey
      }
    }
  }

  const selected =
    body.activeBlockId && current.blocks.find((b) => b.id === body.activeBlockId)
      ? current.blocks.find((b) => b.id === body.activeBlockId)
      : null

  if (selected) {
    const keys = editablePropsFromBlock(selected)
    const childPath = String(body.activeEditablePath ?? "")
    const suggestions = childPath ? childSuggestions({ selected, editablePath: childPath }) : keys.slice(0, 4).map(promptFromPropKey)
    const summary = childPath
      ? `Focused ${selected.type} item: ${childPath}.`
      : `You can edit ${selected.type} fields: ${keys.join(", ")}.`
    return {
      code: 200,
      payload: {
        status: "info",
        summary,
        changes: childPath
          ? [`Selected block: ${selected.id}`, `Focused path: ${childPath}`]
          : [`Selected block: ${selected.id}`, "Tip: click a field name in your prompt, e.g. “change heading to …”."],
        suggestions,
        previewVersion: versions.get(body.session ?? "dev") ?? 0,
        plannerSource,
        modelUsed,
        modelKey
      }
    }
  }

  const firstByType = new Map<BlockType, PageDoc["blocks"][number]>()
  for (const block of current.blocks) {
    if (!firstByType.has(block.type)) firstByType.set(block.type, block)
  }
  const byType = Array.from(firstByType.values()).map((b) => `${b.type}: ${editablePropsFromBlock(b).join(", ")}`)
  return {
    code: 200,
    payload: {
      status: "info",
      summary: "Select a block to get precise editable fields. Current page supports:",
      changes: byType,
      previewVersion: versions.get(body.session ?? "dev") ?? 0,
      plannerSource,
      modelUsed,
      modelKey
    }
  }
}

function getSessionDraft(session: string) {
  let sessionMap = draftPages.get(session)
  if (!sessionMap) {
    sessionMap = new Map<string, PageDoc>()
    for (const [slug, page] of publishedPages) sessionMap.set(slug, structuredClone(page))
    draftPages.set(session, sessionMap)
  }
  return sessionMap
}

function getHistoryMap(store: Map<string, Map<string, PageDoc[]>>, session: string) {
  let bySession = store.get(session)
  if (!bySession) {
    bySession = new Map<string, PageDoc[]>()
    store.set(session, bySession)
  }
  return bySession
}

function getPage(session: string, slug: string) {
  const sessionDraft = getSessionDraft(session)
  return sessionDraft.get(slug) ?? null
}

function setPage(session: string, page: PageDoc) {
  const sessionDraft = getSessionDraft(session)
  sessionDraft.set(page.slug, page)
}

function pushUndo(session: string, slug: string, snapshot: PageDoc) {
  const undoMap = getHistoryMap(historyUndo, session)
  const list = undoMap.get(slug) ?? []
  list.push(structuredClone(snapshot))
  undoMap.set(slug, list)

  const redoMap = getHistoryMap(historyRedo, session)
  redoMap.set(slug, [])
}

function bumpVersion(session: string) {
  const current = versions.get(session) ?? 0
  const next = current + 1
  versions.set(session, next)
  return next
}

function pushRecentEdit(session: string, entry: { slug: string; summary: string; ops: Operation[] }) {
  const list = recentEdits.get(session) ?? []
  list.push({ ...entry, at: new Date().toISOString() })
  recentEdits.set(session, list.slice(-10))
}

function getRecentEdits(session: string, slug: string) {
  const list = recentEdits.get(session) ?? []
  return list
    .filter((item) => item.slug === slug)
    .slice(-3)
    .map((item) => ({
      at: item.at,
      summary: item.summary,
      ops: item.ops.map((op) => op.op)
    }))
}

function demoPlanFromMessage(message: string, slug: string, activeBlockId?: string, activeBlockType?: string): EditPlan {
  const lower = message.toLowerCase()
  const quoted = /"([^"]+)"/.exec(message)?.[1]

  if (lower.includes("make this shorter") && activeBlockId && activeBlockType === "Hero") {
    return {
      intent: "edit_plan",
      summary_for_user: "Shortened the selected hero copy.",
      change_log: ["Updated hero heading and subheading to be more concise."],
      ops: [
        {
          op: "update_props",
          pageSlug: slug,
          blockId: activeBlockId,
          patch: {
            heading: "Edit your site in seconds",
            subheading: "Describe a change and preview it instantly."
          }
        }
      ]
    }
  }

  if ((lower.includes("title") || lower.includes("heading")) && activeBlockId && activeBlockType === "Hero") {
    const headingText =
      quoted ??
      message
        .replace(/change/i, "")
        .replace(/hero/i, "")
        .replace(/title/i, "")
        .replace(/heading/i, "")
        .replace(/\bto\b/i, "")
        .trim()

    if (headingText) {
      return {
        intent: "edit_plan",
        summary_for_user: "Updated the hero title.",
        change_log: [`Changed hero heading to "${headingText}".`],
        ops: [
          {
            op: "update_props",
            pageSlug: slug,
            blockId: activeBlockId,
            patch: { heading: headingText }
          }
        ]
      }
    }
  }

  if (lower.includes("add testimonials")) {
    return {
      intent: "edit_plan",
      summary_for_user: "Added a testimonials section below the hero.",
      change_log: ["Inserted Testimonials block after the hero section."],
      ops: [
        {
          op: "add_block",
          pageSlug: slug,
          afterBlockId: "b_hero_home",
          block: {
            id: `b_testimonials_${Date.now()}`,
            type: "Testimonials",
            props: {
              title: "Loved by small teams",
              items: [
                { quote: "We launched in a day.", author: "Ana, Founder" },
                { quote: "Edits are now effortless.", author: "Chris, Marketer" }
              ]
            }
          }
        }
      ]
    }
  }

  if (lower.includes("remove") && activeBlockId) {
    return {
      intent: "edit_plan",
      summary_for_user: "Removed the selected block.",
      change_log: ["Deleted selected section from the page."],
      ops: [{ op: "remove_block", pageSlug: slug, blockId: activeBlockId }]
    }
  }

  return {
    intent: "needs_clarification",
    summary_for_user: "I need one clarification: what section should I change and what exactly should be updated?",
    change_log: [],
    ops: []
  }
}

function extractJsonObject(input: string) {
  const start = input.indexOf("{")
  const end = input.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) return null
  return input.slice(start, end + 1)
}

function normalizeOpName(op: unknown) {
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
    reorderblock: "move_block"
  }
  return aliases[key] ?? op
}

function normalizePlanCandidate(input: unknown, args?: { defaultSlug?: string; currentPage?: PageDoc; userMessage?: string }) {
  if (!input || typeof input !== "object") return input
  const root = input as Record<string, unknown>
  const ops = Array.isArray(root.ops) ? root.ops : Array.isArray(root.operations) ? root.operations : []
  const userMessage = (args?.userMessage ?? "").toLowerCase()

  const resolvePageSlug = (candidate: unknown) => {
    if (typeof candidate !== "string" || candidate.length === 0) return args?.defaultSlug
    if (candidate.startsWith("/")) return candidate

    if (args?.currentPage) {
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

  const normalizedOps = ops.map((item) => {
    if (!item || typeof item !== "object") return item
    const source = item as Record<string, unknown>
    const raw = { ...source }

    // Accept malformed one-key op objects like { "move_block": { ...fields } }.
    if (!raw.op && !raw.operation && !raw.action && !raw.kind) {
      for (const key of ["create_page", "add_block", "update_props", "remove_block", "move_block"] as const) {
        const value = source[key]
        if (value && typeof value === "object" && !Array.isArray(value)) {
          Object.assign(raw, value as Record<string, unknown>)
          raw.op = key
          break
        }
      }
    }

    raw.op = normalizeOpName(raw.op ?? raw.operation ?? raw.action ?? raw.kind)

    raw.pageSlug = resolvePageSlug(raw.pageSlug ?? raw.page_slug ?? raw.slug ?? raw.page ?? raw.path)
    if (!raw.blockId) {
      raw.blockId = raw.block_id ?? raw.targetBlockId ?? raw.target_block_id ?? raw.id
    }
    if (!raw.afterBlockId) {
      raw.afterBlockId =
        raw.after_block_id ?? raw.after ?? raw.insertAfterId ?? beforeToAfter(raw.beforeId ?? raw.insertBeforeId)
    }
    if (!raw.patch) {
      raw.patch = raw.props ?? raw.changes
    }
    if (!raw.block) {
      raw.block = raw.newBlock ?? raw.new_block
      if (!raw.block && raw.op === "add_block" && typeof raw.type === "string") {
        raw.block = {
          id: typeof raw.blockId === "string" && raw.blockId.length > 0 ? raw.blockId : `b_${raw.type.toLowerCase()}_${Date.now()}`,
          type: raw.type,
          props: raw.props ?? raw.patch ?? {}
        }
      }
    }
    if (raw.op === "add_block" && raw.block && typeof raw.block === "object" && !Array.isArray(raw.block)) {
      const block = raw.block as Record<string, unknown>
      if ((!block.id || typeof block.id !== "string") && typeof block.type === "string") {
        block.id = `b_${String(block.type).toLowerCase()}_${Date.now()}`
      }
      raw.block = block
    }

    // LLMs sometimes emit create_page when they actually mean add_block.
    if (raw.op === "create_page" && raw.block && !raw.page) {
      raw.op = "add_block"
      raw.pageSlug = resolvePageSlug(raw.pageSlug ?? raw.path ?? args?.defaultSlug)
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

    return raw
  })

  return { ...root, ops: normalizedOps }
}

function blockContractsSummary() {
  return {
    Hero: {
      allowedProps: ["heading", "subheading", "ctaText", "ctaHref"],
      required: ["heading", "subheading", "ctaText", "ctaHref"],
      notes: "Use heading for the main headline; never invent prop names."
    },
    FeatureGrid: {
      allowedProps: ["title", "features"],
      required: ["title", "features"],
      notes: "features must be a non-empty array of {title, description}."
    },
    Testimonials: {
      allowedProps: ["title", "items"],
      required: ["title", "items"],
      notes: "items must be a non-empty array of {quote, author}."
    },
    FAQAccordion: {
      allowedProps: ["title", "items"],
      required: ["title", "items"],
      notes: "items must be a non-empty array of {q, a}."
    },
    CTA: {
      allowedProps: ["title", "description", "ctaText", "ctaHref"],
      required: ["title", "description", "ctaText", "ctaHref"],
      notes: "Keep existing props unless the user asks to change them."
    },
    Card: {
      allowedProps: ["title", "description", "ctaText", "ctaHref"],
      required: ["title", "description", "ctaText", "ctaHref"],
      notes: "A standalone card with one CTA."
    },
    CardGrid: {
      allowedProps: ["title", "cards"],
      required: ["title", "cards"],
      notes: "cards must be a non-empty array of {title, description, ctaText, ctaHref}."
    }
  }
}

function readPathValue(root: unknown, path: string) {
  if (!path) return undefined
  const parts: Array<string | number> = []
  const regex = /([^[.\]]+)|\[(\d+)\]/g
  for (const match of path.matchAll(regex)) {
    if (match[1]) parts.push(match[1])
    if (match[2]) parts.push(Number(match[2]))
  }
  let current: unknown = root
  for (const part of parts) {
    if (typeof part === "number") {
      if (!Array.isArray(current)) return undefined
      current = current[part]
      continue
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function selectedBlockSnapshot(args: { currentPage: PageDoc; activeBlockId?: string; activeEditablePath?: string }) {
  if (!args.activeBlockId) return null
  const block = args.currentPage.blocks.find((item) => item.id === args.activeBlockId)
  if (!block) return null
  const editablePath = typeof args.activeEditablePath === "string" && args.activeEditablePath.length > 0 ? args.activeEditablePath : null
  return {
    id: block.id,
    type: block.type,
    props: block.props,
    selectedEditablePath: editablePath,
    selectedEditableValue: editablePath ? readPathValue(block.props, editablePath) ?? null : null
  }
}

const blockTypeEnum = z.enum(allowedBlockTypes as [BlockType, ...BlockType[]])
const intentSchema = z.object({
  action: z.enum(["add", "move", "update", "remove", "info", "clarify"]),
  target_block_ref: z.string().min(1).optional(),
  target_block_type: blockTypeEnum.optional(),
  new_block_type: blockTypeEnum.optional(),
  position: z.enum(["top", "bottom", "before", "after"]).optional(),
  anchor_block_ref: z.string().min(1).optional(),
  patch: z.record(z.unknown()).optional(),
  summary: z.string().min(1).optional(),
  assumption: z.string().min(1).optional()
})
type ParsedIntent = z.infer<typeof intentSchema>

function inferBlockTypeFromText(text: string): BlockType | undefined {
  const normalized = text.toLowerCase()
  if (normalized.includes("hero")) return "Hero"
  if (normalized.includes("featuregrid") || normalized.includes("feature grid") || normalized.includes("features")) return "FeatureGrid"
  if (normalized.includes("testimonial")) return "Testimonials"
  if (normalized.includes("faq")) return "FAQAccordion"
  if (normalized.includes("cta")) return "CTA"
  if (normalized.includes("cardgrid") || normalized.includes("card grid")) return "CardGrid"
  if (normalized.includes("card")) return "Card"
  return undefined
}

function inferAddedBlockTypeFromMessage(message: string): BlockType | undefined {
  const normalized = message.toLowerCase()
  const addMatch = normalized.match(/\b(add|create|insert)\b\s+(?:a|an)?\s*([a-z ]+)/)
  if (!addMatch?.[2]) return undefined
  const chunk = addMatch[2].trim()
  if (chunk.startsWith("card grid") || chunk.startsWith("cardgrid")) return "CardGrid"
  if (chunk.startsWith("card")) return "Card"
  if (chunk.startsWith("feature grid") || chunk.startsWith("featuregrid") || chunk.startsWith("features")) return "FeatureGrid"
  if (chunk.startsWith("testimonial")) return "Testimonials"
  if (chunk.startsWith("faq")) return "FAQAccordion"
  if (chunk.startsWith("cta")) return "CTA"
  if (chunk.startsWith("hero")) return "Hero"
  return undefined
}

function resolveBlockRef(args: {
  ref?: string
  currentPage: PageDoc
  activeBlockId?: string
  fallbackType?: BlockType
}): PageDoc["blocks"][number] | null {
  const { ref, currentPage, activeBlockId, fallbackType } = args
  const blocks = currentPage.blocks
  if (typeof ref === "string" && ref.length > 0) {
    const exact = blocks.find((b) => b.id === ref)
    if (exact) return exact
    const key = ref.toLowerCase().replace(/[\s_-]/g, "")
    if (["selected", "active", "current", "this"].includes(key) && activeBlockId) {
      const selected = blocks.find((b) => b.id === activeBlockId)
      if (selected) return selected
    }
    const byType = inferBlockTypeFromText(key)
    if (byType) {
      const found = blocks.find((b) => b.type === byType)
      if (found) return found
    }
    const contains = blocks.find((b) => b.id.toLowerCase().includes(key))
    if (contains) return contains
  }

  if (activeBlockId) {
    const selected = blocks.find((b) => b.id === activeBlockId)
    if (selected) return selected
  }
  if (fallbackType) {
    const found = blocks.find((b) => b.type === fallbackType)
    if (found) return found
  }
  return null
}

function ordinalToIndex(value: string) {
  const key = value.toLowerCase()
  if (key === "first" || key === "1st") return 0
  if (key === "second" || key === "2nd") return 1
  if (key === "third" || key === "3rd") return 2
  if (key === "fourth" || key === "4th") return 3
  if (key === "fifth" || key === "5th") return 4
  if (key === "last") return -1
  return null
}

function resolveByDescriptor(args: { descriptor: string; currentPage: PageDoc; activeBlockId?: string }) {
  const { descriptor, currentPage, activeBlockId } = args
  const normalized = descriptor.trim().toLowerCase()
  if (!normalized) return null
  if (["this", "this block", "this section", "selected", "selected block", "current block"].includes(normalized)) {
    if (!activeBlockId) return null
    return currentPage.blocks.find((b) => b.id === activeBlockId) ?? null
  }

  const exact = currentPage.blocks.find((b) => b.id.toLowerCase() === normalized)
  if (exact) return exact

  const type = inferBlockTypeFromText(normalized)
  if (!type) return null
  const typed = currentPage.blocks.filter((b) => b.type === type)
  if (typed.length === 0) return null

  const ord = normalized.match(/\b(first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)\b/)?.[1]
  const idx = ord ? ordinalToIndex(ord) : 0
  if (idx === null) return typed[0]
  if (idx === -1) return typed[typed.length - 1]
  return typed[idx] ?? typed[0]
}

function resolveReferencesFromMessage(args: { message: string; currentPage: PageDoc; activeBlockId?: string }) {
  const { message, currentPage, activeBlockId } = args
  const lower = message.toLowerCase()

  const mentioned = new Map<string, { id: string; type: BlockType; reason: string }>()
  const addMention = (block: PageDoc["blocks"][number] | null, reason: string) => {
    if (!block) return
    if (!mentioned.has(block.id)) mentioned.set(block.id, { id: block.id, type: block.type, reason })
  }

  if (activeBlockId) {
    const selected = currentPage.blocks.find((b) => b.id === activeBlockId) ?? null
    addMention(selected, "active_selection")
  }

  const descriptorMatches = lower.match(
    /\b(first|second|third|fourth|fifth|last)?\s*(hero|feature grid|features|testimonials?|faq|cta|card grid|card)s?\b/g
  )
  for (const match of descriptorMatches ?? []) {
    addMention(resolveByDescriptor({ descriptor: match, currentPage, activeBlockId }), "descriptor_match")
  }

  for (const block of currentPage.blocks) {
    if (lower.includes(block.id.toLowerCase())) addMention(block, "id_match")
  }

  const afterDescriptor = lower.match(/\b(?:after|below|under)\s+([a-z0-9_\-\s]+?)(?:[,.]|$)/)?.[1]?.trim()
  const beforeDescriptor = lower.match(/\b(?:before|above)\s+([a-z0-9_\-\s]+?)(?:[,.]|$)/)?.[1]?.trim()
  const primaryDescriptor = lower.match(/\b(?:update|change|edit|remove|delete|move)\s+([a-z0-9_\-\s]+?)(?:\b(?:to|into|with|after|before|above|below|under)\b|[,.]|$)/)?.[1]?.trim()

  const anchor = resolveByDescriptor({
    descriptor: afterDescriptor ?? beforeDescriptor ?? "",
    currentPage,
    activeBlockId
  })
  const target = resolveByDescriptor({
    descriptor: primaryDescriptor ?? "",
    currentPage,
    activeBlockId
  })
  addMention(anchor, "anchor_match")
  addMention(target, "target_match")

  return {
    target: target ? { id: target.id, type: target.type } : null,
    anchor: anchor ? { id: anchor.id, type: anchor.type } : null,
    mentionedBlocks: Array.from(mentioned.values()).slice(0, 8)
  }
}

function plannerContextPack(args: {
  session: string
  slug: string
  message: string
  currentPage: PageDoc
  activeBlockId?: string
  activeBlockType?: string
  activeEditablePath?: string
}) {
  const { session, slug, message, currentPage, activeBlockId, activeBlockType, activeEditablePath } = args
  const selectedIdx = activeBlockId ? currentPage.blocks.findIndex((b) => b.id === activeBlockId) : -1
  const neighbors =
    selectedIdx >= 0
      ? {
          previous: selectedIdx > 0 ? currentPage.blocks[selectedIdx - 1] : null,
          next: selectedIdx < currentPage.blocks.length - 1 ? currentPage.blocks[selectedIdx + 1] : null
        }
      : { previous: null, next: null }

  return {
    route: slug,
    blockCount: currentPage.blocks.length,
    selected: {
      blockId: activeBlockId ?? null,
      blockType: activeBlockType ?? null,
      editablePath: activeEditablePath ?? null,
      block: selectedBlockSnapshot({ currentPage, activeBlockId, activeEditablePath })
    },
    neighbors: {
      previous: neighbors.previous ? { id: neighbors.previous.id, type: neighbors.previous.type } : null,
      next: neighbors.next ? { id: neighbors.next.id, type: neighbors.next.type } : null
    },
    pageOutline: currentPage.blocks.map((b) => ({
      id: b.id,
      type: b.type,
      props: Object.keys(b.props as Record<string, unknown>)
    })),
    recentSuccessfulEdits: getRecentEdits(session, slug),
    resolvedReferences: resolveReferencesFromMessage({ message, currentPage, activeBlockId })
  }
}

function nextBlockId(type: BlockType, page: PageDoc) {
  const base = `b_${type.toLowerCase()}_${Date.now()}`
  if (!page.blocks.some((b) => b.id === base)) return base
  let i = 1
  while (page.blocks.some((b) => b.id === `${base}_${i}`)) i += 1
  return `${base}_${i}`
}

function defaultPropsForType(type: BlockType) {
  if (type === "Hero") {
    return {
      heading: "Build with confidence",
      subheading: "Make changes safely with instant preview.",
      ctaText: "Get Started",
      ctaHref: "/"
    }
  }
  if (type === "FeatureGrid") {
    return {
      title: "Key features",
      features: [
        { title: "Fast setup", description: "Launch quickly with guided defaults." },
        { title: "Safe edits", description: "Structured operations keep content valid." },
        { title: "Live updates", description: "Preview changes immediately." }
      ]
    }
  }
  if (type === "Testimonials") {
    return {
      title: "What customers say",
      items: [
        { quote: "We launched faster than expected.", author: "Alex" },
        { quote: "Editing is straightforward for the whole team.", author: "Jordan" }
      ]
    }
  }
  if (type === "FAQAccordion") {
    return {
      title: "Frequently asked questions",
      items: [
        { q: "How fast can we publish?", a: "Most teams ship updates in minutes." },
        { q: "Can we revise later?", a: "Yes, every block can be updated anytime." }
      ]
    }
  }
  if (type === "Card") {
    return {
      title: "Launch faster",
      description: "Go from idea to published changes in minutes.",
      ctaText: "Learn more",
      ctaHref: "/pricing"
    }
  }
  if (type === "CardGrid") {
    return {
      title: "Explore more",
      cards: [
        {
          title: "Fast setup",
          description: "Create and ship updates quickly.",
          ctaText: "Get started",
          ctaHref: "/"
        },
        {
          title: "Safe updates",
          description: "Schema-validated edits reduce breakage.",
          ctaText: "See how",
          ctaHref: "/pricing"
        },
        {
          title: "Team workflow",
          description: "Collaborate with clear, reviewable changes.",
          ctaText: "Read guide",
          ctaHref: "/"
        }
      ]
    }
  }
  return {
    title: "Ready to get started?",
    description: "Apply your next change in seconds.",
    ctaText: "Start now",
    ctaHref: "/"
  }
}

function coercePatchForBlock(block: PageDoc["blocks"][number], rawPatch: unknown) {
  if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) return {}
  const source =
    "props" in (rawPatch as Record<string, unknown>) &&
    (rawPatch as { props?: unknown }).props &&
    typeof (rawPatch as { props?: unknown }).props === "object" &&
    !Array.isArray((rawPatch as { props?: unknown }).props)
      ? ((rawPatch as { props: Record<string, unknown> }).props as Record<string, unknown>)
      : (rawPatch as Record<string, unknown>)

  const allowed = Object.keys(block.props as Record<string, unknown>)
  const normalizedToAllowed = new Map<string, string>()
  for (const key of allowed) normalizedToAllowed.set(key.toLowerCase(), key)

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (allowed.includes(key)) {
      out[key] = value
      continue
    }
    const mapped = normalizedToAllowed.get(key.toLowerCase())
    if (mapped) out[mapped] = value
  }
  return out
}

function patchObject(rawPatch: unknown) {
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

function parseIndexedPath(path: string) {
  const match = /^([a-zA-Z0-9_]+)\[(\d+)\](?:\.(.+))?$/.exec(path.trim())
  if (!match) return null
  return {
    listKey: match[1],
    index: Number(match[2]),
    leaf: match[3]
  }
}

function inferSimpleFieldPatchFromMessage(message: string) {
  const m = message
    .replace(/[“”]/g, '"')
    .match(/\b(?:change|set|update|edit)\b[\s\w]*?\b(title|description|cta\s*text|cta|link|href|quote|author|question|answer|q|a)\b[\s\w]*?\b(?:to|as)\b\s+"?([^"\n]+)"?/i)
  if (!m) return null
  const rawField = m[1].toLowerCase().replace(/\s+/g, "")
  const value = m[2]?.trim()
  if (!value) return null
  const map: Record<string, string> = {
    title: "title",
    description: "description",
    ctatext: "ctaText",
    cta: "ctaText",
    link: "ctaHref",
    href: "ctaHref",
    quote: "quote",
    author: "author",
    question: "q",
    answer: "a",
    q: "q",
    a: "a"
  }
  const key = map[rawField]
  if (!key) return null
  return { [key]: value } as Record<string, unknown>
}

function coercePatchForEditablePath(block: PageDoc["blocks"][number], editablePath: string | undefined, rawPatch: unknown, message: string) {
  if (!editablePath) return null
  const directKey = editablePath.trim()
  const blockProps = block.props as Record<string, unknown>
  if (directKey && Object.prototype.hasOwnProperty.call(blockProps, directKey)) {
    const source = patchObject(rawPatch) ?? inferSimpleFieldPatchFromMessage(message)
    let value: unknown

    if (source) {
      if (Object.prototype.hasOwnProperty.call(source, directKey)) value = source[directKey]
      else {
        const mapped = Object.keys(source).find((key) => key.toLowerCase() === directKey.toLowerCase())
        if (mapped) value = source[mapped]
      }
    }

    if (value === undefined) {
      const quoted = quotedText(message)
      if (quoted) value = quoted
    }
    if (value === undefined) return null

    return {
      patch: { [directKey]: value } as Record<string, unknown>,
      changedKeys: [directKey],
      rootKey: directKey
    }
  }

  const parsed = parseIndexedPath(editablePath)
  if (!parsed) return null

  const list = (block.props as Record<string, unknown>)[parsed.listKey]
  if (!Array.isArray(list) || parsed.index < 0 || parsed.index >= list.length) return null
  const rowRaw = list[parsed.index]
  if (!rowRaw || typeof rowRaw !== "object" || Array.isArray(rowRaw)) return null
  const row = rowRaw as Record<string, unknown>

  const source = patchObject(rawPatch) ?? inferSimpleFieldPatchFromMessage(message)
  if (!source) return null

  const allowedItemKeys = Object.keys(row)
  const normalizedToAllowed = new Map<string, string>()
  for (const key of allowedItemKeys) normalizedToAllowed.set(key.toLowerCase(), key)

  const itemPatch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    const normalized = key.trim()
    const fromPathPrefix = `${parsed.listKey}[${parsed.index}].`
    const childKey = normalized.startsWith(fromPathPrefix) ? normalized.slice(fromPathPrefix.length) : normalized
    const mapped = normalizedToAllowed.get(childKey.toLowerCase())
    if (mapped) itemPatch[mapped] = value
  }
  if (Object.keys(itemPatch).length === 0) return null

  const nextList = list.map((entry, idx) => {
    if (idx !== parsed.index || !entry || typeof entry !== "object" || Array.isArray(entry)) return entry
    return { ...(entry as Record<string, unknown>), ...itemPatch }
  })
  return {
    patch: { [parsed.listKey]: nextList } as Record<string, unknown>,
    changedKeys: Object.keys(itemPatch),
    rootKey: parsed.listKey
  }
}

function quotedText(message: string) {
  return /"([^"]+)"/.exec(message)?.[1]?.trim()
}

function buildListAppendPatch(block: PageDoc["blocks"][number], message: string) {
  const lower = message.toLowerCase()
  const quoted = quotedText(message)

  if (block.type === "FAQAccordion") {
    const existing = Array.isArray(block.props.items) ? (block.props.items as Array<Record<string, unknown>>) : []
    const q = quoted ?? (lower.includes("question") ? "New question" : "How does this work?")
    const next = [...existing, { q, a: "Add answer here." }]
    return { items: next }
  }

  if (block.type === "Testimonials") {
    const existing = Array.isArray(block.props.items) ? (block.props.items as Array<Record<string, unknown>>) : []
    const quote = quoted ?? "Great experience."
    const next = [...existing, { quote, author: "Customer" }]
    return { items: next }
  }

  if (block.type === "FeatureGrid") {
    const existing = Array.isArray(block.props.features) ? (block.props.features as Array<Record<string, unknown>>) : []
    const title = quoted ?? "New feature"
    const next = [...existing, { title, description: "Describe this feature." }]
    return { features: next }
  }

  if (block.type === "CardGrid") {
    const existing = Array.isArray(block.props.cards) ? (block.props.cards as Array<Record<string, unknown>>) : []
    const title = quoted ?? "New card"
    const next = [...existing, { title, description: "Add card description.", ctaText: "Learn more", ctaHref: "/" }]
    return { cards: next }
  }

  return null
}

function compileDeterministicPlan(args: {
  intent: ParsedIntent
  message: string
  slug: string
  currentPage: PageDoc
  activeBlockId?: string
  activeEditablePath?: string
}): EditPlan | null {
  const { intent, message, slug, currentPage, activeBlockId, activeEditablePath } = args
  const lowerMessage = message.toLowerCase()
  const assumptions: string[] = []
  if (intent.assumption) assumptions.push(intent.assumption)

  const selectedBlock = activeBlockId ? currentPage.blocks.find((b) => b.id === activeBlockId) ?? null : null
  const asksInlineAdd =
    lowerMessage.includes("add") &&
    (lowerMessage.includes("inside") ||
      lowerMessage.includes("within") ||
      lowerMessage.includes("current") ||
      lowerMessage.includes("this one") ||
      lowerMessage.includes("more"))

  if ((intent.action === "add" || intent.action === "clarify") && selectedBlock && asksInlineAdd) {
    const patch = buildListAppendPatch(selectedBlock, message)
    if (patch) {
      return {
        intent: "edit_plan",
        summary_for_user: `Updated ${selectedBlock.type}.`,
        change_log: [...assumptions, `Added one entry to ${selectedBlock.id}.`],
        ops: [{ op: "update_props", pageSlug: slug, blockId: selectedBlock.id, patch }]
      }
    }
  }

  if (intent.action === "info" || intent.action === "clarify") {
    return {
      intent: "needs_clarification",
      summary_for_user: intent.summary ?? "Please specify the section and exact change you want.",
      change_log: assumptions,
      ops: []
    }
  }

  if (intent.action === "remove") {
    const target = resolveBlockRef({
      ref: intent.target_block_ref,
      currentPage,
      activeBlockId,
      fallbackType: intent.target_block_type
    })
    if (!target) {
      return {
        intent: "needs_clarification",
        summary_for_user: "I need to know which block to remove.",
        change_log: assumptions,
        ops: []
      }
    }
    return {
      intent: "edit_plan",
      summary_for_user: intent.summary ?? `Removed ${target.type}.`,
      change_log: [...assumptions, `Removed block ${target.id}.`],
      ops: [{ op: "remove_block", pageSlug: slug, blockId: target.id }]
    }
  }

  if (intent.action === "update" || (intent.action === "clarify" && !!activeEditablePath)) {
    const target = resolveBlockRef({
      ref: intent.target_block_ref,
      currentPage,
      activeBlockId,
      fallbackType: intent.target_block_type
    })
    if (!target) {
      return {
        intent: "needs_clarification",
        summary_for_user: "I need to know which block to update.",
        change_log: assumptions,
        ops: []
      }
    }
    const childPatch = coercePatchForEditablePath(target, activeEditablePath, intent.patch, message)
    const patch = childPatch?.patch ?? coercePatchForBlock(target, intent.patch)
    if (Object.keys(patch).length === 0) {
      return {
        intent: "needs_clarification",
        summary_for_user: `Please specify at least one valid field for ${target.type}.`,
        change_log: [...assumptions, `Editable fields: ${Object.keys(target.props).join(", ")}`],
        ops: []
      }
    }
    return {
      intent: "edit_plan",
      summary_for_user: intent.summary ?? `Updated ${target.type}.`,
      change_log: [
        ...assumptions,
        childPatch
          ? `Updated ${target.id} ${activeEditablePath}: ${childPatch.changedKeys.join(", ")}`
          : `Updated ${target.id}: ${Object.keys(patch).join(", ")}`
      ],
      ops: [{ op: "update_props", pageSlug: slug, blockId: target.id, patch }]
    }
  }

  if (intent.action === "move") {
    const target = resolveBlockRef({
      ref: intent.target_block_ref,
      currentPage,
      activeBlockId,
      fallbackType: intent.target_block_type
    })
    if (!target) {
      return {
        intent: "needs_clarification",
        summary_for_user: "I need to know which block to move.",
        change_log: assumptions,
        ops: []
      }
    }

    let afterBlockId: string | undefined
    if (intent.position === "top") {
      afterBlockId = undefined
    } else if (intent.position === "bottom") {
      const tail = [...currentPage.blocks].reverse().find((b) => b.id !== target.id)
      afterBlockId = tail?.id
    } else if (intent.position === "after" || (intent.anchor_block_ref && !intent.position)) {
      const anchor = resolveBlockRef({ ref: intent.anchor_block_ref, currentPage })
      if (!anchor) {
        return {
          intent: "needs_clarification",
          summary_for_user: "I could not find the anchor block to move after.",
          change_log: assumptions,
          ops: []
        }
      }
      afterBlockId = anchor.id
    } else if (intent.position === "before") {
      const anchor = resolveBlockRef({ ref: intent.anchor_block_ref, currentPage })
      if (!anchor) {
        return {
          intent: "needs_clarification",
          summary_for_user: "I could not find the anchor block to move before.",
          change_log: assumptions,
          ops: []
        }
      }
      const idx = currentPage.blocks.findIndex((b) => b.id === anchor.id)
      if (idx > 0) afterBlockId = currentPage.blocks[idx - 1]?.id
      else afterBlockId = undefined
    } else if (message.toLowerCase().includes("bottom") || message.toLowerCase().includes("end")) {
      const tail = [...currentPage.blocks].reverse().find((b) => b.id !== target.id)
      afterBlockId = tail?.id
    } else {
      return {
        intent: "needs_clarification",
        summary_for_user: "Please specify where to move the block (top, bottom, before, after).",
        change_log: assumptions,
        ops: []
      }
    }

    return {
      intent: "edit_plan",
      summary_for_user: intent.summary ?? `Moved ${target.type}.`,
      change_log: [...assumptions, `Moved block ${target.id}.`],
      ops: [{ op: "move_block", pageSlug: slug, blockId: target.id, afterBlockId }]
    }
  }

  if (intent.action === "add") {
    const blockType =
      intent.new_block_type ??
      inferAddedBlockTypeFromMessage(message) ??
      intent.target_block_type ??
      inferBlockTypeFromText(intent.target_block_ref ?? "") ??
      inferBlockTypeFromText(message)
    if (!blockType) {
      return {
        intent: "needs_clarification",
        summary_for_user: `Please specify which block type to add (${allowedBlockTypes.join(", ")}).`,
        change_log: assumptions,
        ops: []
      }
    }

    const blockId = nextBlockId(blockType, currentPage)
    const baseProps = defaultPropsForType(blockType)
    const patch = coercePatchForBlock({ id: blockId, type: blockType, props: baseProps }, intent.patch)
    const props = { ...baseProps, ...patch }

    const addOp: Operation = {
      op: "add_block",
      pageSlug: slug,
      block: { id: blockId, type: blockType, props }
    }

    let extraMoveTop: Operation | null = null
    if (intent.position === "after" || (intent.anchor_block_ref && !intent.position)) {
      const anchor = resolveBlockRef({ ref: intent.anchor_block_ref, currentPage })
      if (!anchor) {
        return {
          intent: "needs_clarification",
          summary_for_user: "I could not find the anchor block to place this after.",
          change_log: assumptions,
          ops: []
        }
      }
      addOp.afterBlockId = anchor.id
    } else if (intent.position === "before") {
      const anchor = resolveBlockRef({ ref: intent.anchor_block_ref, currentPage })
      if (!anchor) {
        return {
          intent: "needs_clarification",
          summary_for_user: "I could not find the anchor block to place this before.",
          change_log: assumptions,
          ops: []
        }
      }
      const idx = currentPage.blocks.findIndex((b) => b.id === anchor.id)
      if (idx > 0) addOp.afterBlockId = currentPage.blocks[idx - 1]?.id
      else extraMoveTop = { op: "move_block", pageSlug: slug, blockId, afterBlockId: undefined }
    } else if (intent.position === "top") {
      extraMoveTop = { op: "move_block", pageSlug: slug, blockId, afterBlockId: undefined }
    } else if (intent.position === "bottom" || !intent.position) {
      // no-op: add without anchor appends to bottom in applyOpsAtomically
    }

    const ops: Operation[] = extraMoveTop ? [addOp, extraMoveTop] : [addOp]
    return {
      intent: "edit_plan",
      summary_for_user: intent.summary ?? `Added ${blockType}.`,
      change_log: [...assumptions, `Added ${blockType} block ${blockId}.`],
      ops
    }
  }

  return null
}

async function parseIntentWithOpenAI(args: {
  message: string
  slug: string
  currentPage: PageDoc
  activeBlockId?: string
  activeBlockType?: string
  activeEditablePath?: string
  model: string
}): Promise<ParsedIntent> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const system = [
    "You extract editing intent for a website editor.",
    "Return ONLY one JSON object. No markdown.",
    "Never return operations.",
    "Map request to action: add | move | update | remove | info | clarify.",
    "If the user asks what is editable/available, use action=info.",
    "Use explicit block references when present (id/type words like hero/faq/cta).",
    "For move/add with placement words, set position to top/bottom/before/after and anchor_block_ref when relevant.",
    "For update, include patch with only requested fields."
  ].join("\n")

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
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(user) }
    ]
  })

  const raw = completion.choices[0]?.message?.content ?? ""
  const jsonText = extractJsonObject(raw)
  if (!jsonText) throw new Error("Intent parser did not return JSON")
  const parsedRoot = JSON.parse(jsonText) as Record<string, unknown>
  const normalized = { ...parsedRoot } as Record<string, unknown>

  if (typeof normalized.action !== "string") {
    const intent = typeof normalized.intent === "string" ? normalized.intent : undefined
    if (intent === "needs_clarification") normalized.action = "clarify"
    if (intent === "info") normalized.action = "info"
  }

  if (
    typeof normalized.action !== "string" &&
    Array.isArray(normalized.ops) &&
    normalized.ops.length > 0 &&
    normalized.ops[0] &&
    typeof normalized.ops[0] === "object"
  ) {
    const first = normalized.ops[0] as Record<string, unknown>
    const op = normalizeOpName(first.op ?? first.operation ?? first.action ?? first.kind)
    if (op === "add_block") {
      normalized.action = "add"
      const block = first.block && typeof first.block === "object" ? (first.block as Record<string, unknown>) : null
      if (block && typeof block.type === "string") normalized.new_block_type = block.type
      if (typeof first.afterBlockId === "string") {
        normalized.position = "after"
        normalized.anchor_block_ref = first.afterBlockId
      } else {
        normalized.position = "bottom"
      }
      if (block && typeof block.props === "object" && block.props !== null && !Array.isArray(block.props)) {
        normalized.patch = block.props
      }
    } else if (op === "update_props") {
      normalized.action = "update"
      if (typeof first.blockId === "string") normalized.target_block_ref = first.blockId
      if (first.patch && typeof first.patch === "object" && !Array.isArray(first.patch)) normalized.patch = first.patch
    } else if (op === "remove_block") {
      normalized.action = "remove"
      if (typeof first.blockId === "string") normalized.target_block_ref = first.blockId
    } else if (op === "move_block") {
      normalized.action = "move"
      if (typeof first.blockId === "string") normalized.target_block_ref = first.blockId
      if (typeof first.afterBlockId === "string") {
        normalized.position = "after"
        normalized.anchor_block_ref = first.afterBlockId
      } else {
        normalized.position = "top"
      }
    }
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

async function generatePlanWithOpenAI(args: {
  message: string
  slug: string
  currentPage: PageDoc
  contextPack: ReturnType<typeof plannerContextPack>
  model: string
  feedback?: string
}): Promise<EditPlan> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  const system = [
    "You are an editing planner for a website builder.",
    "Return ONLY one JSON object matching EditPlan.",
    "Never output markdown or code fences.",
    "If request is ambiguous, return intent=needs_clarification and no ops.",
    "When reasonably clear, make a practical assumption and proceed.",
    "Include any important assumption briefly in summary_for_user and change_log.",
    "Use only these operation names exactly: create_page, add_block, update_props, remove_block, move_block.",
    "For update_props, set patch to changed props only; use existing prop keys for the target block type.",
    "Do not return no-op updates: patch must change at least one effective value.",
    "If contextPack.selected.editablePath is present, treat it as the primary target unless the user clearly requests a different target.",
    `Allowed block types: ${allowedBlockTypes.join(", ")}.`
  ].join("\n")

  const user = {
    request: args.message,
    slug: args.slug,
    contextPack: args.contextPack,
    blockContracts: blockContractsSummary(),
    knownBlockTypes: Object.keys(blockSchemas),
    editPlanShape: {
      intent: "edit_plan | needs_clarification",
      summary_for_user: "string",
      change_log: ["string"],
      ops: ["Operation[]"]
    },
    feedback: args.feedback ?? null
  }

  const completion = await client.chat.completions.create({
    model: args.model,
    ...openAIChatOptionsForModel(args.model),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(user) }
    ]
  })

  const raw = completion.choices[0]?.message?.content ?? ""
  const jsonText = extractJsonObject(raw)
  if (!jsonText) throw new Error("Model did not return JSON")

  const parsed = normalizePlanCandidate(JSON.parse(jsonText), {
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
    throw new Error(`${message}${path}. Parsed sample: ${sample}`)
  }

  return planResult.data
}

function toErrorDetail(error: unknown) {
  if (error instanceof Error) {
    const issueMatch = /"message"\s*:\s*"([^"]+)"/.exec(error.message)
    if (issueMatch?.[1]) return issueMatch[1]
    return error.message
  }
  if (error && typeof error === "object" && "issues" in error && Array.isArray((error as { issues?: unknown[] }).issues)) {
    const first = (error as { issues: Array<{ message?: unknown; path?: unknown[] }> }).issues[0]
    if (first) {
      const msg = typeof first.message === "string" ? first.message : "Invalid model output"
      const path = Array.isArray(first.path) && first.path.length > 0 ? ` at ${first.path.join(".")}` : ""
      return `${msg}${path}`
    }
  }
  if (typeof error === "string") return error
  return "Unknown planner error"
}

function applyOpsAtomically(session: string, ops: Operation[]) {
  const sessionDraft = getSessionDraft(session)
  const staged = new Map<string, PageDoc>()
  for (const [slug, page] of sessionDraft) staged.set(slug, structuredClone(page))
  const touchedSlugs = new Set<string>()

  for (const op of ops) {
    if (op.op === "create_page") {
      staged.set(op.page.slug, structuredClone(op.page))
      touchedSlugs.add(op.page.slug)
      continue
    }

    const page = staged.get(op.pageSlug)
    if (!page) throw new Error(`Page not found for slug ${op.pageSlug}`)

    if (op.op === "add_block") {
      const propCheck = validateBlockProps(op.block.type, op.block.props)
      if (!propCheck.success) throw new Error(`Invalid props for ${op.block.type}`)

      const alreadyExists = page.blocks.some((b) => b.id === op.block.id)
      if (alreadyExists) throw new Error(`Block id ${op.block.id} already exists`)

      if (!op.afterBlockId) {
        page.blocks.push({ ...op.block, props: propCheck.data })
      } else {
        const idx = page.blocks.findIndex((b) => b.id === op.afterBlockId)
        if (idx === -1) throw new Error(`afterBlockId ${op.afterBlockId} not found`)
        page.blocks.splice(idx + 1, 0, { ...op.block, props: propCheck.data })
      }
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "update_props") {
      const idx = page.blocks.findIndex((b) => b.id === op.blockId)
      if (idx === -1) throw new Error(`blockId ${op.blockId} not found`)
      const block = page.blocks[idx]
      const rawPatch = op.patch as Record<string, unknown>
      const patchCandidate =
        rawPatch && typeof rawPatch.props === "object" && rawPatch.props !== null && !Array.isArray(rawPatch.props)
          ? (rawPatch.props as Record<string, unknown>)
          : rawPatch

      const patchKeys = Object.keys(patchCandidate ?? {})
      const allowedPatchKeys = Object.keys(block.props as Record<string, unknown>)
      const invalidPatchKeys = patchKeys.filter((key) => !allowedPatchKeys.includes(key))
      if (invalidPatchKeys.length > 0) {
        throw new Error(
          `Patch for ${block.id} (${block.type}) used unknown props: ${invalidPatchKeys.join(", ")}. Allowed props: ${allowedPatchKeys.join(", ")}`
        )
      }

      const nextProps = { ...block.props, ...patchCandidate } as Record<string, unknown>

      const propCheck = validateBlockProps(block.type as BlockType, nextProps)
      if (!propCheck.success) throw new Error(`Invalid props for ${block.type}`)
      if (JSON.stringify(block.props) === JSON.stringify(propCheck.data)) {
        throw new Error(`No effective prop change for ${block.id}. Patch keys: ${patchKeys.join(", ") || "(none)"}`)
      }
      page.blocks[idx] = { ...block, props: propCheck.data }
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "remove_block") {
      const idx = page.blocks.findIndex((b) => b.id === op.blockId)
      if (idx === -1) throw new Error(`blockId ${op.blockId} not found`)
      page.blocks.splice(idx, 1)
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "move_block") {
      const idx = page.blocks.findIndex((b) => b.id === op.blockId)
      if (idx === -1) throw new Error(`blockId ${op.blockId} not found`)
      const [block] = page.blocks.splice(idx, 1)

      if (!op.afterBlockId) {
        page.blocks.unshift(block)
      } else {
        const afterIdx = page.blocks.findIndex((b) => b.id === op.afterBlockId)
        if (afterIdx === -1) throw new Error(`afterBlockId ${op.afterBlockId} not found`)
        page.blocks.splice(afterIdx + 1, 0, block)
      }

      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
    }
  }

  if (touchedSlugs.size === 0) {
    throw new Error("Edit plan produced no changes")
  }

  for (const slug of touchedSlugs) {
    const page = staged.get(slug)
    if (!page) continue
    setPage(session, { ...page, updatedAt: new Date().toISOString() })
  }
}

function pickFocusBlockId(ops: Operation[]) {
  const add = ops.find((op) => op.op === "add_block")
  if (add && add.op === "add_block") return add.block.id

  const move = ops.find((op) => op.op === "move_block")
  if (move && move.op === "move_block") return move.blockId

  const update = ops.find((op) => op.op === "update_props")
  if (update && update.op === "update_props") return update.blockId

  return undefined
}

async function runChatPipeline(body: ChatRequestBody): Promise<{ code: number; payload: ChatResult | { error: string } }> {
  if (!body.session || !body.slug || !body.message) {
    return { code: 400, payload: { error: "session, slug, and message are required" } }
  }

  const modelKey = body.modelKey && modelLookup[body.modelKey] ? body.modelKey : (process.env.OPENAI_MODEL_KEY as ModelKey | undefined) ?? "balanced"
  const modelUsed = modelLookup[modelKey]
  const plannerSource: "openai" | "demo" = process.env.OPENAI_API_KEY ? "openai" : "demo"

  const current = getPage(body.session, body.slug)
  if (!current) return { code: 404, payload: { error: "page not found" } }

  if (isInfoQuery(body.message)) {
    return infoResponse({ body, current, plannerSource, modelUsed, modelKey })
  }

  const contextPack = plannerContextPack({
    session: body.session,
    slug: body.slug,
    message: body.message,
    currentPage: current,
    activeBlockId: body.activeBlockId,
    activeBlockType: body.activeBlockType,
    activeEditablePath: body.activeEditablePath
  })

  const respondFromPlan = (plan: EditPlan, source: "openai" | "demo") => {
    if (plan.intent === "needs_clarification" && isBlockCatalogQuery(body.message)) {
      const forcedInfo = infoResponse({ body, current, plannerSource: source, modelUsed, modelKey })
      return { done: true as const, response: forcedInfo }
    }

    if (plan.intent === "needs_clarification") {
      return {
        done: true as const,
        response: {
          code: 200,
          payload: {
            status: "needs_clarification",
            summary: plan.summary_for_user,
            changes: plan.change_log,
            previewVersion: versions.get(body.session) ?? 0,
            plannerSource: source,
            modelUsed,
            modelKey
          } satisfies ChatResult
        }
      }
    }

    const previous = getPage(body.session, body.slug)
    if (!previous) {
      return {
        done: true as const,
        response: { code: 404, payload: { error: "page not found" } as { error: string } }
      }
    }

    try {
      applyOpsAtomically(body.session, plan.ops)
      pushUndo(body.session, body.slug, previous)
      pushRecentEdit(body.session, { slug: body.slug, summary: plan.summary_for_user, ops: plan.ops })
      const previewVersion = bumpVersion(body.session)
      const focusBlockId = pickFocusBlockId(plan.ops)
      return {
        done: true as const,
        response: {
          code: 200,
          payload: {
            status: "applied",
            summary: plan.summary_for_user,
            changes: plan.change_log,
            previewVersion,
            focusBlockId,
            plannerSource: source,
            modelUsed,
            modelKey
          } satisfies ChatResult
        }
      }
    } catch (error) {
      return { done: false as const, reason: toErrorDetail(error) }
    }
  }

  if (!process.env.OPENAI_API_KEY) {
    try {
      const demoPlan = demoPlanFromMessage(body.message, body.slug, body.activeBlockId, body.activeBlockType)
      const outcome = respondFromPlan(demoPlan, "demo")
      if (outcome.done) return outcome.response
      return {
        code: 400,
        payload: {
          status: "validation_error",
          summary: "I could not apply that change safely.",
          changes: [],
          validationErrors: [outcome.reason],
          previewVersion: versions.get(body.session) ?? 0,
          plannerSource: "demo",
          modelUsed,
          modelKey
        }
      }
    } catch (error) {
      return {
        code: 500,
        payload: {
          status: "error",
          summary: "Could not generate an edit plan.",
          changes: [toErrorDetail(error).slice(0, 300)],
          previewVersion: versions.get(body.session) ?? 0,
          plannerSource: "demo",
          modelUsed,
          modelKey
        }
      }
    }
  }

  const maxAttempts = 3
  const repairFeedback: string[] = []

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let plan: EditPlan
    try {
      plan = await generatePlanWithOpenAI({
        message: body.message,
        slug: body.slug,
        currentPage: current,
        contextPack,
        model: modelUsed,
        feedback: repairFeedback.length > 0 ? repairFeedback.join(" | ") : undefined
      })
    } catch (error) {
      const reason = toErrorDetail(error)
      repairFeedback.push(`Attempt ${attempt} planning failed: ${reason}`)
      if (attempt === maxAttempts) {
        return {
          code: 500,
          payload: {
            status: "error",
            summary: "Could not generate an edit plan.",
            changes: [reason.slice(0, 300)],
            validationErrors: repairFeedback.slice(-3),
            previewVersion: versions.get(body.session) ?? 0,
            plannerSource,
            modelUsed,
            modelKey
          }
        }
      }
      continue
    }

    const outcome = respondFromPlan(plan, "openai")
    if (outcome.done) return outcome.response
    repairFeedback.push(`Attempt ${attempt} apply failed: ${outcome.reason}`)
  }

  try {
    const fallbackPlan = demoPlanFromMessage(body.message, body.slug, body.activeBlockId, body.activeBlockType)
    const fallbackOutcome = respondFromPlan(fallbackPlan, "demo")
    if (fallbackOutcome.done) return fallbackOutcome.response
    repairFeedback.push(`Demo fallback apply failed: ${fallbackOutcome.reason}`)
  } catch (error) {
    repairFeedback.push(`Demo fallback planning failed: ${toErrorDetail(error)}`)
  }

  return {
    code: 400,
    payload: {
      status: "validation_error",
      summary: "I could not apply that change safely.",
      changes: [],
      validationErrors: repairFeedback.slice(-4),
      previewVersion: versions.get(body.session) ?? 0,
      plannerSource: "demo",
      modelUsed,
      modelKey
    }
  }
}

function sseWrite(reply: { raw: NodeJS.WritableStream }, payload: unknown) {
  reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`)
}

app.get("/published/pages", async (request, reply) => {
  const query = request.query as { slug?: string }
  if (!query.slug) return reply.code(400).send({ error: "slug is required" })

  const page = publishedPages.get(query.slug)
  if (!page) return reply.code(404).send({ error: "not found" })
  return structuredClone(page)
})

app.get("/draft/pages", async (request, reply) => {
  const query = request.query as { session?: string; slug?: string }
  if (!query.slug || !query.session) return reply.code(400).send({ error: "session and slug are required" })

  const page = getPage(query.session, query.slug)
  if (!page) return reply.code(404).send({ error: "not found" })

  return structuredClone(page)
})

app.post("/ops", async (request, reply) => {
  const body = request.body as ApplyOpsRequestBody
  const session = body.session ?? "dev"
  const parsedOps = z.array(operationSchema).safeParse(body.ops)
  if (!parsedOps.success) return reply.code(400).send({ error: "invalid ops payload" })
  if (parsedOps.data.length === 0) return reply.code(400).send({ error: "ops must not be empty" })

  const snapshots = new Map<string, PageDoc>()
  for (const op of parsedOps.data) {
    if (!("pageSlug" in op) || typeof op.pageSlug !== "string") continue
    if (snapshots.has(op.pageSlug)) continue
    const current = getPage(session, op.pageSlug)
    if (!current) return reply.code(404).send({ error: `page not found: ${op.pageSlug}` })
    snapshots.set(op.pageSlug, current)
  }

  try {
    applyOpsAtomically(session, parsedOps.data)
    for (const [slug, snapshot] of snapshots) pushUndo(session, slug, snapshot)
    const firstSlugOp = parsedOps.data.find((op) => "pageSlug" in op && typeof op.pageSlug === "string")
    if (firstSlugOp && "pageSlug" in firstSlugOp && typeof firstSlugOp.pageSlug === "string") {
      pushRecentEdit(session, { slug: firstSlugOp.pageSlug, summary: "Applied operations.", ops: parsedOps.data })
    }
    const previewVersion = bumpVersion(session)
    const focusBlockId = pickFocusBlockId(parsedOps.data)
    return {
      status: "applied",
      summary: "Applied operations.",
      changes: [],
      previewVersion,
      focusBlockId
    }
  } catch (error) {
    return reply.code(400).send({ error: toErrorDetail(error) })
  }
})

app.post("/chat", async (request, reply) => {
  const body = request.body as ChatRequestBody
  const result = await runChatPipeline(body)
  return reply.code(result.code).send(result.payload)
})

app.get("/chat/stream", async (request, reply) => {
  const query = request.query as ChatRequestBody
  const origin = request.headers.origin ?? "*"

  reply.raw.setHeader("Content-Type", "text/event-stream")
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform")
  reply.raw.setHeader("Connection", "keep-alive")
  reply.raw.setHeader("X-Accel-Buffering", "no")
  reply.raw.setHeader("Access-Control-Allow-Origin", origin)
  reply.raw.setHeader("Vary", "Origin")

  reply.raw.write("retry: 60000\n\n")
  sseWrite(reply, { type: "status", message: "Crafting your update..." })

  const result = await runChatPipeline(query)
  if (result.code >= 400) {
    sseWrite(reply, { type: "error", result: result.payload, code: result.code })
    reply.raw.end()
    return reply
  }

  sseWrite(reply, { type: "final", result: result.payload })
  reply.raw.end()
  return reply
})

app.post("/history/undo", async (request, reply) => {
  const body = request.body as { session?: string; slug?: string }
  if (!body.session || !body.slug) return reply.code(400).send({ error: "session and slug are required" })

  const undoMap = getHistoryMap(historyUndo, body.session)
  const redoMap = getHistoryMap(historyRedo, body.session)
  const list = undoMap.get(body.slug) ?? []
  if (list.length === 0) return reply.code(400).send({ error: "nothing to undo" })

  const current = getPage(body.session, body.slug)
  if (!current) return reply.code(404).send({ error: "page not found" })

  const prev = list.pop()
  undoMap.set(body.slug, list)
  if (!prev) return reply.code(400).send({ error: "nothing to undo" })

  const redoList = redoMap.get(body.slug) ?? []
  redoList.push(structuredClone(current))
  redoMap.set(body.slug, redoList)

  setPage(body.session, structuredClone(prev))
  const previewVersion = bumpVersion(body.session)
  return { status: "applied", previewVersion }
})

app.post("/history/redo", async (request, reply) => {
  const body = request.body as { session?: string; slug?: string }
  if (!body.session || !body.slug) return reply.code(400).send({ error: "session and slug are required" })

  const undoMap = getHistoryMap(historyUndo, body.session)
  const redoMap = getHistoryMap(historyRedo, body.session)
  const list = redoMap.get(body.slug) ?? []
  if (list.length === 0) return reply.code(400).send({ error: "nothing to redo" })

  const current = getPage(body.session, body.slug)
  if (!current) return reply.code(404).send({ error: "page not found" })

  const next = list.pop()
  redoMap.set(body.slug, list)
  if (!next) return reply.code(400).send({ error: "nothing to redo" })

  const undoList = undoMap.get(body.slug) ?? []
  undoList.push(structuredClone(current))
  undoMap.set(body.slug, undoList)

  setPage(body.session, structuredClone(next))
  const previewVersion = bumpVersion(body.session)
  return { status: "applied", previewVersion }
})

app.get("/health", async () => ({ ok: true }))
app.get("/status/planner", async () => ({
  plannerSource: process.env.OPENAI_API_KEY ? "openai" : "demo"
}))

const port = Number(process.env.PORT ?? 4200)
await app.listen({ port, host: "0.0.0.0" })
app.log.info(`Orchestrator listening on ${port}`)
