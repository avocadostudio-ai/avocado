import dotenv from "dotenv"
import { resolve } from "node:path"
import { existsSync } from "node:fs"

const envPath = resolve(process.cwd(), "../../.env")
if (existsSync(envPath)) dotenv.config({ path: envPath })

import { google } from "googleapis"

const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON!
const key = JSON.parse(raw) as { client_email: string; private_key: string }
const auth = new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes: ["https://www.googleapis.com/auth/drive.readonly"] })
const drive = google.drive({ version: "v3", auth })

const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID!.trim()

// List ALL items including folders
const res = await drive.files.list({
  q: `'${folderId}' in parents and trashed = false`,
  fields: "files(id, name, mimeType)",
  pageSize: 50
})

console.log(`Items in root folder (${folderId}):`)
for (const f of res.data.files ?? []) {
  const icon = f.mimeType === "application/vnd.google-apps.folder" ? "📁" : "📄"
  console.log(`  ${icon} ${f.name} (${f.mimeType}) [${f.id}]`)
}
if (!res.data.files?.length) console.log("  (empty)")

// Check subfolders for images
const folders = (res.data.files ?? []).filter(f => f.mimeType === "application/vnd.google-apps.folder")
for (const folder of folders) {
  const sub = await drive.files.list({
    q: `'${folder.id}' in parents and trashed = false`,
    fields: "files(id, name, mimeType)",
    pageSize: 10
  })
  console.log(`\nItems in subfolder "${folder.name}" (${folder.id}):`)
  for (const f of sub.data.files ?? []) {
    const icon = f.mimeType?.startsWith("image/") ? "🖼️" : f.mimeType === "application/vnd.google-apps.folder" ? "📁" : "📄"
    console.log(`  ${icon} ${f.name} (${f.mimeType})`)
  }
  if (!sub.data.files?.length) console.log("  (empty)")
}
