"use client"

export default function SiteError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "60vh",
        gap: "20px",
        padding: "24px",
        textAlign: "center",
      }}
    >
      <svg
        width="48"
        height="48"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--body-secondary, #888)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <h1
        style={{
          fontSize: "1.5rem",
          fontWeight: 600,
          color: "var(--heading)",
          margin: 0,
        }}
      >
        Something went wrong
      </h1>
      <p
        style={{
          maxWidth: "28rem",
          color: "var(--body-secondary)",
          margin: 0,
        }}
      >
        An unexpected error occurred while loading this page. Please try again.
      </p>
      <button
        type="button"
        onClick={reset}
        style={{
          display: "inline-block",
          padding: "10px 20px",
          borderRadius: "var(--radius-btn, 8px)",
          backgroundColor: "var(--brand, #333)",
          color: "#ffffff",
          fontSize: "0.875rem",
          fontWeight: 500,
          border: "none",
          cursor: "pointer",
        }}
      >
        Try again
      </button>
    </main>
  )
}
