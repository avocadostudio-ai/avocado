import { deriveFieldMetaFromSchema, type BlockDefinition, type BlockMeta, type FieldMeta, type PageDoc } from "@ai-site-editor/shared"
import type { PuckData } from "./types"

type FieldBuilderOptions = {
  mapImageField?: (field: FieldMeta) => Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Markdown ↔ HTML conversion for Puck richtext fields
// ---------------------------------------------------------------------------

function markdownToHtml(md: string): string {
  if (!md) return ""
  return md
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const headingMatch = /^(#{1,6})\s+(.+)$/.exec(block)
      if (headingMatch) {
        const level = headingMatch[1].length
        return `<h${level}>${inlineToHtml(headingMatch[2].trim())}</h${level}>`
      }
      const lines = block.split("\n").map((l) => l.trim()).filter(Boolean)
      const isString = (x: unknown): x is string => typeof x === "string" && x.length > 0
      const ulItems = lines.map((l) => /^\s*[-*+•]\s+(.+)$/.exec(l)?.[1]).filter(isString)
      if (ulItems.length === lines.length && ulItems.length > 0) {
        return `<ul>${ulItems.map((item) => `<li>${inlineToHtml(item)}</li>`).join("")}</ul>`
      }
      const olItems = lines.map((l) => /^\s*\d+[.)]\s+(.+)$/.exec(l)?.[1]).filter(isString)
      if (olItems.length === lines.length && olItems.length > 0) {
        return `<ol>${olItems.map((item) => `<li>${inlineToHtml(item)}</li>`).join("")}</ol>`
      }
      return `<p>${inlineToHtml(block.replace(/\n/g, " "))}</p>`
    })
    .join("")
}

function inlineToHtml(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>')
}

