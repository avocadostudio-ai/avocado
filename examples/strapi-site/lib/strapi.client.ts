const rawStrapiUrl = process.env.STRAPI_URL?.trim().replace(/\/+$/, "")
if (!rawStrapiUrl) throw new Error("STRAPI_URL is required")
/** Base URL for the Strapi instance, guaranteed non-empty at module load. */
export const STRAPI_URL: string = rawStrapiUrl

const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN?.trim()

/** Fetch from Strapi REST API with auth header */
export async function strapiFetch<T = unknown>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const url = `${STRAPI_URL}/api${path}`
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(STRAPI_TOKEN ? { Authorization: `Bearer ${STRAPI_TOKEN}` } : {}),
      ...options?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Strapi ${res.status} ${res.statusText}: ${body.slice(0, 200)}`)
  }
  // Strapi DELETE returns 204/empty body — avoid JSON parse error
  const text = await res.text()
  if (!text) return undefined as T
  return JSON.parse(text) as T
}
