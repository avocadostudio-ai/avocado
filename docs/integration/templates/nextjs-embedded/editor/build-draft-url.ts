/**
 * Build iframe/bootstrap URL for entering draft mode.
 */
export function buildDraftEntryUrl(args: {
  siteOrigin: string
  draftSecret: string
  slug: string
  session?: string
  siteId?: string
}) {
  const target = new URL(args.slug || "/", args.siteOrigin)
  if (args.session) target.searchParams.set("session", args.session)
  if (args.siteId) target.searchParams.set("siteId", args.siteId)

  const entry = new URL("/api/draft", args.siteOrigin)
  entry.searchParams.set("secret", args.draftSecret)
  entry.searchParams.set("redirect", `${target.pathname}${target.search}`)
  return entry.toString()
}

/**
 * Build URL for exiting draft mode and viewing live content.
 */
export function buildDraftDisableUrl(args: { siteOrigin: string; slug: string }) {
  const exit = new URL("/api/draft/disable", args.siteOrigin)
  exit.searchParams.set("redirect", args.slug || "/")
  return exit.toString()
}