function htmlToMarkdown(html: string): string {
  if (!html) return ""
  return html
    .replace(/<h([1-6])[^>]*>(.*?)<\/h\1>/gi, (_m, level, content) => `${"#".repeat(Number(level))} ${stripTags(content)}\n\n`)
    .replace(/<ul[^>]*>(.*?)<\/ul>/gis, (_m, inner) => {
      const items = [...inner.matchAll(/<li[^>]*>(.*?)<\/li>/gis)].map((m) => `- ${stripTags(m[1])}`).join("\n")
      return items + "\n\n"
    })
    .replace(/<ol[^>]*>(.*?)<\/ol>/gis, (_m, inner) => {
      const items = [...inner.matchAll(/<li[^>]*>(.*?)<\/li>/gis)].map((m, i) => `${i + 1}. ${stripTags(m[1])}`).join("\n")
      return items + "\n\n"
    })
    .replace(/<p[^>]*>(.*?)<\/p>/gis, (_m, content) => `${stripInline(content)}\n\n`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function stripTags(html: string): string {
  return stripInline(html).replace(/<[^>]+>/g, "")
}

function stripInline(html: string): string {
  return html
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**")
    .replace(/<b[^>]*>(.*?)<\/b>/gi, "**$1**")
    .replace(/<em[^>]*>(.*?)<\/em>/gi, "*$1*")
    .replace(/<i[^>]*>(.*?)<\/i>/gi, "*$1*")
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)")
}

function mapScalarField(field: FieldMeta, options?: FieldBuilderOptions): Record<string, unknown> {
  if (field.kind === "number") {
    return { type: "number", label: field.label }
  }
  if (field.kind === "enum") {
    return { type: "select", label: field.label, options: field.options ?? [] }
  }
  if (field.kind === "headingLevel") {
    return { type: "select", label: field.label, options: ["h1", "h2", "h3", "h4", "h5", "h6"] }
  }
  if (field.kind === "richtext") {
    // Disable contentEditable — Puck wraps richtext values in React elements
    // when contentEditable is true, which breaks our block renderers that
    // expect markdown strings. Our preview bridge handles inline editing.
    return { type: "richtext", label: field.label, contentEditable: false }
  }
  if (field.kind === "image") {
    return options?.mapImageField?.(field) ?? { type: "text", label: field.label }
  }
  return { type: "text", label: field.label }
}

export function buildFields(
  def: BlockDefinition,
  meta: BlockMeta | undefined,
  options?: FieldBuilderOptions
): { fields: Record<string, unknown>; richtextKeys: Set<string> } {
  const derived = deriveFieldMetaFromSchema(def.propsSchema)
  const fields: Record<string, unknown> = {}
  const richtextKeys = new Set<string>()

  for (const [key, field] of Object.entries(derived.fields)) {
    const richer = meta?.fields[key]
    const effective = richer ?? field
    fields[key] = mapScalarField(effective, options)
    if (effective.kind === "richtext") richtextKeys.add(key)
  }

  for (const [listKey, listField] of Object.entries(derived.listFields)) {
    const arrayFields: Record<string, unknown> = {}
    for (const [itemKey, itemField] of Object.entries(listField.itemFields)) {
      const richer = meta?.listFields?.[listKey]?.itemFields[itemKey]
      arrayFields[itemKey] = mapScalarField(richer ?? itemField, options)
    }
    fields[listKey] = {
      type: "array",
      label: meta?.listFields?.[listKey]?.label ?? listField.label ?? listKey,
      arrayFields,
      getItemSummary: (item: Record<string, unknown>, index: number) => {
        const title = typeof item.title === "string" ? item.title.trim() : ""
        return title.length > 0 ? title : `Item ${index + 1}`
      }
    }
  }

  return { fields, richtextKeys }
}

/** Map of block type → set of richtext field keys. Populated by createPuckConfig. */
const richtextKeysByType = new Map<string, Set<string>>()

export function registerRichtextKeys(blockType: string, keys: Set<string>) {
  if (keys.size > 0) richtextKeysByType.set(blockType, keys)
}

function convertRichtextProps(
  blockType: string,
  props: Record<string, unknown>,
  converter: (s: string) => string
): Record<string, unknown> {
  const keys = richtextKeysByType.get(blockType)
  if (!keys) return props
  const converted = { ...props }
  for (const key of keys) {
    if (typeof converted[key] === "string") {
      converted[key] = converter(converted[key] as string)
    }
  }
  return converted
}

/** Convert richtext props from HTML (Puck) back to markdown (block storage). */
export function convertPropsHtmlToMarkdown(blockType: string, props: Record<string, unknown>): Record<string, unknown> {
  return convertRichtextProps(blockType, props, htmlToMarkdown)
}

export function pageToPuckData(page: PageDoc): PuckData {
  const content = page.blocks.map((block) => ({
    type: block.type,
    props: {
      id: block.id,
      ...convertRichtextProps(block.type, block.props as Record<string, unknown>, markdownToHtml),
      _blockId: block.id,
    }
  }))
  return {
    root: {},
    content,
  }
}

type PersistableBlock = {
  id: string
  type: string
  props: Record<string, unknown>
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeType(value: unknown): string {
  const fallback = "Block"
  const raw = asString(value)
  if (!raw) return fallback
  return raw.replace(/[^A-Za-z0-9_-]+/g, "") || fallback
}

function createGeneratedBlockId(type: string): string {
  const suffix = Math.random().toString(36).slice(2, 8)
  return `b_${type.toLowerCase()}_${Date.now().toString(36)}_${suffix}`
}

function normalizePersistableProps(input: Record<string, unknown>, blockType: string): Record<string, unknown> {
  const { id: _, _blockId: __, ...rest } = input
  return convertPropsHtmlToMarkdown(blockType, rest)
}

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) return String(value)
  if (typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableSerialize(v)}`)
  return `{${entries.join(",")}}`
}

function persistableBlocksFromPuckData(data: PuckData): PersistableBlock[] {
  return data.content
    .map((item) => {
      const raw = asObject(item)
      const props = asObject(raw.props)
      const id = asString(props.id) ?? asString(props._blockId)
      const type = normalizeType(raw.type)
      if (!id) return null
      return {
        id,
        type,
        props: normalizePersistableProps(props, type),
      }
    })
    .filter((item): item is PersistableBlock => Boolean(item))
}

export function ensurePuckBlockIds(data: PuckData): PuckData {
  let changed = false
  const nextContent = data.content.map((item) => {
    const raw = asObject(item)
    const itemRecord = (item && typeof item === "object")
      ? (item as Record<string, unknown>)
      : {}
    const type = normalizeType(raw.type)
    const props = asObject(raw.props)
    const existingId = asString(props.id) ?? asString(props._blockId)
    if (existingId && asString(props.id) && asString(props._blockId)) return item

    changed = true
    const id = existingId ?? createGeneratedBlockId(type)
    const nextProps = { ...props, id, _blockId: id }
    return {
      ...itemRecord,
      type,
      props: nextProps,
    } as PuckData["content"][number]
  })

  if (!changed) return data
  return {
    ...data,
    content: nextContent,
  }
}

export function buildOpsFromPuckDiff(slug: string, prevData: PuckData, nextData: PuckData): Array<Record<string, unknown>> {
  const prevBlocks = persistableBlocksFromPuckData(prevData)
  const nextBlocks = persistableBlocksFromPuckData(nextData)

  const prevById = new Map(prevBlocks.map((block) => [block.id, block]))
  const nextById = new Map(nextBlocks.map((block) => [block.id, block]))
  const typeChangedIds = new Set<string>()

  for (const [id, prev] of prevById) {
    const next = nextById.get(id)
    if (next && next.type !== prev.type) typeChangedIds.add(id)
  }

  const ops: Array<Record<string, unknown>> = []

  for (const prev of prevBlocks) {
    if (!nextById.has(prev.id) || typeChangedIds.has(prev.id)) {
      ops.push({ op: "remove_block", pageSlug: slug, blockId: prev.id })
    }
  }

  for (let index = 0; index < nextBlocks.length; index += 1) {
    const next = nextBlocks[index]
    if (prevById.has(next.id) && !typeChangedIds.has(next.id)) continue
    const prevInOrder = index > 0 ? nextBlocks[index - 1] : undefined
    const block = { id: next.id, type: next.type, props: next.props }
    if (prevInOrder?.id) {
      ops.push({ op: "add_block", pageSlug: slug, afterBlockId: prevInOrder.id, block })
    } else {
      ops.push({ op: "add_block", pageSlug: slug, block })
    }
  }

  for (const next of nextBlocks) {
    if (typeChangedIds.has(next.id)) continue
    const prev = prevById.get(next.id)
    if (!prev) continue
    if (stableSerialize(prev.props) === stableSerialize(next.props)) continue
    ops.push({
      op: "update_props",
      pageSlug: slug,
      blockId: next.id,
      patch: next.props,
    })
  }

  const prevExistingOrder = prevBlocks
    .filter((block) => nextById.has(block.id) && !typeChangedIds.has(block.id))
    .map((block) => block.id)
  const nextExistingOrder = nextBlocks
    .filter((block) => prevById.has(block.id) && !typeChangedIds.has(block.id))
    .map((block) => block.id)

  const working = [...prevExistingOrder]
  for (let index = 0; index < nextExistingOrder.length; index += 1) {
    const blockId = nextExistingOrder[index]
    const currentIndex = working.indexOf(blockId)
    if (currentIndex < 0 || currentIndex === index) continue
    const afterBlockId = index > 0 ? nextExistingOrder[index - 1] : undefined
    if (afterBlockId) {
      ops.push({ op: "move_block", pageSlug: slug, blockId, afterBlockId })
    } else {
      ops.push({ op: "move_block", pageSlug: slug, blockId })
    }
    working.splice(currentIndex, 1)
    working.splice(index, 0, blockId)
  }

  return ops
}

function cloneJsonSafe<T>(value: T): T {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value)
    } catch {
      // Fall through to JSON clone for non-cloneable values.
    }
  }
  return JSON.parse(JSON.stringify(value)) as T
}

function parseEditablePathTokens(path: string): Array<string | number> {
  if (!path) return []
  const normalized = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((token) => token.trim())
    .filter(Boolean)
  return normalized.map((token) => (/^\d+$/.test(token) ? Number(token) : token))
}

function setValueByEditablePath(root: Record<string, unknown>, editablePath: string, value: unknown): boolean {
  const tokens = parseEditablePathTokens(editablePath)
  if (tokens.length === 0) return false
  let cursor: unknown = root

  for (let i = 0; i < tokens.length - 1; i += 1) {
    const token = tokens[i]
    const nextToken = tokens[i + 1]
    if (typeof token === "number") {
      if (!Array.isArray(cursor)) return false
      const arr = cursor as unknown[]
      if (arr[token] === undefined || arr[token] === null || typeof arr[token] !== "object") {
        arr[token] = typeof nextToken === "number" ? [] : {}
      }
      cursor = arr[token]
      continue
    }

    if (!cursor || typeof cursor !== "object") return false
    const record = cursor as Record<string, unknown>
    const nextValue = record[token]
    if (nextValue === undefined || nextValue === null || typeof nextValue !== "object") {
      record[token] = typeof nextToken === "number" ? [] : {}
    }
    cursor = record[token]
  }

  const lastToken = tokens[tokens.length - 1]
  if (typeof lastToken === "number") {
    if (!Array.isArray(cursor)) return false
    const arr = cursor as unknown[]
    if (Object.is(arr[lastToken], value)) return false
    arr[lastToken] = value
    return true
  }

  if (!cursor || typeof cursor !== "object") return false
  const record = cursor as Record<string, unknown>
  if (Object.is(record[lastToken], value)) return false
  record[lastToken] = value
  return true
}

function findPuckBlockIndexById(data: PuckData, blockId: string): number {
  return data.content.findIndex((item) => {
    const props = (item as { props?: unknown }).props
    if (!props || typeof props !== "object") return false
    const typed = props as Record<string, unknown>
    return typed.id === blockId || typed._blockId === blockId
  })
}

export function applyLiveDraftToPuckData(
  data: PuckData,
  blockId: string,
  fields: Record<string, unknown>
): PuckData {
  const blockIndex = findPuckBlockIndexById(data, blockId)
  if (blockIndex < 0) return data
  const currentBlock = data.content[blockIndex] as { props?: unknown } & Record<string, unknown>
  if (!currentBlock.props || typeof currentBlock.props !== "object") return data

  const nextProps = cloneJsonSafe(currentBlock.props as Record<string, unknown>)
  let changed = false
  for (const [path, value] of Object.entries(fields)) {
    if (!path) continue
    const applied = setValueByEditablePath(nextProps, path, value)
    if (applied) changed = true
  }
  if (!changed) return data

  const nextContent = [...data.content]
  nextContent[blockIndex] = {
    ...(currentBlock as Record<string, unknown>),
    props: nextProps,
  } as PuckData["content"][number]

  return {
    ...data,
    content: nextContent,
  }
}
