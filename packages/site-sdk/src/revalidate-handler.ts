import type { PageDoc } from "./types.ts"

export type RevalidateHandlerConfig = {
  /** Environment variable name containing the webhook secret (e.g. "SANITY_WEBHOOK_SECRET") */
  secretEnvVar: string
  /**
   * Where to look for the webhook secret. Accepts:
   * - A header name string (default: "x-revalidate-secret")
   * - null to check only query param "secret"
   * - An array to check multiple sources in order (e.g. query param then header)
   */
  secretHeader?: string | string[] | null
  /** Extract the page slug from the webhook body. Return null to revalidate "/". */
  extractSlug: (body: unknown) => string | null
  /** Fetch all published pages (for orchestrator bootstrap after CMS changes). */
  getPages: () => Promise<PageDoc[]>
  /** Site identifier passed to orchestrator bootstrap. */
  siteId: string
  /** Session name passed to orchestrator bootstrap. Defaults to "dev". */
  session?: string
}

/**
 * Factory for CMS webhook → ISR revalidation + orchestrator bootstrap routes.
 *
 * All three CMS integrations follow the same pattern:
 * 1. Validate webhook secret
 * 2. Extract slug from CMS-specific body shape
 * 3. Call Next.js revalidatePath()
 * 4. Re-bootstrap orchestrator with fresh content
 *
 * This factory extracts that into a single configurable handler.
 *
 * Usage:
 * ```ts
 * export const POST = createRevalidateHandler({
 *   secretEnvVar: "SANITY_WEBHOOK_SECRET",
 *   extractSlug: (body) => (body as any)?.slug?.current ?? null,
 *   getPages: getSanityPages,
 *   siteId: "sanity-site",
 * })
 * ```
 */
export function createRevalidateHandler(config: RevalidateHandlerConfig) {
  const { secretEnvVar, extractSlug, getPages, siteId, session = "dev" } = config
  const secretHeader = config.secretHeader === undefined ? "x-revalidate-secret" : config.secretHeader

  return async function POST(request: Request) {
    const configuredSecret = process.env[secretEnvVar]?.trim()
    if (!configuredSecret) {
      return Response.json({ error: `${secretEnvVar} not configured` }, { status: 500 })
    }

    // Validate secret: check configured sources in order
    let provided: string | undefined
    const sources = secretHeader === null ? ["query:secret"]
      : Array.isArray(secretHeader) ? secretHeader
      : [secretHeader]
    const url = new URL(request.url)
    for (const src of sources) {
      if (src.startsWith("query:")) {
        provided = url.searchParams.get(src.slice(6))?.trim() ?? undefined
      } else {
        provided = request.headers.get(src)?.trim() ?? undefined
      }
      if (provided) break
    }
    if (!provided || provided !== configuredSecret) {
      return Response.json({ error: "Invalid secret" }, { status: 401 })
    }

    try {
      const body = await request.json()
      const rawSlug = extractSlug(body) ?? "/"
      const path = rawSlug === "/" ? "/" : `/${rawSlug.replace(/^\//, "")}`

      // ISR revalidation — dynamic import to avoid hard dep on next
      try {
        const { revalidatePath } = await import(/* webpackIgnore: true */ "next/cache")
        revalidatePath(path)
      } catch {
        // Not running in Next.js or revalidatePath unavailable
      }

      // Re-bootstrap orchestrator with fresh CMS content
      const orchestratorUrl = process.env.ORCHESTRATOR_URL
      if (orchestratorUrl) {
        const pages = await getPages()
        await fetch(`${orchestratorUrl}/draft/bootstrap`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session, siteId, pages, overwrite: true }),
        }).catch(() => {})
      }

      return Response.json({ revalidated: true, path })
    } catch {
      return Response.json({ error: "Invalid request body" }, { status: 400 })
    }
  }
}
