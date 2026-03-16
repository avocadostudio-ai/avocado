import Link from "next/link"

export default function NotFound() {
  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="text-2xl font-semibold text-heading">Page not found</h1>
      <p className="max-w-md text-body-secondary">
        The page you're looking for doesn't exist or has been moved.
      </p>
      <Link
        href="/"
        className="rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-brand-fg transition-colors hover:bg-brand-hover"
      >
        Back to home
      </Link>
    </main>
  )
}
