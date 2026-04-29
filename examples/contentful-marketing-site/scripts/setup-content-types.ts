/**
 * Provision the Contentful marketing-template content model into a fresh space.
 *
 * Creates 12 content types modeled after contentful/template-marketing-webapp-nextjs:
 *   page, componentHeroBanner, componentDuplex, componentInfoBlock, componentCta,
 *   componentQuote, componentTextBlock, topicPerson, topicProduct,
 *   topicBusinessInfo, componentProductTable, componentFooter
 *
 * Also seeds a single "home" page with a HeroBanner + one CTA so the editor
 * has content to load on first run.
 *
 * Usage:
 *   CONTENTFUL_SPACE_ID=xxx CONTENTFUL_MANAGEMENT_TOKEN=xxx \
 *     pnpm --filter contentful-marketing-site contentful:setup
 */

import contentfulManagement from "contentful-management"

const spaceId = process.env.CONTENTFUL_SPACE_ID
const managementToken = process.env.CONTENTFUL_MANAGEMENT_TOKEN
const environmentId = process.env.CONTENTFUL_ENVIRONMENT ?? "master"
const LOCALE = "en-US"

if (!spaceId || !managementToken) {
  console.error("Set CONTENTFUL_SPACE_ID and CONTENTFUL_MANAGEMENT_TOKEN before running.")
  process.exit(1)
}

const { createClient } = contentfulManagement
const client = createClient({ accessToken: managementToken })

type CfField = {
  id: string
  name: string
  type: string
  required?: boolean
  localized?: boolean
  validations?: unknown[]
  linkType?: string
  items?: { type: string; linkType?: string; validations?: unknown[] }
}

const PALETTE_OPTIONS = [
  "palette-1. White (#FFFFFF)",
  "palette-2. White Smoke (#FCFCFC)",
  "palette-3. Light Gray (#F4F4F4)",
  "palette-4. Gray (#EAEAEA)",
  "palette-5. Steel Gray (#BBBBBB)",
  "palette-6. Dark Gray (#797979)",
  "palette-7. Black (#000000)",
]

type CtDef = {
  id: string
  name: string
  description: string
  displayField: string
  fields: CfField[]
}

// Field helpers
const sym = (id: string, name: string, required = false): CfField => ({ id, name, type: "Symbol", required })
const text = (id: string, name: string): CfField => ({ id, name, type: "Text" })
const richText = (id: string, name: string): CfField => ({ id, name, type: "RichText" })
const bool = (id: string, name: string): CfField => ({ id, name, type: "Boolean" })
const assetLink = (id: string, name: string): CfField => ({ id, name, type: "Link", linkType: "Asset" })
const entryLink = (id: string, name: string, contentTypes?: string[]): CfField => ({
  id,
  name,
  type: "Link",
  linkType: "Entry",
  validations: contentTypes ? [{ linkContentType: contentTypes }] : [],
})
const entryArray = (id: string, name: string, contentTypes?: string[]): CfField => ({
  id,
  name,
  type: "Array",
  items: {
    type: "Link",
    linkType: "Entry",
    validations: contentTypes ? [{ linkContentType: contentTypes }] : [],
  },
})
const paletteField = (): CfField => ({
  id: "colorPalette",
  name: "Color palette",
  type: "Symbol",
  validations: [{ in: PALETTE_OPTIONS }],
})

// -----------------------------------------------------------------------------
// Content type definitions (ordered so that refs resolve correctly on create)
// -----------------------------------------------------------------------------

// Forward references — componentFooter.menuItems → page, page.content/topSection
// → mixed. We define standalone types first, then types that reference them,
// then page last.

