import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { google, type drive_v3 } from "googleapis"
import sharp from "sharp"
import type { ImageLogger } from "./image-helpers.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GDriveImageItem = {
  id: string
  name: string
  mimeType: string
  thumbnailLink: string
  size: number
  width?: number
  height?: number
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function createDriveClient(): drive_v3.Drive | null {
  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON?.trim()
  if (serviceAccountJson) {
    try {
      const key = JSON.parse(serviceAccountJson) as { client_email: string; private_key: string }
      const auth = new google.auth.JWT({
        email: key.client_email,
        key: key.private_key,
        scopes: ["https://www.googleapis.com/auth/drive.readonly"]
      })
      return google.drive({ version: "v3", auth })
    } catch {
      return null
    }
  }

  const apiKey = process.env.GOOGLE_API_KEY?.trim()
  if (apiKey) {
    return google.drive({ version: "v3", auth: apiKey })
  }

  return null
}

let cachedClient: drive_v3.Drive | null | undefined

function getDriveClient(): drive_v3.Drive | null {
  if (cachedClient !== undefined) return cachedClient
  cachedClient = createDriveClient()
  return cachedClient
}

/** Reset cached client (useful after env changes or in tests). */
export function resetDriveClient() {
  cachedClient = undefined
}

// ---------------------------------------------------------------------------
// In-memory listing cache (5-min TTL, max 100 entries)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000
const CACHE_MAX_ENTRIES = 100
const listCache = new Map<string, { items: GDriveImageItem[]; ts: number }>()

function evictStaleCache() {
  if (listCache.size <= CACHE_MAX_ENTRIES) return
  const now = Date.now()
  for (const [key, entry] of listCache) {
    if (now - entry.ts > CACHE_TTL_MS) listCache.delete(key)
  }
  // If still over limit after TTL eviction, drop oldest entries
  if (listCache.size > CACHE_MAX_ENTRIES) {
    const entries = Array.from(listCache.entries()).sort((a, b) => a[1].ts - b[1].ts)
    const toRemove = entries.slice(0, entries.length - CACHE_MAX_ENTRIES)
    for (const [key] of toRemove) listCache.delete(key)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a file name like "hero_image-v2.jpg" to alt text "hero image v2". */
export function fileNameToAlt(name: string): string {
  return name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ")
}

export function isGdriveConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_DRIVE_FOLDER_ID?.trim() &&
    (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON?.trim() || process.env.GOOGLE_API_KEY?.trim())
  )
}

/** Extract a bare folder ID from a value that may be a full Google Drive URL or a raw ID. */
function extractFolderId(value: string): string {
  // https://drive.google.com/drive/u/0/folders/FOLDER_ID or /drive/folders/FOLDER_ID
  const urlMatch = value.match(/\/folders\/([a-zA-Z0-9_-]+)/)
  if (urlMatch?.[1]) return urlMatch[1]
  return value
}

/** Resolve folder ID from an override or fall back to env var. Returns undefined if neither is set. */
export function resolveGdriveFolderId(override?: string): string | undefined {
  const trimmed = override?.trim()
  if (trimmed) return extractFolderId(trimmed)
  const envId = process.env.GOOGLE_DRIVE_FOLDER_ID?.trim()
  if (envId) return extractFolderId(envId)
  return undefined
}

// ---------------------------------------------------------------------------
// List images
// ---------------------------------------------------------------------------

const MAX_SUBFOLDER_DEPTH = 3

