/**
 * Floating action button that toggles the immersive chat panel.
 */

type ChatFabProps = {
  open: boolean
  onClick: () => void
  unreadCount?: number
}

export function ChatFab({ open, onClick, unreadCount = 0 }: ChatFabProps) {
  return (
    <button
      type="button"
      className="iw-fab"
      onClick={onClick}
      aria-label={open ? "Close AI chat" : "Open AI chat"}
      aria-expanded={open}
    >
      {open ? (
        // Minimize icon
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m7 7 10 10" />
          <path d="M17 7 7 17" />
        </svg>
      ) : (
        // Sparkle / AI icon
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
          <path d="M20 3v4" />
          <path d="M22 5h-4" />
          <path d="M4 17v2" />
          <path d="M5 18H3" />
        </svg>
      )}
      {!open && unreadCount > 0 && (
        <span className="iw-fab-badge">{unreadCount > 9 ? "9+" : unreadCount}</span>
      )}
    </button>
  )
}
