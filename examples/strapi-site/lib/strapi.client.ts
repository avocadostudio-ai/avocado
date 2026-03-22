const STRAPI_URL = process.env.STRAPI_URL?.trim().replace(/\/+$/, "")
if (!STRAPI_URL) throw new Error("STRAPI_URL is required")

const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN?.trim()

export { STRAPI_URL }

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
  return res.json() as Promise<T>
}
