import { useMemo } from "react"
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

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  chatLog: ChatEntry[]
  isPublishing: boolean
}

/** Extract page slug from deterministic change entries like "Updated Hero image on /home" */
function parsePageSlug(line: string): string | null {
  const match = line.match(/ on \/([\w-]+(?:\/[\w-]+)*)$/)
  return match ? `/${match[1]}` : null
}

/** Strip the trailing " on /slug" suffix for grouped display */
function stripSlugSuffix(line: string): string {
  return line.replace(/ on \/[\w-]+(?:\/[\w-]+)*$/, "")
}

function groupChangesByPage(changes: string[]): Map<string, string[]> | null {
  const grouped = new Map<string, string[]>()
  let hasMultiplePages = false
  let firstPage: string | null = null

  for (const line of changes) {
    const slug = parsePageSlug(line)
    const key = slug ?? "_general"
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(slug ? stripSlugSuffix(line) : line)

    if (slug && !firstPage) firstPage = slug
    if (slug && firstPage && slug !== firstPage) hasMultiplePages = true
  }

  // Only group if there are multiple pages
  if (!hasMultiplePages) return null
  return grouped
}

export function PublishReviewDialog({ open, onOpenChange, onConfirm, chatLog, isPublishing }: Props) {
  const changes = useMemo(
    () =>
      chatLog
        .filter((e) => e.role === "assistant" && e.canUndo && e.changes && e.changes.length > 0)
        .flatMap((e) => e.changes!),
    [chatLog]
  )

  const grouped = useMemo(() => groupChangesByPage(changes), [changes])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="publish-review-dialog sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Publish</DialogTitle>
          <DialogDescription>
            Your changes will be saved and deployed to the live site.
          </DialogDescription>
        </DialogHeader>

        {changes.length > 0 && grouped && (
          <div className="publish-review-section">
            <h4 className="publish-review-section-title">Changes</h4>
            {[...grouped.entries()].map(([page, items]) => (
              <div key={page} className="publish-review-page-group">
                {page !== "_general" && (
                  <h5 className="publish-review-page-slug">{page}</h5>
                )}
                <ul className="publish-review-list publish-review-changes">
                  {items.slice(0, 20).map((line, idx) => (
                    <li key={idx} className="publish-review-item">{line}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        {changes.length > 0 && !grouped && (
          <div className="publish-review-section">
            <h4 className="publish-review-section-title">Changes</h4>
            <ul className="publish-review-list publish-review-changes">
              {changes.slice(0, 20).map((line, idx) => (
                <li key={idx} className="publish-review-item">{line}</li>
              ))}
              {changes.length > 20 && (
                <li className="publish-review-item publish-review-overflow">
                  and {changes.length - 20} more…
                </li>
              )}
            </ul>
          </div>
        )}

        {changes.length === 0 && (
          <p className="publish-review-empty">No changes recorded this session.</p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPublishing}>
            Cancel
          </Button>
          <Button
            onClick={() => { onConfirm(); onOpenChange(false) }}
            disabled={isPublishing}
          >
            {isPublishing ? "Publishing…" : "Publish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
