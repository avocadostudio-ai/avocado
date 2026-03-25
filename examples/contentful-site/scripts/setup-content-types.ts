/**
 * OPTIONAL STARTER KIT: Create Contentful content types from the default block set.
 *
 * Skip this if you have an existing Contentful schema — instead, write your own
 * fetch adapter (lib/contentful.ts) and block manifest (getManifest in the
 * editor API route). See villa-puravida-web for a custom-blocks example.
 *
 * Original description:
 * Setup script to create Contentful content types from the block registry.
 *
 * Creates one content type per block (20 blocks) + Page + SiteConfig = 22 total.
 * Image fields use Contentful Assets (Media) for native image management.
 *
 * Usage:
 *   CONTENTFUL_SPACE_ID=xxx CONTENTFUL_MANAGEMENT_TOKEN=xxx pnpm contentful:setup
 */

import contentfulManagement from "contentful-management"
import { getAllBlockMeta, type FieldKind } from "@ai-site-editor/shared"

// Ensure all blocks are registered
import "@ai-site-editor/shared"

const { createClient } = contentfulManagement

const spaceId = process.env.CONTENTFUL_SPACE_ID
const managementToken = process.env.CONTENTFUL_MANAGEMENT_TOKEN
const environmentId = process.env.CONTENTFUL_ENVIRONMENT ?? "master"

if (!spaceId || !managementToken) {
  console.error("Set CONTENTFUL_SPACE_ID and CONTENTFUL_MANAGEMENT_TOKEN before running this script.")
  process.exit(1)
}

const client = createClient({ accessToken: managementToken })

// Contentful field definition (supports Link and Array items)
type CfField = {
  id: string
  name: string
  type: string
  required: boolean
  validations?: unknown[]
  linkType?: string
  items?: { type: string; linkType?: string; validations?: unknown[] }
}

function buildBlockFields(blockType: string, meta: ReturnType<typeof getAllBlockMeta>[string]): CfField[] {
  const fields: CfField[] = []

  for (const [key, fieldMeta] of Object.entries(meta.fields)) {
    if (key === "headingLevel") continue

    // Image fields → Contentful Asset (Media) link
    if (fieldMeta.kind === "image") {
      fields.push({
        id: key,
        name: fieldMeta.label ?? key,
        type: "Link",
        linkType: "Asset",
        required: fieldMeta.required ?? false,
      })
      continue
    }

    const field: CfField = {
      id: key,
      name: fieldMeta.label ?? key,
      type: mapKindToType(fieldMeta.kind),
      required: fieldMeta.required ?? false,
    }
    if (fieldMeta.kind === "enum" && fieldMeta.options?.length) {
      field.validations = [{ in: fieldMeta.options }]
    }
    fields.push(field)
  }

  // List fields
  if (meta.listFields) {
    for (const [key, listMeta] of Object.entries(meta.listFields)) {
      // CardGrid.cards → Array of references to blockCard entries
      if (blockType === "CardGrid" && key === "cards") {
        fields.push({
          id: key,
          name: listMeta.label ?? key,
          type: "Array",
          required: false,
          items: {
            type: "Link",
            linkType: "Entry",
            validations: [{ linkContentType: ["blockCard"] }],
          },
        })
      } else {
        // Other list fields → JSON Object
        fields.push({
          id: key,
          name: listMeta.label ?? key,
          type: "Object",
          required: false,
        })
      }
    }
  }

  return fields
}

function mapKindToType(kind: FieldKind): string {
  switch (kind) {
    case "richtext": return "Text"
    case "number": return "Number"
    default: return "Symbol"
  }
}

function buildPageFields(blockTypeIds: string[]): CfField[] {
  return [
    { id: "slug", name: "Slug", type: "Symbol", required: true, validations: [{ unique: true }] },
    { id: "title", name: "Title", type: "Symbol", required: true },
    {
      id: "blocks",
      name: "Blocks",
      type: "Array",
      required: false,
      items: {
        type: "Link",
        linkType: "Entry",
        validations: [{ linkContentType: blockTypeIds }],
      },
    },
    { id: "pageId", name: "Page ID", type: "Symbol", required: true },
    { id: "meta", name: "Meta", type: "Object", required: false },
    { id: "updatedAt", name: "Updated At", type: "Date", required: true },
  ]
}

type CfEnv = Awaited<ReturnType<Awaited<ReturnType<typeof client.getSpace>>["getEnvironment"]>>

async function createOrUpdateContentType(
  env: CfEnv,
  id: string,
  name: string,
  description: string,
  displayField: string,
  fields: CfField[]
) {
  try {
    const existing = await env.getContentType(id)
    existing.name = name
    existing.description = description
    existing.displayField = displayField
    existing.fields = fields as typeof existing.fields
    const updated = await existing.update()
    await updated.publish()
    console.log(`  Updated: ${id}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes("NotFound") || message.includes("404")) {
      let ct = await env.createContentTypeWithId(id, {
        name,
        description,
        displayField,
        fields: fields as Parameters<typeof env.createContentTypeWithId>[1]["fields"],
      })
      ct = await ct.publish()
      console.log(`  Created: ${id}`)
    } else {
      throw err
    }
  }
}

async function main() {
  const space = await client.getSpace(spaceId!)
  const env = await space.getEnvironment(environmentId)
  const allMeta = getAllBlockMeta()

  // --- Block content types ---
  console.log("Setting up block content types...")
  const blockTypeIds: string[] = []

  for (const [blockType, meta] of Object.entries(allMeta)) {
    const ctId = `block${blockType}`
    blockTypeIds.push(ctId)

    const fields = buildBlockFields(blockType, meta)
    if (fields.length === 0) {
      console.log(`  Skipping ${blockType} — no fields`)
      continue
    }

    // Pick first Symbol field as displayField
    const displayField = fields.find((f) => f.type === "Symbol")?.id ?? fields[0].id

    await createOrUpdateContentType(
      env,
      ctId,
      meta.displayName,
      meta.description ?? `${meta.displayName} block`,
      displayField,
      fields
    )
  }

  // --- Page content type ---
  console.log("\nSetting up Page content type...")
  try {
    const existing = await env.getContentType("page")
    existing.name = "Page"
    existing.description = "A website page with ordered block references"
    existing.displayField = "title"
    existing.fields = buildPageFields(blockTypeIds) as typeof existing.fields
    const updated = await existing.update()
    await updated.publish()
    console.log("  Updated: page")
  } catch {
    let ct = await env.createContentTypeWithId("page", {
      name: "Page",
      description: "A website page with ordered block references",
      displayField: "title",
      fields: buildPageFields(blockTypeIds) as Parameters<typeof env.createContentTypeWithId>[1]["fields"],
    })
    ct = await ct.publish()
    console.log("  Created: page")
  }

  // --- SiteConfig content type ---
  console.log("\nSetting up SiteConfig content type...")
  await createOrUpdateContentType(env, "siteConfig", "Site Config", "Site-wide configuration", "configKey", [
    { id: "configKey", name: "Config Key", type: "Symbol", required: true, validations: [{ unique: true }] },
    { id: "name", name: "Site Name", type: "Symbol", required: false },
    { id: "logo", name: "Logo URL", type: "Symbol", required: false },
    { id: "navLabels", name: "Nav Labels", type: "Object", required: false },
  ])

  console.log(`\nDone! ${blockTypeIds.length + 2} content types ready.`)
  console.log(`Free tier: ${blockTypeIds.length + 2}/25 used.`)
}

main().catch((err) => {
  console.error("Setup failed:", err)
  process.exit(1)
})
