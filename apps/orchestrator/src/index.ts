import Fastify from "fastify"
import cors from "@fastify/cors"
import OpenAI from "openai"
import {
  allowedBlockTypes,
  blockSchemas,
  demoPublishedPages,
  editPlanSchema,
  type BlockType,
  type EditPlan,
  type Operation,
  type PageDoc,
  validateBlockProps
} from "@ai-site-editor/shared"

const app = Fastify({ logger: true })
await app.register(cors, { origin: true })

const publishedPages = new Map<string, PageDoc>()
for (const page of demoPublishedPages()) publishedPages.set(page.slug, structuredClone(page))

const draftPages = new Map<string, Map<string, PageDoc>>()
const historyUndo = new Map<string, Map<string, PageDoc[]>>()
const historyRedo = new Map<string, Map<string, PageDoc[]>>()
const versions = new Map<string, number>()

const modelLookup = {
  fast: process.env.OPENAI_MODEL_FAST ?? "gpt-4o-mini",
  balanced: process.env.OPENAI_MODEL_BALANCED ?? "gpt-4o",
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
}

type ChatResult = {
  status: string
  summary: string
  changes: string[]
  validationErrors?: unknown
  previewVersion: number
  focusBlockId?: string
  plannerSource: "openai" | "demo"
  modelUsed: string
  modelKey: ModelKey
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

function normalizePlanCandidate(input: unknown, args?: { defaultSlug?: string; currentPage?: PageDoc }) {
  if (!input || typeof input !== "object") return input
  const root = input as Record<string, unknown>
  const ops = Array.isArray(root.ops) ? root.ops : Array.isArray(root.operations) ? root.operations : []

  const beforeToAfter = (beforeId: unknown) => {
    if (!args?.currentPage || typeof beforeId !== "string") return undefined
    const idx = args.currentPage.blocks.findIndex((block) => block.id === beforeId)
    if (idx <= 0) return undefined
    return args.currentPage.blocks[idx - 1]?.id
  }

  const normalizedOps = ops.map((item) => {
    if (!item || typeof item !== "object") return item
    const raw = { ...(item as Record<string, unknown>) }
    raw.op = normalizeOpName(raw.op)

    if (!raw.pageSlug) {
      raw.pageSlug = raw.page_slug ?? raw.slug ?? raw.page ?? args?.defaultSlug
    }
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
    }
  }
}

function selectedBlockSnapshot(args: { currentPage: PageDoc; activeBlockId?: string }) {
  if (!args.activeBlockId) return null
  const block = args.currentPage.blocks.find((item) => item.id === args.activeBlockId)
  if (!block) return null
  return {
    id: block.id,
    type: block.type,
    props: block.props
  }
}

async function generatePlanWithOpenAI(args: {
  message: string
  slug: string
  currentPage: PageDoc
  activeBlockId?: string
  activeBlockType?: string
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
    `Allowed block types: ${allowedBlockTypes.join(", ")}.`
  ].join("\n")

  const user = {
    request: args.message,
    slug: args.slug,
    activeBlockId: args.activeBlockId ?? null,
    activeBlockType: args.activeBlockType ?? null,
    selectedBlock: selectedBlockSnapshot({ currentPage: args.currentPage, activeBlockId: args.activeBlockId }),
    blockContracts: blockContractsSummary(),
    knownBlockTypes: Object.keys(blockSchemas),
    currentPage: args.currentPage,
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
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(user) }
    ]
  })

  const raw = completion.choices[0]?.message?.content ?? ""
  const jsonText = extractJsonObject(raw)
  if (!jsonText) throw new Error("Model did not return JSON")

  const parsed = normalizePlanCandidate(JSON.parse(jsonText), { defaultSlug: args.slug, currentPage: args.currentPage })
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
        page.blocks.unshift({ ...op.block, props: propCheck.data })
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

  if (!process.env.OPENAI_API_KEY) {
    let demoPlan: EditPlan
    try {
      demoPlan = demoPlanFromMessage(body.message, body.slug, body.activeBlockId, body.activeBlockType)
    } catch (error) {
      return {
        code: 500,
        payload: {
          status: "error",
          summary: "Could not generate an edit plan.",
          changes: [toErrorDetail(error).slice(0, 300)],
          previewVersion: versions.get(body.session) ?? 0,
          plannerSource,
          modelUsed,
          modelKey
        }
      }
    }

    if (demoPlan.intent === "needs_clarification") {
      return {
        code: 200,
        payload: {
          status: "needs_clarification",
          summary: demoPlan.summary_for_user,
          changes: demoPlan.change_log,
          previewVersion: versions.get(body.session) ?? 0,
          plannerSource,
          modelUsed,
          modelKey
        }
      }
    }

    const previous = getPage(body.session, body.slug)
    if (!previous) return { code: 404, payload: { error: "page not found" } }
    try {
      applyOpsAtomically(body.session, demoPlan.ops)
      pushUndo(body.session, body.slug, previous)
      const previewVersion = bumpVersion(body.session)
      const focusBlockId = pickFocusBlockId(demoPlan.ops)
      return {
        code: 200,
        payload: {
          status: "applied",
          summary: demoPlan.summary_for_user,
          changes: demoPlan.change_log,
          previewVersion,
          focusBlockId,
          plannerSource,
          modelUsed,
          modelKey
        }
      }
    } catch (error) {
      return {
        code: 400,
        payload: {
          status: "validation_error",
          summary: "I could not apply that change safely.",
          changes: [],
          validationErrors: [toErrorDetail(error)],
          previewVersion: versions.get(body.session) ?? 0,
          plannerSource,
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
        activeBlockId: body.activeBlockId,
        activeBlockType: body.activeBlockType,
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

    if (plan.intent === "needs_clarification") {
      return {
        code: 200,
        payload: {
          status: "needs_clarification",
          summary: plan.summary_for_user,
          changes: plan.change_log,
          previewVersion: versions.get(body.session) ?? 0,
          plannerSource,
          modelUsed,
          modelKey
        }
      }
    }

    const previous = getPage(body.session, body.slug)
    if (!previous) return { code: 404, payload: { error: "page not found" } }

    try {
      applyOpsAtomically(body.session, plan.ops)
      pushUndo(body.session, body.slug, previous)
      const previewVersion = bumpVersion(body.session)
      const focusBlockId = pickFocusBlockId(plan.ops)
      return {
        code: 200,
        payload: {
          status: "applied",
          summary: plan.summary_for_user,
          changes: plan.change_log,
          previewVersion,
          focusBlockId,
          plannerSource,
          modelUsed,
          modelKey
        }
      }
    } catch (error) {
      const reason = toErrorDetail(error)
      repairFeedback.push(`Attempt ${attempt} apply failed: ${reason}`)
      if (attempt === maxAttempts) {
        return {
          code: 400,
          payload: {
            status: "validation_error",
            summary: "I could not apply that change safely.",
            changes: [],
            validationErrors: repairFeedback.slice(-3),
            previewVersion: versions.get(body.session) ?? 0,
            plannerSource,
            modelUsed,
            modelKey
          }
        }
      }
    }
  }

  return {
    code: 500,
    payload: {
      status: "error",
      summary: "Could not generate an edit plan.",
      changes: [],
      previewVersion: versions.get(body.session) ?? 0,
      plannerSource,
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
  sseWrite(reply, { type: "status", message: "Planning edit..." })

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

const port = Number(process.env.PORT ?? 4200)
await app.listen({ port, host: "0.0.0.0" })
app.log.info(`Orchestrator listening on ${port}`)
