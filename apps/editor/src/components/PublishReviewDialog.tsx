import { useMemo, useState } from "react"
import type { BlockDiff, FieldDiff, PageDiff, PublishDiff } from "@avocadostudio-ai/shared"
import type { ChatEntry } from "../lib/editor-types"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { usePublishDiff } from "../hooks/usePublishDiff"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  chatLog: ChatEntry[]
  isPublishing: boolean
  session: string
  siteId: string
  /** Site origin so the orchestrator can fetch authoritative published content. */
  siteOrigin?: string
}

const TRUNCATE_LEN = 80

function truncate(s: string): { shown: string; truncated: boolean } {
  if (s.length <= TRUNCATE_LEN) return { shown: s, truncated: false }
  return { shown: s.slice(0, TRUNCATE_LEN), truncated: true }
}

function toStringValue(v: unknown): string {
  if (v === undefined) return "∅"
  if (v === null) return "null"
  if (typeof v === "string") return v
  try { return JSON.stringify(v) } catch { return String(v) }
}

function pageStatusClass(status: PageDiff["status"]): string {
  return `publish-diff-status publish-diff-status--${status}`
}

function blockStatusClass(status: BlockDiff["status"]): string {
  return `publish-diff-status publish-diff-status--${status}`
}

function FieldDiffLine({ diff }: { diff: FieldDiff }) {
  const [expanded, setExpanded] = useState(false)

  if (diff.kind === "image") {
    const beforeUrl = typeof diff.before === "string" ? diff.before : ""
    const afterUrl = typeof diff.after === "string" ? diff.after : ""
    return (
      <li className="publish-diff-field">
        <span className="publish-diff-field-path">{diff.path}</span>
        <span className="publish-diff-thumbs">
          {beforeUrl ? <img src={beforeUrl} alt="" className="publish-diff-thumb" /> : <span className="publish-diff-thumb publish-diff-thumb--empty">∅</span>}
          <span className="publish-diff-arrow">→</span>
          {afterUrl ? <img src={afterUrl} alt="" className="publish-diff-thumb" /> : <span className="publish-diff-thumb publish-diff-thumb--empty">∅</span>}
        </span>
      </li>
    )
  }

  const beforeStr = toStringValue(diff.before)
  const afterStr = toStringValue(diff.after)
  const { shown: beforeShown, truncated: beforeTrunc } = truncate(beforeStr)
  const { shown: afterShown, truncated: afterTrunc } = truncate(afterStr)
  const canExpand = beforeTrunc || afterTrunc

  if (canExpand && !expanded) {
    return (
      <li className="publish-diff-field">
        <span className="publish-diff-field-path">{diff.path}</span>
        <button type="button" className="publish-diff-expand" onClick={() => setExpanded(true)}>
          {diff.path.split(/[.\[]/).pop()?.replace("]", "")} modified ▸
        </button>
      </li>
    )
  }

  return (
    <li className="publish-diff-field">
      <span className="publish-diff-field-path">{diff.path}</span>
      <span className="publish-diff-values">
        <span className="publish-diff-before">{beforeShown}{!expanded && beforeTrunc ? "…" : ""}</span>
        <span className="publish-diff-arrow">→</span>
        <span className="publish-diff-after">{afterShown}{!expanded && afterTrunc ? "…" : ""}</span>
        {canExpand && (
          <button type="button" className="publish-diff-collapse" onClick={() => setExpanded(false)}>collapse</button>
        )}
      </span>
    </li>
  )
}

function BlockDiffItem({ bd }: { bd: BlockDiff }) {
  const label = bd.status === "modified"
    ? `${bd.type}`
    : bd.status === "moved"
      ? `${bd.type} · moved`
      : bd.status === "added"
        ? `${bd.type} · new`
        : bd.status === "removed"
          ? `${bd.type} · removed`
          : bd.type

  return (
    <div className="publish-diff-block">
      <div className="publish-diff-block-header">
        <span className={blockStatusClass(bd.status)} aria-hidden />
        <span className="publish-diff-block-label">{label}</span>
      </div>
      {bd.fieldDiffs && bd.fieldDiffs.length > 0 && (
        <ul className="publish-diff-field-list">
          {bd.fieldDiffs.map((fd, i) => <FieldDiffLine key={i} diff={fd} />)}
        </ul>
      )}
    </div>
  )
}

function PageDiffCard({ pd, defaultOpen }: { pd: PageDiff; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const changedBlocks = pd.blockDiffs.filter((bd) => bd.status !== "unchanged")
  const summary = pd.status === "unchanged"
    ? "no changes"
    : pd.status === "added"
      ? `added · ${changedBlocks.length} block${changedBlocks.length === 1 ? "" : "s"}`
      : pd.status === "removed"
        ? "will be removed"
        : `${changedBlocks.length} change${changedBlocks.length === 1 ? "" : "s"}`

  const isCollapsible = pd.status !== "unchanged" && changedBlocks.length > 0

  return (
    <div className="publish-diff-page">
      <button
        type="button"
        className="publish-diff-page-header"
        onClick={() => isCollapsible && setOpen((v) => !v)}
        disabled={!isCollapsible}
      >
        <span className={pageStatusClass(pd.status)} aria-hidden />
        <span className="publish-diff-page-slug">{pd.slug}</span>
        <span className="publish-diff-page-summary">{summary}</span>
        {isCollapsible && <span className="publish-diff-caret">{open ? "▾" : "▸"}</span>}
      </button>
      {open && isCollapsible && (
        <div className="publish-diff-page-body">
          {pd.titleBefore !== undefined && pd.titleAfter !== undefined && (
            <div className="publish-diff-title">
              <span className="publish-diff-field-path">title</span>
              <span className="publish-diff-values">
                <span className="publish-diff-before">{pd.titleBefore}</span>
                <span className="publish-diff-arrow">→</span>
                <span className="publish-diff-after">{pd.titleAfter}</span>
              </span>
            </div>
          )}
          {changedBlocks.map((bd) => <BlockDiffItem key={bd.blockId} bd={bd} />)}
        </div>
      )}
    </div>
  )
}

function DiffSummaryBar({ diff }: { diff: PublishDiff }) {
  const parts: string[] = []
  if (diff.summary.pagesAdded) parts.push(`${diff.summary.pagesAdded} page${diff.summary.pagesAdded === 1 ? "" : "s"} added`)
  if (diff.summary.pagesModified) parts.push(`${diff.summary.pagesModified} page${diff.summary.pagesModified === 1 ? "" : "s"} modified`)
  if (diff.summary.pagesRemoved) parts.push(`${diff.summary.pagesRemoved} page${diff.summary.pagesRemoved === 1 ? "" : "s"} removed`)
  if (diff.summary.totalChangedFields) parts.push(`${diff.summary.totalChangedFields} field${diff.summary.totalChangedFields === 1 ? "" : "s"} changed`)
  return (
    <div className="publish-diff-summary">{parts.length > 0 ? parts.join(" · ") : "No changes to publish."}</div>
  )
}

export function PublishReviewDialog({ open, onOpenChange, onConfirm, chatLog, isPublishing, session, siteId, siteOrigin }: Props) {
  const { diff, isLoading, error } = usePublishDiff(open, session, siteId, siteOrigin)

  const changedPages = useMemo(
    () => diff ? diff.pages.filter((p) => p.status !== "unchanged") : [],
    [diff]
  )
  const unchangedCount = diff ? diff.pages.length - changedPages.length : 0

  const hasChanges = !!diff && diff.summary.totalChangedFields > 0
  const ctaLabel = isPublishing
    ? "Publishing…"
    : hasChanges
      ? `Publish ${diff!.summary.totalChangedFields} change${diff!.summary.totalChangedFields === 1 ? "" : "s"}`
      : "Publish"

  // Keep a small chat-log tail visible for context — helpful when the diff
  // and the chat narrative both matter. Collapsible to stay out of the way.
  const recentChanges = useMemo(
    () => chatLog
      .filter((e) => e.role === "assistant" && e.canUndo && e.changes && e.changes.length > 0)
      .flatMap((e) => e.changes!)
      .slice(-5),
    [chatLog]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="publish-review-dialog sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Publish</DialogTitle>
          <DialogDescription>
            Review what will change before deploying to the live site.
          </DialogDescription>
        </DialogHeader>

        {isLoading && <div className="publish-review-empty">Loading diff…</div>}
        {error && !isLoading && (
          <div className="publish-review-empty">Could not load diff: {error}</div>
        )}

        {diff && !isLoading && (
          <>
            <DiffSummaryBar diff={diff} />
            <div className="publish-diff-list">
              {changedPages.length === 0 && (
                <div className="publish-review-empty">Draft matches the currently published site.</div>
              )}
              {changedPages.map((pd, idx) => (
                <PageDiffCard key={pd.slug} pd={pd} defaultOpen={idx === 0} />
              ))}
              {unchangedCount > 0 && (
                <div className="publish-diff-unchanged-note">{unchangedCount} unchanged page{unchangedCount === 1 ? "" : "s"}</div>
              )}
            </div>
          </>
        )}

        {recentChanges.length > 0 && (
          <details className="publish-diff-chat-log">
            <summary>Recent AI activity</summary>
            <ul className="publish-review-list publish-review-changes">
              {recentChanges.map((line, idx) => (
                <li key={idx} className="publish-review-item">{line}</li>
              ))}
            </ul>
          </details>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPublishing}>
            Cancel
          </Button>
          <Button
            onClick={() => { onConfirm(); onOpenChange(false) }}
            disabled={isPublishing || isLoading || !hasChanges}
          >
            {ctaLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