const leafTypes: CtDef[] = [
  {
    id: "componentHeroBanner",
    name: "Component — Hero Banner",
    description: "Full-width hero with headline, body, image and CTA",
    displayField: "headline",
    fields: [
      sym("headline", "Headline", true),
      richText("bodyText", "Body text"),
      sym("ctaText", "CTA text"),
      // targetPage → page (resolved on create via second pass to avoid chicken/egg)
      bool("heroSize", "Hero size (true=full screen)"),
      bool("imageStyle", "Image style (true=partial)"),
      paletteField(),
      assetLink("image", "Image"),
    ],
  },
  {
    id: "componentDuplex",
    name: "Component — Duplex",
    description: "Two-column image + text section",
    displayField: "headline",
    fields: [
      sym("headline", "Headline", true),
      richText("bodyText", "Body text"),
      sym("ctaText", "CTA text"),
      bool("containerLayout", "Container layout (true=image right)"),
      paletteField(),
      assetLink("image", "Image"),
    ],
  },
  {
    id: "componentInfoBlock",
    name: "Component — Info Block",
    description: "Iconic info block",
    displayField: "headline",
    fields: [
      sym("headline", "Headline", true),
      sym("subline", "Subline"),
      richText("body", "Body"),
      { id: "icon", name: "Icon", type: "Symbol", validations: [{ in: ["markdown", "search", "help"] }] },
      paletteField(),
    ],
  },
  {
    id: "componentCta",
    name: "Component — CTA",
    description: "Call to action section",
    displayField: "headline",
    fields: [
      sym("headline", "Headline", true),
      sym("subline", "Subline"),
      sym("ctaText", "CTA text"),
      paletteField(),
      assetLink("image", "Background image"),
    ],
  },
  {
    id: "componentQuote",
    name: "Component — Quote",
    description: "Pull quote with optional image",
    displayField: "quote",
    fields: [
      richText("quote", "Quote"),
      bool("imageAlignment", "Image alignment (true=right)"),
      paletteField(),
      assetLink("image", "Image"),
    ],
  },
  {
    id: "componentTextBlock",
    name: "Component — Text Block",
    description: "Plain text section",
    displayField: "headline",
    fields: [
      sym("headline", "Headline", true),
      sym("subline", "Subline"),
      richText("body", "Body"),
    ],
  },
  {
    id: "topicPerson",
    name: "Topic — Person",
    description: "Person card",
    displayField: "name",
    fields: [
      sym("name", "Name", true),
      bool("cardStyle", "Card style (true=compact)"),
      richText("shortBio", "Short bio"),
      assetLink("avatar", "Avatar"),
    ],
  },
  {
    id: "topicProduct",
    name: "Topic — Product",
    description: "Product card",
    displayField: "name",
    fields: [
      sym("name", "Name", true),
      richText("description", "Description"),
      sym("pricing", "Pricing"),
      { id: "features", name: "Features", type: "Object" },
      assetLink("featuredImage", "Featured image"),
    ],
  },
  {
    id: "topicBusinessInfo",
    name: "Topic — Business Info",
    description: "Business info card",
    displayField: "name",
    fields: [
      sym("name", "Name", true),
      sym("shortDescription", "Short description"),
      richText("longDescription", "Long description"),
      assetLink("featuredImage", "Featured image"),
    ],
  },
  {
    id: "componentProductTable",
    name: "Component — Product Table",
    description: "Product comparison table",
    displayField: "headline",
    fields: [
      sym("headline", "Headline"),
      sym("subline", "Subline"),
      { id: "products", name: "Products", type: "Object" },
    ],
  },
  {
    id: "componentFooter",
    name: "Component — Footer",
    description: "Site footer",
    displayField: "copyright",
    fields: [
      sym("copyright", "Copyright"),
      { id: "menuItems", name: "Menu items", type: "Object" },
    ],
  },
]

// page references everything else, define last
const pageType: CtDef = {
  id: "page",
  name: "Page",
  description: "Marketing page",
  displayField: "pageName",
  fields: [
    sym("slug", "Slug", true),
    sym("pageName", "Page name", true),
    entryLink("topSection", "Top section", ["componentHeroBanner"]),
    entryArray("content", "Content", [
      "componentHeroBanner",
      "componentDuplex",
      "componentInfoBlock",
      "componentCta",
      "componentQuote",
      "componentTextBlock",
      "topicPerson",
      "topicProduct",
      "topicBusinessInfo",
      "componentProductTable",
    ]),
  ],
}

// -----------------------------------------------------------------------------
// Provisioning
// -----------------------------------------------------------------------------

type CfEnv = Awaited<ReturnType<Awaited<ReturnType<typeof client.getSpace>>["getEnvironment"]>>

