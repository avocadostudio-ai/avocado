import Link from "next/link"

export default function NotFound() {
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
      <p style={{ fontSize: "48px", lineHeight: 1, margin: 0 }}>404</p>
      <h1
        style={{
          fontSize: "1.5rem",
          fontWeight: 600,
          color: "var(--heading)",
          margin: 0,
        }}
      >
        Page not found
      </h1>
      <p
        style={{
          maxWidth: "28rem",
          color: "var(--body-secondary)",
          margin: 0,
        }}
      >
        The page you&apos;re looking for doesn&apos;t exist or has been moved.
      </p>
      <Link
        href="/"
        style={{
          display: "inline-block",
          padding: "10px 20px",
          borderRadius: "var(--radius-btn)",
          backgroundColor: "var(--brand)",
          color: "#ffffff",
          fontSize: "0.875rem",
          fontWeight: 500,
          textDecoration: "none",
        }}
      >
        Back to home
      </Link>
    </main>
  )
}
