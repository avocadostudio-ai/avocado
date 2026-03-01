import {
  allowedBlockTypes,
  type BlockType,
  type Operation,
  type PageDoc
} from "@ai-site-editor/shared"
import {
  extractRouteMentions,
  firstRouteMention,
  normalizeRouteCandidate,
  parseCreatePageRequest
} from "./intent-helpers.js"

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

export function extractJsonObject(input: string) {
  const start = input.indexOf("{")
  const end = input.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) return null
  return input.slice(start, end + 1)
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
    deletepage: "remove_page"
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
  if (normalized.includes("featuregrid") || normalized.includes("feature grid") || normalized.includes("features")) return "FeatureGrid"
  if (normalized.includes("testimonial") || normalized.includes("social proof") || normalized.includes("review") || normalized.includes("quote")) return "Testimonials"
  if (normalized.includes("faq")) return "FAQAccordion"
  if (normalized.includes("cta")) return "CTA"
  if (normalized.includes("cardgrid") || normalized.includes("card grid") || normalized.includes("pricing")) return "CardGrid"
  if (normalized.includes("card")) return "Card"
  if (normalized.includes("richtext") || normalized.includes("rich text") || normalized.includes("rich-text") || normalized.includes("prose") || normalized.includes("text block") || normalized.includes("section") || normalized.includes("paragraph") || normalized.includes("copy")) return "RichText"
  if (normalized.includes("benefit") || normalized.includes("advantage")) return "FeatureGrid"
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
  if (type === "Hero") {
    return {
      heading: "Build with confidence",
      subheading: "Make changes safely with instant preview.",
      ctaText: "Get Started",
      ctaHref: "/",
      imageUrl: "/hero-generated.svg",
      imageAlt: "Abstract generated illustration"
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
  if (type === "RichText") {
    return {
      title: "",
      body: "Add your content here.\n\nUse a second paragraph to break up the text into readable sections."
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

// ---------------------------------------------------------------------------
// Plan candidate normalisation
// ---------------------------------------------------------------------------

export function normalizePlanCandidate(input: unknown, args?: { defaultSlug?: string; currentPage?: PageDoc; userMessage?: string }) {
  if (!input || typeof input !== "object") return input
  const root = input as Record<string, unknown>
  const ops = Array.isArray(root.ops) ? root.ops : Array.isArray(root.operations) ? root.operations : []
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
    if (!raw.listKey) {
      raw.listKey = raw.list_key ?? raw.arrayKey ?? raw.array_key ?? raw.collection ?? raw.itemsKey ?? raw.items_key
      if (!raw.listKey && isListOperation && pathLooksLikeListKey) raw.listKey = raw.path
      if (!raw.listKey && isListOperation && typeof raw.path === "string") {
        const keyCandidate = raw.path.trim().replace(/^\/+/, "")
        if (keyCandidate && !keyCandidate.includes("/")) raw.listKey = keyCandidate
      }
    }
    if (isListOperation && typeof raw.listKey === "string") raw.listKey = raw.listKey.replace(/^\/+/, "")
    if (isListOperation && typeof raw.listKey === "string" && typeof raw.pageSlug === "string" && raw.pageSlug === `/${raw.listKey}` && args?.defaultSlug) {
      raw.pageSlug = args.defaultSlug
    }
    if (typeof raw.index !== "number") {
      const indexRaw = raw.index ?? raw.itemIndex ?? raw.item_index ?? raw.fromIndex ?? raw.from_index
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
        const generatedId =
          typeof raw.blockId === "string" && raw.blockId.length > 0
            ? raw.blockId
            : args?.currentPage
              ? nextBlockId(normalizedType, args.currentPage)
              : `b_${String(normalizedType).toLowerCase()}_${Date.now()}`
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
      if ((!block.type || typeof block.type !== "string") && normalizedType) block.type = normalizedType
      if ((!block.props || typeof block.props !== "object" || Array.isArray(block.props)) && (raw.patch || raw.props || raw.changes)) {
        block.props = patchObject(raw.patch ?? raw.props ?? raw.changes) ?? {}
      }
      if ((!block.id || typeof block.id !== "string") && typeof block.type === "string") {
        block.id = `b_${String(block.type).toLowerCase()}_${Date.now()}`
      }
      raw.block = block
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
    if (
      raw.op === "create_page" &&
      !raw.page &&
      Array.isArray(raw.blocks) &&
      raw.blocks.length > 0
    ) {
      const pageSlug = resolvePageSlug(raw.pageSlug ?? raw.path ?? args?.defaultSlug) ?? args?.defaultSlug
      if (!pageSlug) return raw
      const out: Record<string, unknown>[] = []
      let previousId: string | undefined
      for (const candidate of raw.blocks) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue
        const block = { ...(candidate as Record<string, unknown>) }
        const typeRaw = typeof block.type === "string" ? block.type : ""
        const blockType =
          allowedBlockTypes.find((t) => t.toLowerCase() === typeRaw.toLowerCase()) ?? inferBlockTypeFromText(typeRaw)
        if (!blockType) continue
        if (typeof block.id !== "string" || block.id.length === 0) {
          block.id = args?.currentPage ? nextBlockId(blockType, args.currentPage) : `b_${blockType.toLowerCase()}_${Date.now()}`
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

      if (Array.isArray(pageInput.blocks)) {
        for (const candidate of pageInput.blocks) {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue
          const block = candidate as Record<string, unknown>
          const typeRaw = typeof block.type === "string" ? block.type : ""
          const blockType =
            allowedBlockTypes.find((t) => t.toLowerCase() === typeRaw.toLowerCase()) ?? inferBlockTypeFromText(typeRaw)
          if (!blockType) continue
          const id = typeof block.id === "string" && block.id.length > 0 ? block.id : `b_${blockType.toLowerCase()}_${Date.now()}`
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

  return { ...root, ops: sanitizedOps }
}
