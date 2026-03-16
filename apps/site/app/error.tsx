"use client"

export default function SiteError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="text-2xl font-semibold text-heading">Something went wrong</h1>
      <p className="max-w-md text-body-secondary">
        An unexpected error occurred while loading this page. Please try again.
      </p>
      <button
        type="button"
        onClick={reset}
        className="rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-brand-fg transition-colors hover:bg-brand-hover"
      >
        Try again
      </button>
    </main>
  )
}
