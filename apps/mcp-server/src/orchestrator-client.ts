import type { McpConfig } from "./config.ts"
import type { Operation, PageDoc, SiteConfig } from "@ai-site-editor/shared"

/**
 * Thin typed wrapper around the orchestrator HTTP API.
 *
 * All tools go through this client so:
 *   - the orchestrator remains the single source of truth for validation,
 *     persistence, undo stacks, and demo-mode gating;
 *   - tests can stub a single `fetch` surface instead of reimplementing state.
 */

export type Fetcher = typeof fetch

export type RequestOptions = {
  query?: Record<string, string | number | undefined>
  body?: unknown
  /** FormData body — bypasses JSON serialization, no content-type header set. */
  formData?: FormData
  /** Bearer token for endpoints that require auth (e.g. /publish). */
  bearer?: string
  /** Abort the fetch when this signal fires — lets callers enforce per-request timeouts. */
  signal?: AbortSignal
}

export class OrchestratorClient {
  constructor(readonly config: McpConfig, private readonly fetcher: Fetcher = fetch) {}

  /** Low-level request. Exposed so tools can hit arbitrary endpoints without growing per-method wrappers for every call. */
  async request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(this.config.orchestratorUrl + path)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const headers: Record<string, string> = {}
    let body: FormData | string | undefined
    if (opts.formData) {
      body = opts.formData
    } else if (opts.body !== undefined) {
      headers["content-type"] = "application/json"
      body = JSON.stringify(opts.body)
    }
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`

    const res = await this.fetcher(url.toString(), { method, headers, body, signal: opts.signal })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`orchestrator ${method} ${path} failed: ${res.status} ${text}`)
    }
    // Some endpoints return non-JSON (rare) — fall back to text.
    const contentType = res.headers.get("content-type") ?? ""
    if (contentType.includes("application/json")) return (await res.json()) as T
    return (await res.text()) as unknown as T
  }

  /** Convenience: session + siteId pre-filled for endpoints that take them as query params. */
  scoped(extra: Record<string, string | number | undefined> = {}): Record<string, string | number | undefined> {
    return { session: this.config.session, siteId: this.config.siteId, ...extra }
  }

  /** Convenience: session + siteId pre-filled for endpoints that take them in the body. */
  scopedBody<T extends Record<string, unknown>>(extra: T): T & { session: string; siteId: string } {
    return { session: this.config.session, siteId: this.config.siteId, ...extra }
  }

  // ── Typed helpers for the hottest paths ──

  getPage(slug: string): Promise<PageDoc> {
    return this.request<PageDoc>("GET", "/draft/pages", { query: this.scoped({ slug }) })
  }

  listSlugs(): Promise<PagesIndexResponse> {
    return this.request<PagesIndexResponse>("GET", "/draft/slugs", { query: this.scoped() })
  }

  getSiteConfig(): Promise<SiteConfig> {
    return this.request<SiteConfig>("GET", "/draft/site-config", { query: this.scoped() })
  }

  applyOps(ops: Operation[]): Promise<ApplyOpsResponse> {
    return this.request<ApplyOpsResponse>("POST", "/ops", { body: this.scopedBody({ ops }) })
  }

  whoami(): Promise<WhoamiResponse> {
    return this.request<WhoamiResponse>("GET", "/whoami", { query: this.scoped() })
  }

  listSessions(): Promise<ListSessionsResponse> {
    return this.request<ListSessionsResponse>("GET", "/sessions")
  }
}

export type PagesIndexEntry = {
  slug: string
  title: string
  updatedAt: string
  blockCount: number
}

export type PagesIndexResponse = {
  slugs: string[]
  pages: PagesIndexEntry[]
}

export type SessionSummary = {
  sessionKey: string
  session: string
  siteId: string
  version: number
  draftPageCount: number
  lastMutatedAt: string | null
}

export type WhoamiResponse = SessionSummary & {
  publishedPageCount: number
  orchestratorUrl: string
}

export type ListSessionsResponse = {
  sessions: SessionSummary[]
  publishedPageCount: number
}

export type ApplyOpsResponse = {
  status: string
  summary: string
  changes: unknown[]
  mentionedSlugs: string[]
  previewVersion: number
  focusBlockId?: string
  updatedSlug?: string
  /**
   * Only present when the batch contained at least one duplicate_page op.
   * Each entry maps the new page's slug to a { oldBlockId: newBlockId } table
   * so callers can target the copied blocks without a follow-up get-page.
   */
  duplicatedPages?: Array<{ slug: string; blockIdMap: Record<string, string> }>
}
