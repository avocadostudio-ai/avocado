import type { PageDoc } from "@ai-site-editor/shared"
import { getSessionDraft, getRecentEdits, orderSlugsHomeFirst } from "../state/session-state.js"
import { resolveReferencesFromMessage } from "./deterministic-planner-refs.js"

// ---------------------------------------------------------------------------
// Path traversal
// ---------------------------------------------------------------------------

export function readPathValue(root: unknown, path: string) {
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

// ---------------------------------------------------------------------------
// Image URL helpers
// ---------------------------------------------------------------------------

/**
 * Given block props and an editablePath targeting an alt-text field,
 * resolve the companion image URL for vision-powered alt text generation.
 *
 * Examples:
 *  - "imageAlt"           → props.imageUrl
 *  - "cards[2].imageAlt"  → props.cards[2].imageUrl
 *  - "items[0].image.alt" → props.items[0].image.src
 */
export function resolveImageUrlForAltField(blockProps: Record<string, unknown>, editablePath: string): string | undefined {
  if (!editablePath) return undefined
  // Only trigger for paths ending in an alt-text field
  if (!/(^|[.])imageAlt$/.test(editablePath) && !/(^|[.])alt$/.test(editablePath)) return undefined

  let companionPath: string
  if (editablePath.endsWith(".alt")) {
    // e.g. "items[0].image.alt" → "items[0].image.src"
    companionPath = editablePath.replace(/\.alt$/, ".src")
  } else {
    // e.g. "imageAlt" or "cards[2].imageAlt" → "imageUrl" or "cards[2].imageUrl"
    companionPath = editablePath.replace(/imageAlt$/, "imageUrl")
  }

  const value = readPathValue(blockProps, companionPath)
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]"
  } catch {
    return false
  }
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
}

/**
 * Fetch an image URL and return base64 + media type.
 * For localhost URLs the AI APIs can't reach, we fetch locally.
 * For remote URLs, returns null so the caller can use the URL directly.
 */
export async function fetchImageAsBase64(url: string): Promise<{ base64: string; mediaType: string } | null> {
  if (!isLocalUrl(url)) return null
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const buffer = Buffer.from(await res.arrayBuffer())
    const contentType = res.headers.get("content-type")
    let mediaType = contentType?.split(";")[0]?.trim() ?? ""
    if (!mediaType || mediaType === "application/octet-stream") {
      const ext = url.match(/(\.[a-z]+)(?:\?|$)/i)?.[1]?.toLowerCase() ?? ""
      mediaType = MIME_BY_EXT[ext] ?? "image/jpeg"
    }
    return { base64: buffer.toString("base64"), mediaType }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Block snapshot
// ---------------------------------------------------------------------------

export function selectedBlockSnapshot(args: { currentPage: PageDoc; activeBlockId?: string; activeEditablePath?: string }) {
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

// ---------------------------------------------------------------------------
// Array prop metadata
// ---------------------------------------------------------------------------

export function arrayPropLengths(props: Record<string, unknown>) {
  const out: Record<string, { length: number; labels?: string[] }> = {}
  for (const [key, value] of Object.entries(props)) {
    if (!Array.isArray(value)) continue
    const labels: string[] = []
    for (const item of value) {
      if (typeof item === "object" && item !== null) {
        const labelValue =
          (item as Record<string, unknown>).label ??
          (item as Record<string, unknown>).title ??
          (item as Record<string, unknown>).heading ??
          (item as Record<string, unknown>).question ??
          (item as Record<string, unknown>).name
        if (typeof labelValue === "string") labels.push(labelValue)
      }
    }
    out[key] = labels.length > 0 ? { length: value.length, labels } : { length: value.length }
  }
  return out
}

// ---------------------------------------------------------------------------
// Page intent summary
// ---------------------------------------------------------------------------

export function pageIntentSummary(args: { slug: string; currentPage: PageDoc }) {
  const { slug, currentPage } = args
  const typeCounts = new Map<string, number>()
  for (const block of currentPage.blocks) {
    typeCounts.set(block.type, (typeCounts.get(block.type) ?? 0) + 1)
  }
  const composition = Array.from(typeCounts.entries())
    .map(([type, count]) => (count > 1 ? `${type} x${count}` : type))
    .join(", ")
  const hero = currentPage.blocks.find((b) => b.type === "Hero")
  const heroHeading = hero && typeof (hero.props as Record<string, unknown>).heading === "string" ? (hero.props as { heading: string }).heading : ""
  const routeLabel = slug === "/" ? "Home page" : `Page ${slug}`
  const headingPart = heroHeading ? ` Hero message: "${heroHeading}".` : ""
  return `${routeLabel} with ${currentPage.blocks.length} blocks (${composition}).${headingPart}`
}

// ---------------------------------------------------------------------------
// Planner context pack
// ---------------------------------------------------------------------------

export function plannerContextPack(args: {
  session: string
  slug: string
  message: string
  currentPage: PageDoc
  activeBlockId?: string
  activeBlockType?: string
  activeEditablePath?: string
  includeFullProps?: boolean
}) {
  const { session, slug, message, currentPage, activeBlockId, activeBlockType, activeEditablePath } = args
  const pageRoutes = orderSlugsHomeFirst(Array.from(getSessionDraft(session).keys()))
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
    pageRoutes,
    blockCount: currentPage.blocks.length,
    selected: {
      blockId: activeBlockId ?? null,
      blockType: activeBlockType ?? null,
      editablePath: activeEditablePath ?? null,
      block: selectedBlockSnapshot({ currentPage, activeBlockId, activeEditablePath }),
      imageUrlForVision: activeBlockId && activeEditablePath
        ? resolveImageUrlForAltField(
            (currentPage.blocks.find((b) => b.id === activeBlockId)?.props ?? {}) as Record<string, unknown>,
            activeEditablePath
          ) ?? null
        : null
    },
    neighbors: {
      previous: neighbors.previous ? { id: neighbors.previous.id, type: neighbors.previous.type } : null,
      next: neighbors.next ? { id: neighbors.next.id, type: neighbors.next.type } : null
    },
    pageOutline: currentPage.blocks.map((b) => {
      const bProps = b.props as Record<string, unknown>
      const arrProps = arrayPropLengths(bProps)
      // Selected block: send full props for precise editing context
      if (b.id === activeBlockId || args.includeFullProps) {
        return { id: b.id, type: b.type, props: structuredClone(bProps), arrayProps: arrProps }
      }
      // Other blocks: type + array metadata only — keeps token count low.
      // Full scalar props are available via includeFullProps for content queries/translations.
      return { id: b.id, type: b.type, props: {}, arrayProps: arrProps }
    }),
    pageMeta: currentPage.meta ?? null,
    pageIntent: pageIntentSummary({ slug, currentPage }),
    recentSuccessfulEdits: getRecentEdits(session, slug),
    resolvedReferences: resolveReferencesFromMessage({ message, currentPage, activeBlockId })
  }
}
