import { z } from "zod"
import {
  blockSchemas,
  type EditorComponentDefinition,
  type EditorComponentsManifest,
  type BlockType,
  type Operation,
  type PageDoc,
  validateBlockProps,
  validateByJsonSchemaLike
} from "@ai-site-editor/shared"
import { normalizeRouteCandidate } from "../nlp/intent-helpers.js"
import { pageIdFromSlug, pageTitleFromSlug } from "../nlp/plan-normalizer.js"
import { type GuardrailErrorCategory } from "../nlp/intent-detection.js"
import {
  getSessionDraft,
  orderSlugsHomeFirst,
  setPage,
  getPage
} from "../state/session-state.js"

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

export function toErrorDetail(error: unknown) {
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

export function isNoEffectiveChangeError(reason: string) {
  return /No effective prop change/i.test(reason)
}

export function classifyGuardrailError(reason: string): GuardrailErrorCategory {
  const lower = reason.toLowerCase()
  if (isNoEffectiveChangeError(reason)) return "no_effective_change"
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

export function buildDeterministicRepairFeedback(reason: string) {
  return `Repair strictly for schema compliance only: ${reason}. Do not change user intent or rewrite copy semantics.`
}

export type SkippedOperation = {
  index: number
  op: Operation["op"]
  reason: "empty_patch" | "unchanged_value"
  pageSlug?: string
  blockId?: string
}

export type ApplyOpsOptions = {
  componentsManifest?: EditorComponentsManifest
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
// Atomic operation application
// ---------------------------------------------------------------------------

export function applyOpsAtomically(session: string, ops: Operation[], options?: ApplyOpsOptions) {
  const nextUniqueBlockId = (blocks: Array<{ id: string }>, preferred: string) => {
    const base = preferred.trim()
    if (base.length > 0 && !blocks.some((b) => b.id === base)) return base
    const root = base.length > 0 ? base : "b_block_copy"
    let i = 1
    while (blocks.some((b) => b.id === `${root}_${i}`)) i += 1
    return `${root}_${i}`
  }

  const nextDuplicateSlug = (candidateMap: Map<string, PageDoc>, sourceSlug: string) => {
    const base = sourceSlug === "/" ? "/home-copy" : `${sourceSlug.replace(/\/+$/, "")}-copy`
    if (!candidateMap.has(base)) return base
    let i = 2
    while (candidateMap.has(`${base}-${i}`)) i += 1
    return `${base}-${i}`
  }

  const rebuildOrderWithInserted = (candidateMap: Map<string, PageDoc>, insertedSlug: string, afterPageSlug?: string) => {
    const ordered = orderSlugsHomeFirst(Array.from(candidateMap.keys()))
    const withoutInserted = ordered.filter((slug) => slug !== insertedSlug)
    let insertIndex = 0
    if (afterPageSlug) {
      if (afterPageSlug === "/") insertIndex = 1
      else {
        const anchorIdx = withoutInserted.findIndex((slug) => slug === afterPageSlug)
        if (anchorIdx === -1) throw new Error(`afterPageSlug ${afterPageSlug} not found`)
        insertIndex = anchorIdx + 1
      }
    }
    withoutInserted.splice(insertIndex, 0, insertedSlug)
    return withoutInserted
  }

  const listValueForOp = (block: PageDoc["blocks"][number], listKey: string) => {
    const candidate = (block.props as Record<string, unknown>)[listKey]
    if (!Array.isArray(candidate)) throw new Error(`List ${listKey} not found on ${block.id}`)
    return candidate
  }

  const describeValidationIssue = (error: z.ZodError) => {
    const first = error.issues[0]
    const path = first?.path?.length ? first.path.join(".") : ""
    const message = first?.message ?? "Invalid value"
    return path ? `${path}: ${message}` : message
  }

  const manifestByType = new Map<string, EditorComponentDefinition>()
  if (options?.componentsManifest) {
    for (const component of options.componentsManifest.components) {
      manifestByType.set(component.type, component)
    }
  }

  const validateWithManifestIfPresent = (blockType: string, nextProps: Record<string, unknown>) => {
    const manifestComponent = manifestByType.get(blockType)
    if (manifestComponent) {
      if (!validateByJsonSchemaLike(manifestComponent.propsSchema, nextProps)) {
        throw new Error(`Invalid props for ${blockType}: does not match component manifest schema`)
      }
      return nextProps
    }
    const propCheck = validateBlockProps(blockType as BlockType, nextProps)
    if (!propCheck.success) throw new Error(`Invalid props for ${blockType}: ${describeValidationIssue(propCheck.error)}`)
    return propCheck.data
  }

  const requireManifestComponent = (blockType: string, operationName: string) => {
    if (manifestByType.size === 0) return
    if (manifestByType.has(blockType)) return
    throw new Error(`Cannot ${operationName} for "${blockType}" because it is not declared in components manifest`)
  }

  const allowedPatchKeysFromManifest = (blockType: string, fallbackKeys: string[]) => {
    const manifestComponent = manifestByType.get(blockType)
    if (!manifestComponent) return fallbackKeys
    const schema = manifestComponent.propsSchema
    const schemaType = typeof schema.type === "string" ? schema.type : "object"
    if (schemaType !== "object") return fallbackKeys
    const properties = schema.properties
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return fallbackKeys
    return Object.keys(properties)
  }

  const withValidatedBlockProps = (block: PageDoc["blocks"][number], nextProps: Record<string, unknown>) => {
    return validateWithManifestIfPresent(block.type, nextProps)
  }

  const sessionDraft = getSessionDraft(session)
  const staged = new Map<string, PageDoc>()
  for (const [slug, page] of sessionDraft) staged.set(slug, structuredClone(page))
  const touchedSlugs = new Set<string>()
  const deletedSlugs = new Set<string>()
  const skippedOps: SkippedOperation[] = []
  let orderChanged = false

  for (let opIndex = 0; opIndex < ops.length; opIndex += 1) {
    const op = ops[opIndex]
    if (op.op === "create_page") {
      staged.set(op.page.slug, structuredClone(op.page))
      touchedSlugs.add(op.page.slug)
      continue
    }

    if (op.op === "duplicate_page") {
      const source = staged.get(op.pageSlug)
      if (!source) throw new Error(`Page not found for slug ${op.pageSlug}`)
      const nextSlug = normalizeRouteCandidate(op.newPageSlug) ?? nextDuplicateSlug(staged, op.pageSlug)
      if (staged.has(nextSlug)) throw new Error(`Target page slug already exists: ${nextSlug}`)
      op.newPageSlug = nextSlug
      const copy: PageDoc = {
        ...structuredClone(source),
        id: pageIdFromSlug(nextSlug),
        slug: nextSlug,
        title: typeof op.newTitle === "string" && op.newTitle.trim().length > 0 ? op.newTitle.trim() : `${source.title} Copy`,
        updatedAt: new Date().toISOString(),
        blocks: source.blocks.map((block) => ({ ...structuredClone(block), id: nextUniqueBlockId(source.blocks, `${block.id}_copy`) }))
      }
      staged.set(nextSlug, copy)
      touchedSlugs.add(nextSlug)

      const finalOrder = rebuildOrderWithInserted(staged, nextSlug, op.afterPageSlug ?? op.pageSlug)
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
      const nextSlug = normalizeRouteCandidate(op.newPageSlug)
      if (!nextSlug) throw new Error(`Invalid newPageSlug ${op.newPageSlug}`)
      if (op.pageSlug === nextSlug) throw new Error(`No effective page change for ${op.pageSlug}`)
      const page = staged.get(op.pageSlug)
      if (!page) throw new Error(`Page not found for slug ${op.pageSlug}`)
      if (staged.has(nextSlug)) throw new Error(`Target page slug already exists: ${nextSlug}`)
      staged.delete(op.pageSlug)
      deletedSlugs.add(op.pageSlug)
      staged.set(nextSlug, {
        ...page,
        id: pageIdFromSlug(nextSlug),
        slug: nextSlug,
        title: typeof op.newTitle === "string" && op.newTitle.trim().length > 0 ? op.newTitle.trim() : pageTitleFromSlug(nextSlug),
        updatedAt: new Date().toISOString()
      })
      touchedSlugs.add(nextSlug)

      // Keep route references consistent after a slug change.
      for (const [slug, candidate] of staged) {
        const rewritten = rewriteLinksToRenamedPage(candidate, op.pageSlug, nextSlug)
        if (!rewritten.changed) continue
        staged.set(slug, rewritten.page)
        touchedSlugs.add(slug)
      }
      continue
    }

    if (op.op === "remove_page") {
      if (op.pageSlug === "/") throw new Error("Cannot remove the home page (/)")
      const page = staged.get(op.pageSlug)
      if (!page) throw new Error(`Page not found for slug ${op.pageSlug}`)
      if (staged.size <= 1) throw new Error("Cannot remove the last remaining page")
      staged.delete(op.pageSlug)
      deletedSlugs.add(op.pageSlug)
      continue
    }

    if (op.op === "move_page") {
      if (op.pageSlug === "/") throw new Error("Home page (/) cannot be moved")
      if (!staged.has(op.pageSlug)) throw new Error(`Page not found for slug ${op.pageSlug}`)

      const ordered = orderSlugsHomeFirst(Array.from(staged.keys()))
      const movable = ordered.filter((route) => route !== "/")
      const currentIdx = movable.findIndex((route) => route === op.pageSlug)
      if (currentIdx === -1) throw new Error(`Page not found for slug ${op.pageSlug}`)
      const nextMovable = movable.filter((route) => route !== op.pageSlug)

      let insertIndex = 0
      if (op.afterPageSlug) {
        if (op.afterPageSlug === "/") insertIndex = 0
        else {
          const anchorIdx = nextMovable.findIndex((route) => route === op.afterPageSlug)
          if (anchorIdx === -1) throw new Error(`afterPageSlug ${op.afterPageSlug} not found`)
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
      if (!page) throw new Error(`Page not found for slug ${op.pageSlug}`)
      const patch = op.patch as Record<string, unknown>
      const patchKeys = Object.keys(patch).filter((k) => patch[k] !== undefined)
      if (patchKeys.length === 0) throw new Error(`No effective meta change for ${op.pageSlug}`)
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
      if (!changed) throw new Error(`No effective meta change for ${op.pageSlug}`)
      page.meta = Object.keys(next).length > 0 ? (next as PageDoc["meta"]) : undefined
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    const page = staged.get(op.pageSlug)
    if (!page) throw new Error(`Page not found for slug ${op.pageSlug}`)

    if (op.op === "add_block") {
      requireManifestComponent(op.block.type, "add block")
      const validatedProps = validateWithManifestIfPresent(op.block.type, op.block.props)

      const alreadyExists = page.blocks.some((b) => b.id === op.block.id)
      if (alreadyExists) throw new Error(`Block id ${op.block.id} already exists`)

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
        if (idx === -1) throw new Error(`afterBlockId ${op.afterBlockId} not found`)
        page.blocks.splice(idx + 1, 0, { ...op.block, props: validatedProps })
      }
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "duplicate_block") {
      const idx = page.blocks.findIndex((b) => b.id === op.blockId)
      if (idx === -1) throw new Error(`blockId ${op.blockId} not found`)
      const source = page.blocks[idx]
      requireManifestComponent(source.type, "duplicate block")
      const targetPageSlug = typeof op.toPageSlug === "string" && op.toPageSlug.length > 0 ? op.toPageSlug : op.pageSlug
      const targetPage = staged.get(targetPageSlug)
      if (!targetPage) throw new Error(`Target page not found for slug ${targetPageSlug}`)
      const nextId = nextUniqueBlockId(targetPage.blocks, typeof op.newBlockId === "string" ? op.newBlockId : `${source.id}_copy`)
      op.newBlockId = nextId
      const duplicate = { ...structuredClone(source), id: nextId }

      if (!op.afterBlockId) {
        if (targetPageSlug === op.pageSlug) page.blocks.splice(idx + 1, 0, duplicate)
        else targetPage.blocks.push(duplicate)
      } else {
        const anchorIdx = targetPage.blocks.findIndex((b) => b.id === op.afterBlockId)
        if (anchorIdx === -1) throw new Error(`afterBlockId ${op.afterBlockId} not found`)
        targetPage.blocks.splice(anchorIdx + 1, 0, duplicate)
      }
      targetPage.updatedAt = new Date().toISOString()
      touchedSlugs.add(targetPage.slug)
      continue
    }

    if (op.op === "add_item") {
      const blockIdx = page.blocks.findIndex((b) => b.id === op.blockId)
      if (blockIdx === -1) throw new Error(`blockId ${op.blockId} not found`)
      const block = page.blocks[blockIdx]
      requireManifestComponent(block.type, "add list items")
      const list = listValueForOp(block, op.listKey)
      const nextList = [...list]
      const insertIndex = typeof op.afterIndex === "number" ? op.afterIndex + 1 : nextList.length
      if (insertIndex < 0 || insertIndex > nextList.length) {
        throw new Error(`afterIndex ${op.afterIndex} is out of range for ${op.listKey}`)
      }
      nextList.splice(insertIndex, 0, structuredClone(op.item))
      const nextProps = { ...(block.props as Record<string, unknown>), [op.listKey]: nextList }
      page.blocks[blockIdx] = { ...block, props: withValidatedBlockProps(block, nextProps) }
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "update_item") {
      const blockIdx = page.blocks.findIndex((b) => b.id === op.blockId)
      if (blockIdx === -1) throw new Error(`blockId ${op.blockId} not found`)
      const block = page.blocks[blockIdx]
      requireManifestComponent(block.type, "update list items")
      const list = listValueForOp(block, op.listKey)
      if (op.index < 0 || op.index >= list.length) throw new Error(`index ${op.index} is out of range for ${op.listKey}`)
      const currentItem = list[op.index]
      if (!currentItem || typeof currentItem !== "object" || Array.isArray(currentItem)) {
        throw new Error(`List item ${op.listKey}[${op.index}] is not an object`)
      }
      const nextList = list.map((entry, idx) => {
        if (idx !== op.index) return entry
        return { ...(entry as Record<string, unknown>), ...(op.patch as Record<string, unknown>) }
      })
      const nextProps = { ...(block.props as Record<string, unknown>), [op.listKey]: nextList }
      page.blocks[blockIdx] = { ...block, props: withValidatedBlockProps(block, nextProps) }
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "remove_item") {
      const blockIdx = page.blocks.findIndex((b) => b.id === op.blockId)
      if (blockIdx === -1) throw new Error(`blockId ${op.blockId} not found`)
      const block = page.blocks[blockIdx]
      requireManifestComponent(block.type, "remove list items")
      const list = listValueForOp(block, op.listKey)
      if (op.index < 0 || op.index >= list.length) throw new Error(`index ${op.index} is out of range for ${op.listKey}`)
      const nextList = [...list]
      nextList.splice(op.index, 1)
      const nextProps = { ...(block.props as Record<string, unknown>), [op.listKey]: nextList }
      page.blocks[blockIdx] = { ...block, props: withValidatedBlockProps(block, nextProps) }
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "move_item") {
      const blockIdx = page.blocks.findIndex((b) => b.id === op.blockId)
      if (blockIdx === -1) throw new Error(`blockId ${op.blockId} not found`)
      const block = page.blocks[blockIdx]
      requireManifestComponent(block.type, "reorder list items")
      const list = listValueForOp(block, op.listKey)
      if (op.index < 0 || op.index >= list.length) throw new Error(`index ${op.index} is out of range for ${op.listKey}`)
      const nextList = [...list]
      const [item] = nextList.splice(op.index, 1)
      if (item === undefined) throw new Error(`index ${op.index} is out of range for ${op.listKey}`)
      const normalizedAfterIndex =
        typeof op.afterIndex === "number" && op.afterIndex > op.index ? op.afterIndex - 1 : op.afterIndex
      const insertIndex = typeof normalizedAfterIndex === "number" ? normalizedAfterIndex + 1 : 0
      if (insertIndex < 0 || insertIndex > nextList.length) {
        throw new Error(`afterIndex ${op.afterIndex} is out of range for ${op.listKey}`)
      }
      nextList.splice(insertIndex, 0, item)
      const nextProps = { ...(block.props as Record<string, unknown>), [op.listKey]: nextList }
      page.blocks[blockIdx] = { ...block, props: withValidatedBlockProps(block, nextProps) }
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "update_props") {
      const idx = page.blocks.findIndex((b) => b.id === op.blockId)
      if (idx === -1) throw new Error(`blockId ${op.blockId} not found`)
      const block = page.blocks[idx]
      requireManifestComponent(block.type, "update props")
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
      const allowedPatchKeys = allowedPatchKeysFromManifest(block.type, fallbackAllowedKeys)
      const invalidPatchKeys = patchKeys.filter((key) => !allowedPatchKeys.includes(key))
      if (invalidPatchKeys.length > 0) {
        throw new Error(
          `Patch for ${block.id} (${block.type}) used unknown props: ${invalidPatchKeys.join(", ")}. Allowed props: ${allowedPatchKeys.join(", ")}`
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

      const validatedProps = validateWithManifestIfPresent(block.type, nextProps)
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
      const idx = page.blocks.findIndex((b) => b.id === op.blockId)
      if (idx === -1) throw new Error(`blockId ${op.blockId} not found`)
      requireManifestComponent(page.blocks[idx].type, "remove block")
      page.blocks.splice(idx, 1)
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "move_block") {
      const idx = page.blocks.findIndex((b) => b.id === op.blockId)
      if (idx === -1) throw new Error(`blockId ${op.blockId} not found`)
      requireManifestComponent(page.blocks[idx].type, "move block")
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

  if (touchedSlugs.size === 0 && deletedSlugs.size === 0 && !orderChanged) {
    if (skippedOps.length > 0 && skippedOps.length === ops.length) {
      throw new Error("No effective prop change across plan. All update patches matched existing values.")
    }
    throw new Error("Edit plan produced no changes")
  }

  sessionDraft.clear()
  for (const [route, page] of staged) {
    setPage(session, page)
  }
  return {
    appliedCount: Math.max(0, ops.length - skippedOps.length),
    skippedOps
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
  const created = ops.find((op) => op.op === "create_page")
  if (created && created.op === "create_page") return created.page.slug
  const duplicate = ops.find((op) => op.op === "duplicate_page" && op.pageSlug === currentSlug)
  if (duplicate && duplicate.op === "duplicate_page") return duplicate.newPageSlug
  const rename = ops.find((op) => op.op === "rename_page" && op.pageSlug === currentSlug)
  if (rename && rename.op === "rename_page") return rename.newPageSlug
  const current = getPage(session, currentSlug)
  if (current) return undefined
  const draft = getSessionDraft(session)
  const first = orderSlugsHomeFirst(Array.from(draft.keys()))[0]
  return first
}
