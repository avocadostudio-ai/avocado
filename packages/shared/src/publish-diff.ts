/**
 * Types for the "what will change on publish" diff.
 *
 * The orchestrator computes a PublishDiff by comparing session draft pages
 * to the currently-published pages. Shape is intentionally lightweight so
 * the editor (and later the immersive widget) can render it without extra
 * work.
 */

export type FieldDiffKind = "text" | "image" | "other"

export type FieldDiff = {
  /** Dotted/bracketed path inside the block's props, e.g. `heading` or `items[2].quote`. */
  path: string
  before: unknown
  after: unknown
  /** Rendering hint for the UI (text diff vs thumbnail vs generic). */
  kind: FieldDiffKind
}

export type BlockDiffStatus = "added" | "removed" | "modified" | "moved" | "unchanged"

export type BlockDiff = {
  blockId: string
  type: string
  status: BlockDiffStatus
  /** When status === "modified" (or "moved" with prop changes) — field-level leaves that changed. */
  fieldDiffs?: FieldDiff[]
  /** 0-based index in published page. Omitted when block was added. */
  positionBefore?: number
  /** 0-based index in draft page. Omitted when block was removed. */
  positionAfter?: number
}

export type PageDiffStatus = "added" | "removed" | "modified" | "unchanged"

export type PageDiff = {
  slug: string
  status: PageDiffStatus
  titleBefore?: string
  titleAfter?: string
  blockDiffs: BlockDiff[]
}

export type PublishDiff = {
  summary: {
    pagesAdded: number
    pagesRemoved: number
    pagesModified: number
    pagesUnchanged: number
    /** Total number of field-level changes across all pages. Useful for CTA labels. */
    totalChangedFields: number
  }
  pages: PageDiff[]
}
