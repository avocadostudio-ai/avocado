/**
 * Computes a structured diff between the session's draft pages and the
 * currently-published pages. Pure function — no I/O. Shared with the editor
 * via the PublishDiff type in @avocadostudio-ai/shared.
 */

import type { PageDoc, BlockInstance, SiteConfig } from "@avocadostudio-ai/shared"
import type {
  PublishDiff,
  PageDiff,
  BlockDiff,
  FieldDiff,
  FieldDiffKind,
  SiteConfigDiff,
  SiteConfigFieldDiff,
} from "@avocadostudio-ai/shared"

const IMAGE_PATH_HINT = /(^|\.)(imageUrl|image|src|poster|logo|avatar|thumbnail)$/i

function inferKind(path: string, before: unknown, after: unknown): FieldDiffKind {
  if (IMAGE_PATH_HINT.test(path)) return "image"
  if (typeof before === "string" || typeof after === "string") return "text"
  return "other"
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

function arraysShallowEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
  return true
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) && Array.isArray(b)) return arraysShallowEqual(a, b)
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    for (const key of ka) if (!deepEqual(a[key], b[key])) return false
    return true
  }
  return false
}

/**
 * Walks two prop trees and emits one FieldDiff per leaf that changed.
 * - Plain objects: recurse key-by-key (union of keys).
 * - Arrays of plain objects: recurse element-by-element by index.
 * - Arrays of primitives or mixed: treated as single leaves.
 */
function diffProps(
  before: unknown,
  after: unknown,
  path: string,
  out: FieldDiff[],
): void {
  if (deepEqual(before, after)) return

  const bothObjects = isPlainObject(before) && isPlainObject(after)
  if (bothObjects) {
    const keys = new Set<string>([...Object.keys(before as Record<string, unknown>), ...Object.keys(after as Record<string, unknown>)])
    for (const key of keys) {
      const childPath = path ? `${path}.${key}` : key
      diffProps((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key], childPath, out)
    }
    return
  }

  const bothArrays = Array.isArray(before) && Array.isArray(after)
  if (bothArrays) {
    const allObjects =
      (before as unknown[]).every((x) => isPlainObject(x)) &&
      (after as unknown[]).every((x) => isPlainObject(x))
    if (allObjects) {
      const maxLen = Math.max((before as unknown[]).length, (after as unknown[]).length)
      for (let i = 0; i < maxLen; i++) {
        const childPath = `${path}[${i}]`
        diffProps((before as unknown[])[i], (after as unknown[])[i], childPath, out)
      }
      return
    }
    // Arrays of primitives / mixed: emit as a single leaf.
    out.push({ path, before, after, kind: inferKind(path, before, after) })
    return
  }

  // Leaf — before !== after by deep equality check above.
  out.push({ path, before, after, kind: inferKind(path, before, after) })
}

function diffBlocks(
  beforeBlocks: BlockInstance[],
  afterBlocks: BlockInstance[],
): BlockDiff[] {
  const beforeById = new Map<string, { block: BlockInstance; index: number }>()
  beforeBlocks.forEach((b, i) => beforeById.set(b.id, { block: b, index: i }))
  const afterById = new Map<string, { block: BlockInstance; index: number }>()
  afterBlocks.forEach((b, i) => afterById.set(b.id, { block: b, index: i }))

  const out: BlockDiff[] = []
  const seen = new Set<string>()

  // Iterate in draft (after) order so the diff reads top-to-bottom like the page.
  for (const [id, { block, index }] of afterById) {
    seen.add(id)
    const prev = beforeById.get(id)
    if (!prev) {
      out.push({ blockId: id, type: block.type, status: "added", positionAfter: index })
      continue
    }
    const fieldDiffs: FieldDiff[] = []
    // Type change: treat as modified with a synthetic "type" diff so the UI can show it.
    if (prev.block.type !== block.type) {
      fieldDiffs.push({ path: "type", before: prev.block.type, after: block.type, kind: "other" })
    }
    diffProps(prev.block.props, block.props, "", fieldDiffs)

    const moved = prev.index !== index
    const changed = fieldDiffs.length > 0
    if (!moved && !changed) {
      out.push({ blockId: id, type: block.type, status: "unchanged", positionBefore: prev.index, positionAfter: index })
      continue
    }
    out.push({
      blockId: id,
      type: block.type,
      status: changed ? "modified" : "moved",
      fieldDiffs: changed ? fieldDiffs : undefined,
      positionBefore: prev.index,
      positionAfter: index,
    })
  }

  // Removed blocks — in published but not in draft.
  for (const [id, { block, index }] of beforeById) {
    if (seen.has(id)) continue
    out.push({ blockId: id, type: block.type, status: "removed", positionBefore: index })
  }

  return out
}

function diffPage(before: PageDoc | undefined, after: PageDoc | undefined): PageDiff | null {
  if (!before && !after) return null
  if (!before && after) {
    return {
      slug: after.slug,
      status: "added",
      titleAfter: after.title,
      blockDiffs: after.blocks.map((b, i) => ({
        blockId: b.id,
        type: b.type,
        status: "added",
        positionAfter: i,
      })),
    }
  }
  if (before && !after) {
    return {
      slug: before.slug,
      status: "removed",
      titleBefore: before.title,
      blockDiffs: before.blocks.map((b, i) => ({
        blockId: b.id,
        type: b.type,
        status: "removed",
        positionBefore: i,
      })),
    }
  }
  const b = before as PageDoc
  const a = after as PageDoc
  const blockDiffs = diffBlocks(b.blocks, a.blocks)
  const titleChanged = b.title !== a.title
  const hasStructuralChange = blockDiffs.some((bd) => bd.status !== "unchanged")
  return {
    slug: a.slug,
    status: titleChanged || hasStructuralChange ? "modified" : "unchanged",
    titleBefore: titleChanged ? b.title : undefined,
    titleAfter: titleChanged ? a.title : undefined,
    blockDiffs,
  }
}