async function upsertContentType(env: CfEnv, def: CtDef) {
  try {
    const existing = await env.getContentType(def.id)
    existing.name = def.name
    existing.description = def.description
    existing.displayField = def.displayField
    existing.fields = def.fields as typeof existing.fields
    const updated = await existing.update()
    await updated.publish()
    console.log(`  Updated: ${def.id}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("NotFound") || msg.includes("404")) {
      const created = await env.createContentTypeWithId(def.id, {
        name: def.name,
        description: def.description,
        displayField: def.displayField,
        fields: def.fields as Parameters<typeof env.createContentTypeWithId>[1]["fields"],
      })
      const published = await created.publish()
      console.log(`  Created: ${def.id}`)
      return published
    }
    throw err
  }
}

async function seedHomePage(env: CfEnv) {
  console.log("\nSeeding demo content...")

  // 1. Create a hero banner entry
  const heroFields = {
    headline: { [LOCALE]: "Built with Contentful + AI Site Editor" },
    bodyText: {
      [LOCALE]: {
        nodeType: "document",
        data: {},
        content: [
          {
            nodeType: "paragraph",
            data: {},
            content: [
              {
                nodeType: "text",
                value: "Edit this page in plain English. Changes publish back to your Contentful space.",
                marks: [],
                data: {},
              },
            ],
          },
        ],
      },
    },
    ctaText: { [LOCALE]: "Get started" },
    heroSize: { [LOCALE]: true },
    imageStyle: { [LOCALE]: false },
    colorPalette: { [LOCALE]: PALETTE_OPTIONS[0] },
  }

  let heroId: string
  try {
    const existing = await env.getEntry("demo_hero_banner")
    existing.fields = heroFields
    const updated = await existing.update()
    await updated.publish()
    heroId = updated.sys.id
    console.log("  Updated: demo_hero_banner")
  } catch {
    const created = await env.createEntryWithId("componentHeroBanner", "demo_hero_banner", {
      fields: heroFields,
    })
    await created.publish()
    heroId = created.sys.id
    console.log("  Created: demo_hero_banner")
  }

  // 2. Create a CTA entry
  const ctaFields = {
    headline: { [LOCALE]: "Ready to see it live?" },
    subline: { [LOCALE]: "Point the editor at this space and start editing." },
    ctaText: { [LOCALE]: "Open editor" },
    colorPalette: { [LOCALE]: PALETTE_OPTIONS[2] },
  }

  let ctaId: string
  try {
    const existing = await env.getEntry("demo_cta")
    existing.fields = ctaFields
    const updated = await existing.update()
    await updated.publish()
    ctaId = updated.sys.id
    console.log("  Updated: demo_cta")
  } catch {
    const created = await env.createEntryWithId("componentCta", "demo_cta", { fields: ctaFields })
    await created.publish()
    ctaId = created.sys.id
    console.log("  Created: demo_cta")
  }

  // 3. Upsert the home page referencing those entries
  const pageFields = {
    slug: { [LOCALE]: "home" },
    pageName: { [LOCALE]: "Home" },
    topSection: { [LOCALE]: { sys: { type: "Link", linkType: "Entry", id: heroId } } },
    content: {
      [LOCALE]: [{ sys: { type: "Link", linkType: "Entry", id: ctaId } }],
    },
  }

  try {
    const existing = await env.getEntry("demo_home_page")
    existing.fields = pageFields
    const updated = await existing.update()
    await updated.publish()
    console.log("  Updated: demo_home_page")
  } catch {
    const created = await env.createEntryWithId("page", "demo_home_page", { fields: pageFields })
    await created.publish()
    console.log("  Created: demo_home_page")
  }
}

async function main() {
  const space = await client.getSpace(spaceId!)
  const env = await space.getEnvironment(environmentId)

  console.log("Setting up content types...")
  for (const def of leafTypes) {
    await upsertContentType(env, def)
  }
  await upsertContentType(env, pageType)

  await seedHomePage(env)

  console.log(`\nDone. ${leafTypes.length + 1} content types ready.`)
}

main().catch((err) => {
  console.error("Setup failed:", err)
  process.exit(1)
})
