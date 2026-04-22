import type { AvcConfig } from "./config.js"

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
    this.name = "HttpError"
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "DELETE"
  body?: unknown
  query?: Record<string, string | number | undefined>
  timeoutMs?: number
  includePublishToken?: boolean
}

export async function request<T = unknown>(
  config: AvcConfig,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, config.orchestrator)
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v))
    }
  }

  const headers: Record<string, string> = { accept: "application/json" }
  if (opts.body !== undefined) headers["content-type"] = "application/json"
  if (opts.includePublishToken && config.publishToken) {
    headers["x-publish-token"] = config.publishToken
  }

  const ac = new AbortController()
  const timeout = setTimeout(() => ac.abort(), opts.timeoutMs ?? 15_000)

  let res: Response
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ac.signal,
    })
  } catch (err) {
    const aborted = (err as Error).name === "AbortError"
    throw new Error(
      aborted
        ? `Request to ${url} timed out after ${opts.timeoutMs ?? 15_000}ms`
        : `Could not reach orchestrator at ${config.orchestrator}: ${(err as Error).message}`,
    )
  } finally {
    clearTimeout(timeout)
  }

  const text = await res.text()
  if (!res.ok) {
    throw new HttpError(
      `${opts.method ?? "GET"} ${path} → ${res.status}`,
      res.status,
      text,
    )
  }

  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    return text as unknown as T
  }
}