// Keys of SiteConfig that drive the rendered SiteHeader chrome. We diff
// only these to keep the publish UI focused on user-visible header changes;
// `purpose`, `tone`, `constraints`, `themeOverrides` are AI/style context
// that lives outside the published chrome (and shouldn't trigger a publish CTA).
const SITE_HEADER_KEYS: readonly (keyof SiteConfig)[] = ["name", "logo", "navLabels", "navGroups"]

function pickHeaderFields(config: SiteConfig | undefined | null): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!config) return out
  for (const key of SITE_HEADER_KEYS) {
    const value = (config as Record<string, unknown>)[key]
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

function emitMapDiff(
  rootKey: "navLabels" | "navGroups",
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  out: SiteConfigFieldDiff[],
): void {
  if (deepEqual(before, after)) return
  const keys = new Set<string>([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  for (const key of keys) {
    const b = before?.[key]
    const a = after?.[key]
    if (deepEqual(b, a)) continue
    out.push({
      path: `${rootKey}["${key}"]`,
      before: b,
      after: a,
      kind: "other",
    })
  }
}

function diffSiteConfig(
  before: SiteConfig | undefined | null,
  after: SiteConfig | undefined | null,
): SiteConfigDiff {
  const beforeHeader = pickHeaderFields(before)
  const afterHeader = pickHeaderFields(after)
  const beforeEmpty = Object.keys(beforeHeader).length === 0
  const afterEmpty = Object.keys(afterHeader).length === 0
  if (beforeEmpty && afterEmpty) {
    return { status: "unchanged", fieldDiffs: [] }
  }

  const fieldDiffs: SiteConfigFieldDiff[] = []

  // Scalars: name, logo
  if (!deepEqual(beforeHeader.name, afterHeader.name)) {
    fieldDiffs.push({ path: "name", before: beforeHeader.name, after: afterHeader.name, kind: "text" })
  }
  if (!deepEqual(beforeHeader.logo, afterHeader.logo)) {
    fieldDiffs.push({ path: "logo", before: beforeHeader.logo, after: afterHeader.logo, kind: "image" })
  }

  // Maps: navLabels (slug→label), navGroups (label→slug[])
  emitMapDiff(
    "navLabels",
    beforeHeader.navLabels as Record<string, unknown> | undefined,
    afterHeader.navLabels as Record<string, unknown> | undefined,
    fieldDiffs,
  )
  emitMapDiff(
    "navGroups",
    beforeHeader.navGroups as Record<string, unknown> | undefined,
    afterHeader.navGroups as Record<string, unknown> | undefined,
    fieldDiffs,
  )

  if (fieldDiffs.length === 0) return { status: "unchanged", fieldDiffs: [] }

  // "added" / "removed" are useful signals when the entire chrome appears or
  // disappears at once (e.g. first publish, or a site reset). Otherwise it's
  // a `modified`.
  if (beforeEmpty) return { status: "added", fieldDiffs }
  if (afterEmpty) return { status: "removed", fieldDiffs }
  return { status: "modified", fieldDiffs }
}

/**
 * Compare drafts to published and produce a structured diff. Pages are
 * matched by slug. Within a page, blocks are matched by id.
 *
 * The resulting `pages` list is ordered: changed pages first (added →
 * modified → removed), unchanged last. This lets the UI collapse noise.
 */
export function computePublishDiff(
  draft: PageDoc[],
  published: PageDoc[],
  options?: {
    draftSiteConfig?: SiteConfig | null
    publishedSiteConfig?: SiteConfig | null
  },
): PublishDiff {
  const draftBySlug = new Map<string, PageDoc>()
  for (const p of draft) draftBySlug.set(p.slug, p)
  const publishedBySlug = new Map<string, PageDoc>()
  for (const p of published) publishedBySlug.set(p.slug, p)

  const allSlugs = new Set<string>([...draftBySlug.keys(), ...publishedBySlug.keys()])
  const pageDiffs: PageDiff[] = []
  let pagesAdded = 0
  let pagesRemoved = 0
  let pagesModified = 0
  let pagesUnchanged = 0
  let totalChangedFields = 0

  for (const slug of allSlugs) {
    const diff = diffPage(publishedBySlug.get(slug), draftBySlug.get(slug))
    if (!diff) continue
    pageDiffs.push(diff)
    switch (diff.status) {
      case "added": pagesAdded++; break
      case "removed": pagesRemoved++; break
      case "modified": pagesModified++; break
      case "unchanged": pagesUnchanged++; break
    }
    for (const bd of diff.blockDiffs) {
      if (bd.fieldDiffs) totalChangedFields += bd.fieldDiffs.length
    }
  }

  const statusOrder: Record<PageDiff["status"], number> = {
    added: 0,
    modified: 1,
    removed: 2,
    unchanged: 3,
  }
  pageDiffs.sort((x, y) => {
    const s = statusOrder[x.status] - statusOrder[y.status]
    if (s !== 0) return s
    return x.slug.localeCompare(y.slug)
  })

  const siteConfig = diffSiteConfig(options?.publishedSiteConfig, options?.draftSiteConfig)

  return {
    summary: {
      pagesAdded,
      pagesRemoved,
      pagesModified,
      pagesUnchanged,
      totalChangedFields,
      siteConfigChangedFields: siteConfig.fieldDiffs.length,
    },
    pages: pageDiffs,
    siteConfig,
  }
}