async function listImagesInFolder(
  drive: drive_v3.Drive,
  folderId: string,
  query: string | undefined,
  log: ImageLogger | undefined,
  depth: number
): Promise<GDriveImageItem[]> {
  const items: GDriveImageItem[] = []
  const subfolderIds: string[] = []

  // Query both images and subfolders in this folder
  const qParts = [
    `'${folderId}' in parents`,
    `(mimeType contains 'image/' or mimeType = 'application/vnd.google-apps.folder')`,
    "trashed = false"
  ]
  if (query) {
    // Name filter only applies to images; subfolders are always traversed
    // We'll filter by name client-side for images while still discovering folders
  }

  const pageSize = 100
  let pageToken: string | undefined
  do {
    const res = await drive.files.list({
      q: qParts.join(" and "),
      fields: "nextPageToken, files(id, name, mimeType, thumbnailLink, size, imageMediaMetadata)",
      pageSize,
      pageToken,
      orderBy: "name"
    })
    for (const file of res.data.files ?? []) {
      if (!file.id || !file.name) continue
      if (file.mimeType === "application/vnd.google-apps.folder") {
        if (depth < MAX_SUBFOLDER_DEPTH) subfolderIds.push(file.id)
        continue
      }
      // Apply name filter client-side (so subfolders are still traversed)
      if (query && !file.name.toLowerCase().includes(query.toLowerCase())) continue
      items.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType ?? "image/jpeg",
        thumbnailLink: file.thumbnailLink ?? "",
        size: Number(file.size ?? 0),
        width: file.imageMediaMetadata?.width ?? undefined,
        height: file.imageMediaMetadata?.height ?? undefined
      })
    }
    pageToken = res.data.nextPageToken ?? undefined
  } while (pageToken)

  // Recursively list images in subfolders (in parallel)
  if (subfolderIds.length > 0) {
    const subResults = await Promise.all(
      subfolderIds.map((subId) => listImagesInFolder(drive, subId, query, log, depth + 1))
    )
    for (const subItems of subResults) items.push(...subItems)
  }

  return items
}

export async function listImages(
  folderId: string,
  query?: string,
  log?: ImageLogger,
  maxResults?: number
): Promise<GDriveImageItem[]> {
  const drive = getDriveClient()
  if (!drive) {
    log?.warn({ event: "gdrive_no_client" }, "Google Drive client not configured")
    return []
  }

  const cacheKey = `${folderId}::${query ?? ""}`
  const cached = listCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return maxResults ? cached.items.slice(0, maxResults) : cached.items
  }

  try {
    const items = await listImagesInFolder(drive, folderId, query, log, 0)

    listCache.set(cacheKey, { items, ts: Date.now() })
    evictStaleCache()
    log?.info({ event: "gdrive_list", folderId, query, count: items.length }, "Listed Google Drive images")
    return maxResults ? items.slice(0, maxResults) : items
  } catch (err) {
    log?.warn(
      { event: "gdrive_list_error", folderId, error: err instanceof Error ? err.message : String(err) },
      "Failed to list Google Drive images"
    )
    return []
  }
}

// ---------------------------------------------------------------------------
// Download + optimize
// ---------------------------------------------------------------------------

const MAX_WIDTH = 1536
const MAX_HEIGHT = 1024
const WEBP_QUALITY = 80

export async function downloadImage(
  fileId: string,
  log?: ImageLogger
): Promise<{ filePath: string; fileName: string } | null> {
  const generatedImageDir = process.env.ORCHESTRATOR_GENERATED_IMAGE_DIR ?? resolve(process.cwd(), "../../.data/generated-images")
  const fileName = `gdrive_${fileId}.webp`
  const filePath = resolve(generatedImageDir, fileName)

  // Try disk cache first — no need for existsSync, just attempt the read
  try {
    await readFile(filePath)
    return { filePath, fileName }
  } catch {
    // Not cached, proceed to download
  }

  const drive = getDriveClient()
  if (!drive) return null

  try {
    const res = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" }
    )
    const rawBytes = Buffer.from(res.data as ArrayBuffer)
    if (rawBytes.byteLength === 0) return null

    // Optimize: auto-orient first (before resize for correct dimensions), then resize + WebP
    const optimized = await sharp(rawBytes)
      .rotate() // auto-orient based on EXIF before resize
      .resize({ width: MAX_WIDTH, height: MAX_HEIGHT, fit: "inside", withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer()

    await mkdir(generatedImageDir, { recursive: true })
    await writeFile(filePath, optimized)

    log?.info(
      { event: "gdrive_download", fileId, originalSize: rawBytes.byteLength, optimizedSize: optimized.byteLength },
      `Downloaded and optimized Drive image ${fileId}`
    )

    return { filePath, fileName }
  } catch (err) {
    log?.warn(
      { event: "gdrive_download_error", fileId, error: err instanceof Error ? err.message : String(err) },
      "Failed to download Google Drive image"
    )
    return null
  }
}
