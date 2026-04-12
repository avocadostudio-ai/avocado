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

export function PublishReviewDialog({ open, onOpenChange, onConfirm, chatLog, isPublishing }: Props) {
  const changes = chatLog
    .filter((e) => e.role === "assistant" && e.canUndo && e.changes && e.changes.length > 0)
    .flatMap((e) => e.changes!)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="publish-review-dialog sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Publish</DialogTitle>
          <DialogDescription>
            Your changes will be saved and deployed to the live site.
          </DialogDescription>
        </DialogHeader>

        {changes.length > 0 && (
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
