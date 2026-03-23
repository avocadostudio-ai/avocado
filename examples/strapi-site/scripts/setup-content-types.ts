/**
 * Setup script that generates Strapi content type schema files directly
 * into the Strapi project directory. Much faster than the Content-Type
 * Builder API (which restarts Strapi after each type).
 *
 * Usage:
 *   STRAPI_PROJECT=/path/to/strapi-backend pnpm strapi:setup
 *
 * After running, restart Strapi to pick up the new content types.
 */

import { writeFileSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { getAllBlockMeta, type FieldKind } from "@ai-site-editor/shared"
import "@ai-site-editor/shared"

const STRAPI_PROJECT = process.env.STRAPI_PROJECT?.trim()
if (!STRAPI_PROJECT) {
  console.error("Set STRAPI_PROJECT to the path of your Strapi backend project.")
  console.error("Example: STRAPI_PROJECT=/Users/you/strapi-backend pnpm strapi:setup")
  process.exit(1)
}

function fieldKindToStrapiAttr(kind: FieldKind, options?: string[]): Record<string, unknown> {
  switch (kind) {
    case "text": return { type: "string" }
    case "richtext": return { type: "richtext" }
    case "url": return { type: "string" }
    case "image": return { type: "media", multiple: false, allowedTypes: ["images"] }
    case "imageAlt": return { type: "string" }
    case "color": return { type: "string" }
    case "number": return { type: "integer" }
    case "enum": {
      // Strapi requires enum values to start with a letter and contain only [a-zA-Z0-9_-]
      const valid = options?.every((v) => /^[a-zA-Z]/.test(v) && /^[a-zA-Z0-9_-]+$/.test(v))
      if (valid && options?.length) return { type: "enumeration", enum: options }
      return { type: "string" } // fallback for values like "16:9"
    }
    case "headingLevel": return { type: "string" }
    default: return { type: "string" }
  }
}

function toStrapiPlural(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith("s")) return lower + "es"
  if (lower.endsWith("y") && !/[aeiou]y$/i.test(lower)) return lower.slice(0, -1) + "ies"
  return lower + "s"
}

function writeContentType(
  apiDir: string,
  singularName: string,
  displayName: string,
  kind: "collectionType" | "singleType",
  attributes: Record<string, Record<string, unknown>>,
  draftAndPublish = true
) {
  const dir = resolve(apiDir, singularName, "content-types", singularName)
  mkdirSync(dir, { recursive: true })

  const schema = {
    kind,
    collectionName: toStrapiPlural(singularName),
    info: {
      singularName,
      pluralName: toStrapiPlural(singularName),
      displayName,
    },
    options: { draftAndPublish },
    attributes,
  }

  writeFileSync(resolve(dir, "schema.json"), JSON.stringify(schema, null, 2) + "\n")

  // Also create empty route, controller, service files (Strapi expects them)
  const routeDir = resolve(apiDir, singularName, "routes")
  const controllerDir = resolve(apiDir, singularName, "controllers")
  const serviceDir = resolve(apiDir, singularName, "services")
  mkdirSync(routeDir, { recursive: true })
  mkdirSync(controllerDir, { recursive: true })
  mkdirSync(serviceDir, { recursive: true })

  if (kind === "collectionType") {
    writeFileSync(resolve(routeDir, `${singularName}.ts`),
      `import { factories } from '@strapi/strapi';\n\nexport default factories.createCoreRouter('api::${singularName}.${singularName}');\n`)
    writeFileSync(resolve(controllerDir, `${singularName}.ts`),
      `import { factories } from '@strapi/strapi';\n\nexport default factories.createCoreController('api::${singularName}.${singularName}');\n`)
    writeFileSync(resolve(serviceDir, `${singularName}.ts`),
      `import { factories } from '@strapi/strapi';\n\nexport default factories.createCoreService('api::${singularName}.${singularName}');\n`)
  }

  console.log(`  Created: ${singularName}`)
}

const apiDir = resolve(STRAPI_PROJECT, "src/api")
const allMeta = getAllBlockMeta()

console.log("Generating block content types...")

for (const [blockType, meta] of Object.entries(allMeta)) {
  const singularName = blockType.toLowerCase()
  const attrs: Record<string, Record<string, unknown>> = {
    blockType: { type: "string" },
  }

  for (const [key, fieldMeta] of Object.entries(meta.fields)) {
    if (key === "headingLevel") continue
    attrs[key] = fieldKindToStrapiAttr(fieldMeta.kind, fieldMeta.options)
  }

  if (meta.listFields) {
    for (const key of Object.keys(meta.listFields)) {
      attrs[key] = { type: "json" }
    }
  }

  writeContentType(apiDir, singularName, meta.displayName, "collectionType", attrs)
}

// Page content type
console.log("\nGenerating Page content type...")
writeContentType(apiDir, "page", "Page", "collectionType", {
  slug: { type: "string", unique: true, required: true },
  title: { type: "string", required: true },
  pageId: { type: "string" },
  blocks: { type: "json" },
  pageMeta: { type: "json" },
})

// Site config (single type)
console.log("\nGenerating SiteConfig...")
writeContentType(apiDir, "site-config", "Site Config", "singleType", {
  name: { type: "string" },
  logo: { type: "string" },
  navLabels: { type: "json" },
}, false)

console.log(`\nDone! Generated ${Object.keys(allMeta).length + 2} content types in ${apiDir}`)
console.log("\nRestart Strapi to pick up the new content types:")
console.log(`  cd ${STRAPI_PROJECT} && npm run develop`)
