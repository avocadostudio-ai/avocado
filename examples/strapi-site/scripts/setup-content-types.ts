/**
 * Setup script to create Strapi content types from the block registry.
 *
 * IMPORTANT: This only works when Strapi is running in development mode.
 * The Content-Type Builder API is disabled in production.
 *
 * Usage:
 *   STRAPI_URL=http://localhost:1337 STRAPI_API_TOKEN=xxx pnpm strapi:setup
 */

import { getAllBlockMeta, type FieldKind } from "@ai-site-editor/shared"
import "@ai-site-editor/shared"

const STRAPI_URL = process.env.STRAPI_URL?.trim().replace(/\/+$/, "") ?? "http://localhost:1337"
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN?.trim()

if (!STRAPI_TOKEN) {
  console.error("Set STRAPI_API_TOKEN before running this script.")
  process.exit(1)
}

function fieldKindToStrapiType(kind: FieldKind): string {
  switch (kind) {
    case "text": return "string"
    case "richtext": return "richtext"
    case "url": return "string"
    case "image": return "media"
    case "imageAlt": return "string"
    case "color": return "string"
    case "number": return "integer"
    case "enum": return "enumeration"
    case "headingLevel": return "string"
    default: return "string"
  }
}

type StrapiAttribute = {
  type: string
  enum?: string[]
  multiple?: boolean
  required?: boolean
  allowedTypes?: string[]
  relation?: string
  target?: string
}

function buildBlockAttributes(blockType: string, meta: ReturnType<typeof getAllBlockMeta>[string]): Record<string, StrapiAttribute> {
  const attrs: Record<string, StrapiAttribute> = {}

  // Custom field to track block type when reading back
  attrs._blockType = { type: "string" }

  for (const [key, fieldMeta] of Object.entries(meta.fields)) {
    if (key === "headingLevel") continue

    if (fieldMeta.kind === "image") {
      attrs[key] = { type: "media", multiple: false, allowedTypes: ["images"] }
    } else if (fieldMeta.kind === "enum" && fieldMeta.options?.length) {
      attrs[key] = { type: "enumeration", enum: fieldMeta.options }
    } else {
      attrs[key] = { type: fieldKindToStrapiType(fieldMeta.kind) }
    }
  }

  // List fields → JSON
  if (meta.listFields) {
    for (const key of Object.keys(meta.listFields)) {
      attrs[key] = { type: "json" }
    }
  }

  return attrs
}

async function strapiAdminFetch(path: string, options?: RequestInit) {
  const res = await fetch(`${STRAPI_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${STRAPI_TOKEN}`,
      ...options?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Strapi ${res.status}: ${body.slice(0, 300)}`)
  }
  return res.json()
}

function toStrapiPlural(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith("s")) return lower + "es"
  if (lower.endsWith("y") && !/[aeiou]y$/i.test(lower)) return lower.slice(0, -1) + "ies"
  return lower + "s"
}

async function main() {
  const allMeta = getAllBlockMeta()

  console.log("Setting up block content types...")

  for (const [blockType, meta] of Object.entries(allMeta)) {
    const singularName = blockType.toLowerCase()
    const pluralName = toStrapiPlural(blockType)
    const attrs = buildBlockAttributes(blockType, meta)

    try {
      await strapiAdminFetch("/content-type-builder/content-types", {
        method: "POST",
        body: JSON.stringify({
          contentType: {
            singularName,
            pluralName,
            displayName: meta.displayName,
            kind: "collectionType",
            draftAndPublish: true,
            attributes: attrs,
          },
        }),
      })
      console.log(`  Created: ${singularName}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes("already exists") || message.includes("409")) {
        console.log(`  Exists: ${singularName}`)
      } else {
        console.error(`  Failed: ${singularName} — ${message}`)
      }
    }
  }

  // Page content type
  console.log("\nSetting up Page content type...")
  try {
    await strapiAdminFetch("/content-type-builder/content-types", {
      method: "POST",
      body: JSON.stringify({
        contentType: {
          singularName: "page",
          pluralName: "pages",
          displayName: "Page",
          kind: "collectionType",
          draftAndPublish: true,
          attributes: {
            slug: { type: "string", unique: true, required: true },
            title: { type: "string", required: true },
            pageId: { type: "string" },
            meta: { type: "json" },
            // blocks relation would need to be added manually or via Dynamic Zone
          },
        },
      }),
    })
    console.log("  Created: page")
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes("already exists") || message.includes("409")) {
      console.log("  Exists: page")
    } else {
      console.error(`  Failed: page — ${message}`)
    }
  }

  // Site config (single type)
  console.log("\nSetting up SiteConfig...")
  try {
    await strapiAdminFetch("/content-type-builder/content-types", {
      method: "POST",
      body: JSON.stringify({
        contentType: {
          singularName: "site-config",
          pluralName: "site-configs",
          displayName: "Site Config",
          kind: "singleType",
          draftAndPublish: false,
          attributes: {
            name: { type: "string" },
            logo: { type: "string" },
            navLabels: { type: "json" },
          },
        },
      }),
    })
    console.log("  Created: site-config")
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes("already exists") || message.includes("409")) {
      console.log("  Exists: site-config")
    } else {
      console.error(`  Failed: site-config — ${message}`)
    }
  }

  console.log("\nDone! Content types ready.")
  console.log("Note: Strapi may restart automatically after creating content types.")
}

main().catch((err) => {
  console.error("Setup failed:", err)
  process.exit(1)
})
