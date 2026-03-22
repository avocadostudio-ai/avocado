import type { CmsMediaConfig } from "./editor-types"

export type CmsMediaItem = {
  id: string
  name?: string
  imageUrl?: string
  thumbUrl: string
  alt?: string
}

export type CmsMediaResult = {
  items: CmsMediaItem[]
  totalPages: number
}

export function getCmsMediaLabel(config: CmsMediaConfig): string {
  switch (config.provider) {
    case "contentful": return "Contentful"
    case "sanity": return "Sanity"
    case "strapi": return "Strapi"
  }
}

export async function fetchCmsMedia(
  config: CmsMediaConfig,
  query: string,
  page: number,
  limit: number
): Promise<CmsMediaResult> {
  switch (config.provider) {
    case "contentful": return fetchContentfulMedia(config, query, page, limit)
    case "sanity": return fetchSanityMedia(config, query, page, limit)
    case "strapi": return fetchStrapiMedia(config, query, page, limit)
  }
}

// ---------------------------------------------------------------------------
// Contentful
// ---------------------------------------------------------------------------

async function fetchContentfulMedia(
  config: Extract<CmsMediaConfig, { provider: "contentful" }>,
  query: string,
  page: number,
  limit: number
): Promise<CmsMediaResult> {
  const env = config.environment ?? "master"
  const skip = (page - 1) * limit
  const params = new URLSearchParams({
    access_token: config.deliveryToken,
    limit: String(limit),
    skip: String(skip),
    mimetype_group: "image",
  })
  if (query) params.set("query", query)

  const res = await fetch(
    `https://cdn.contentful.com/spaces/${config.spaceId}/environments/${env}/assets?${params}`
  )
  if (!res.ok) return { items: [], totalPages: 0 }

  const data = (await res.json()) as {
    items: Array<{ sys: { id: string }; fields: { title?: string; description?: string; file?: { url?: string; details?: { image?: { width: number; height: number } } } } }>
    total: number
  }

  return {
    items: data.items
      .filter((item) => item.fields.file?.url)
      .map((item) => {
        const url = item.fields.file!.url!
        const fullUrl = url.startsWith("//") ? `https:${url}` : url
        return {
          id: item.sys.id,
          name: item.fields.title,
          alt: item.fields.description ?? item.fields.title,
          imageUrl: fullUrl,
          thumbUrl: `${fullUrl}?w=200&h=200&fit=thumb`,
        }
      }),
    totalPages: Math.ceil(data.total / limit),
  }
}

// ---------------------------------------------------------------------------
// Sanity
// ---------------------------------------------------------------------------

async function fetchSanityMedia(
  config: Extract<CmsMediaConfig, { provider: "sanity" }>,
  query: string,
  page: number,
  limit: number
): Promise<CmsMediaResult> {
  const dataset = config.dataset ?? "production"
  const offset = (page - 1) * limit
  const end = offset + limit - 1

  // GROQ query for image assets
  let groq = `*[_type == "sanity.imageAsset"]`
  if (query) groq = `*[_type == "sanity.imageAsset" && originalFilename match "*${query}*"]`
  groq += ` | order(_createdAt desc) [${offset}..${end}] { _id, url, originalFilename, metadata { dimensions } }`

  // Also get total count
  let countGroq = `count(*[_type == "sanity.imageAsset"])`
  if (query) countGroq = `count(*[_type == "sanity.imageAsset" && originalFilename match "*${query}*"])`

  const [assetsRes, countRes] = await Promise.all([
    fetch(`https://${config.projectId}.api.sanity.io/v2024-01-01/data/query/${dataset}?query=${encodeURIComponent(groq)}`),
    fetch(`https://${config.projectId}.api.sanity.io/v2024-01-01/data/query/${dataset}?query=${encodeURIComponent(countGroq)}`),
  ])

  if (!assetsRes.ok) return { items: [], totalPages: 0 }

  const assets = (await assetsRes.json()) as {
    result: Array<{ _id: string; url: string; originalFilename?: string }>
  }
  const count = countRes.ok ? ((await countRes.json()) as { result: number }).result : 0

  return {
    items: assets.result.map((asset) => ({
      id: asset._id,
      name: asset.originalFilename,
      alt: asset.originalFilename,
      imageUrl: asset.url,
      thumbUrl: `${asset.url}?w=200&h=200&fit=crop`,
    })),
    totalPages: Math.ceil(count / limit),
  }
}

// ---------------------------------------------------------------------------
// Strapi
// ---------------------------------------------------------------------------

async function fetchStrapiMedia(
  config: Extract<CmsMediaConfig, { provider: "strapi" }>,
  query: string,
  page: number,
  limit: number
): Promise<CmsMediaResult> {
  const baseUrl = config.url.replace(/\/+$/, "")
  const params = new URLSearchParams({
    "filters[mime][$startsWith]": "image",
    "pagination[page]": String(page),
    "pagination[pageSize]": String(limit),
    "sort": "createdAt:desc",
  })
  if (query) params.set("filters[name][$containsi]", query)

  const headers: Record<string, string> = {}
  if (config.token) headers.Authorization = `Bearer ${config.token}`

  const res = await fetch(`${baseUrl}/api/upload/files?${params}`, { headers })
  if (!res.ok) return { items: [], totalPages: 0 }

  const data = (await res.json()) as Array<{
    id: number
    documentId?: string
    name: string
    url: string
    formats?: { thumbnail?: { url: string } }
  }>

  // Strapi upload endpoint returns array directly (no wrapper), pagination in headers
  const totalCount = Number(res.headers.get("x-total-count") ?? data.length)

  return {
    items: data.map((file) => {
      const fullUrl = file.url.startsWith("http") ? file.url : `${baseUrl}${file.url}`
      const thumbUrl = file.formats?.thumbnail?.url
        ? (file.formats.thumbnail.url.startsWith("http") ? file.formats.thumbnail.url : `${baseUrl}${file.formats.thumbnail.url}`)
        : fullUrl
      return {
        id: file.documentId ?? String(file.id),
        name: file.name,
        alt: file.name,
        imageUrl: fullUrl,
        thumbUrl,
      }
    }),
    totalPages: Math.ceil(totalCount / limit),
  }
}
