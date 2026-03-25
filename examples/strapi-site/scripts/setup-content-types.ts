/**
 * OPTIONAL STARTER KIT: Generate Strapi schema files from the default block set.
 *
 * Skip this if you have an existing Strapi schema — instead, write your own
 * fetch adapter (lib/strapi.fetch.ts) and block manifest (getManifest in the
 * editor API route). See villa-puravida-web for a custom-blocks example.
 *
 * Original description:
 * Setup script that generates Strapi Components + Dynamic Zone schema files.
 *
 * Follows Strapi best practices:
 * - Each block type → a Strapi Component (in the "blocks" category)
 * - Page → uses a Dynamic Zone field that accepts any block component
 * - No separate collection types for blocks
 *
 * Usage:
 *   STRAPI_PROJECT=/path/to/strapi-backend pnpm strapi:setup
 */

import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { getAllBlockMeta, type FieldKind } from "@ai-site-editor/shared"

const STRAPI_PROJECT = process.env.STRAPI_PROJECT?.trim()
if (!STRAPI_PROJECT) {
  console.error("Set STRAPI_PROJECT to the path of your Strapi backend project.")
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
      const valid = options?.every((v) => /^[a-zA-Z]/.test(v) && /^[a-zA-Z0-9_-]+$/.test(v))
      if (valid && options?.length) return { type: "enumeration", enum: options }
      return { type: "string" }
    }
    case "headingLevel": return { type: "string" }
    default: return { type: "string" }
  }
}

const allMeta = getAllBlockMeta()
const componentsDir = resolve(STRAPI_PROJECT, "src/components/blocks")
const apiDir = resolve(STRAPI_PROJECT, "src/api")

// Clean old block collection types (from previous setup)
console.log("Cleaning old block collection types...")
for (const blockType of Object.keys(allMeta)) {
  const oldDir = resolve(apiDir, blockType.toLowerCase())
  if (existsSync(oldDir)) {
    rmSync(oldDir, { recursive: true })
    console.log(`  Removed: api/${blockType.toLowerCase()}/`)
  }
}

// Generate Strapi Components (one per block type)
console.log("\nGenerating block components...")
mkdirSync(componentsDir, { recursive: true })
const componentNames: string[] = []

for (const [blockType, meta] of Object.entries(allMeta)) {
  const componentName = blockType.toLowerCase()
  componentNames.push(componentName)

  const attrs: Record<string, Record<string, unknown>> = {}

  for (const [key, fieldMeta] of Object.entries(meta.fields)) {
    if (key === "headingLevel") continue
    attrs[key] = fieldKindToStrapiAttr(fieldMeta.kind, fieldMeta.options)
  }

  if (meta.listFields) {
    for (const key of Object.keys(meta.listFields)) {
      attrs[key] = { type: "json" }
    }
  }

  const schema = {
    collectionName: `components_blocks_${componentName}s`,
    info: {
      displayName: meta.displayName,
      description: meta.description ?? `${meta.displayName} block component`,
      icon: "apps",
    },
    attributes: attrs,
  }

  writeFileSync(
    resolve(componentsDir, `${componentName}.json`),
    JSON.stringify(schema, null, 2) + "\n"
  )
  console.log(`  Created component: blocks.${componentName}`)
}

// Generate Page content type with Dynamic Zone
console.log("\nGenerating Page content type...")
const pageDir = resolve(apiDir, "page/content-types/page")
mkdirSync(pageDir, { recursive: true })

const pageSchema = {
  kind: "collectionType",
  collectionName: "pages",
  info: {
    singularName: "page",
    pluralName: "pages",
    displayName: "Page",
    description: "A website page with block-based content",
  },
  options: { draftAndPublish: true },
  attributes: {
    slug: { type: "string", unique: true, required: true },
    title: { type: "string", required: true },
    pageId: { type: "string" },
    blocks: {
      type: "dynamiczone",
      components: componentNames.map((name) => `blocks.${name}`),
    },
    pageMeta: { type: "json" },
  },
}

writeFileSync(resolve(pageDir, "schema.json"), JSON.stringify(pageSchema, null, 2) + "\n")

// Ensure route/controller/service files exist
for (const subdir of ["routes", "controllers", "services"]) {
  const dir = resolve(apiDir, "page", subdir)
  mkdirSync(dir, { recursive: true })
  const file = resolve(dir, `page.ts`)
  if (!existsSync(file)) {
    writeFileSync(file, `import { factories } from '@strapi/strapi';\n\nexport default factories.createCore${{
      routes: "Router", controllers: "Controller", services: "Service"
    }[subdir]}('api::page.page');\n`)
  }
}

console.log("  Created: page (with Dynamic Zone)")

// Site config (single type) — unchanged
console.log("\nGenerating SiteConfig...")
const configDir = resolve(apiDir, "site-config/content-types/site-config")
mkdirSync(configDir, { recursive: true })
writeFileSync(resolve(configDir, "schema.json"), JSON.stringify({
  kind: "singleType",
  collectionName: "site_configs",
  info: { singularName: "site-config", pluralName: "site-configs", displayName: "Site Config" },
  options: { draftAndPublish: false },
  attributes: {
    name: { type: "string" },
    logo: { type: "string" },
    navLabels: { type: "json" },
  },
}, null, 2) + "\n")
console.log("  Created: site-config")

console.log(`\nDone! Generated ${componentNames.length} components + Page (Dynamic Zone) + SiteConfig`)
console.log(`\nRestart Strapi: cd ${STRAPI_PROJECT} && npm run develop`)
