/**
 * Persistent "+ Add block" pill in the bottom-right corner.
 * Sits next to the chat FAB and opens the block picker above itself,
 * inserting after the last block on the page.
 */

import { forwardRef } from "react"

type AddBlockFabProps = {
  onClick: () => void
}

export const AddBlockFab = forwardRef<HTMLButtonElement, AddBlockFabProps>(function AddBlockFab({ onClick }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className="iw-add-fab"
      onClick={onClick}
      aria-label="Add a new block"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </svg>
      <span>Add block</span>
    </button>
  )
})
