/**
 * One-time setup script to create the required content types in Contentful.
 *
 * Usage:
 *   cp .env.example .env.local  # fill in credentials
 *   pnpm contentful:setup
 *
 * This creates two content types:
 *   - page: stores PageDoc data (slug, title, blocks as JSON, meta as JSON)
 *   - siteConfig: stores SiteConfig data (name, logo, navLabels as JSON)
 */

import contentfulManagement from "contentful-management"
const { createClient } = contentfulManagement

const spaceId = process.env.CONTENTFUL_SPACE_ID
const managementToken = process.env.CONTENTFUL_MANAGEMENT_TOKEN
const environmentId = process.env.CONTENTFUL_ENVIRONMENT ?? "master"

if (!spaceId || !managementToken) {
  console.error("Set CONTENTFUL_SPACE_ID and CONTENTFUL_MANAGEMENT_TOKEN before running this script.")
  process.exit(1)
}

const client = createClient({ accessToken: managementToken })

async function main() {
  const space = await client.getSpace(spaceId!)
  const env = await space.getEnvironment(environmentId)

  // --- Content type: page ---
  console.log("Creating content type: page ...")
  try {
    let pageType = await env.createContentTypeWithId("page", {
      name: "Page",
      description: "A website page with block-based content (managed by AI Site Editor)",
      displayField: "title",
      fields: [
        {
          id: "slug",
          name: "Slug",
          type: "Symbol",
          required: true,
          validations: [{ unique: true }],
        },
        {
          id: "title",
          name: "Title",
          type: "Symbol",
          required: true,
        },
        {
          id: "pageId",
          name: "Page ID",
          type: "Symbol",
          required: true,
        },
        {
          id: "blocks",
          name: "Blocks",
          type: "Object",
          required: true,
        },
        {
          id: "meta",
          name: "Meta",
          type: "Object",
          required: false,
        },
        {
          id: "updatedAt",
          name: "Updated At",
          type: "Date",
          required: true,
        },
      ],
    })
    pageType = await pageType.publish()
    console.log("  Published content type: page")
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes("already exists")) {
      console.log("  Content type 'page' already exists — skipping.")
    } else {
      throw err
    }
  }

  // --- Content type: siteConfig ---
  console.log("Creating content type: siteConfig ...")
  try {
    let configType = await env.createContentTypeWithId("siteConfig", {
      name: "Site Config",
      description: "Site-wide configuration (name, logo, nav labels)",
      displayField: "configKey",
      fields: [
        {
          id: "configKey",
          name: "Config Key",
          type: "Symbol",
          required: true,
          validations: [{ unique: true }],
        },
        {
          id: "name",
          name: "Site Name",
          type: "Symbol",
          required: false,
        },
        {
          id: "logo",
          name: "Logo URL",
          type: "Symbol",
          required: false,
        },
        {
          id: "navLabels",
          name: "Nav Labels",
          type: "Object",
          required: false,
        },
      ],
    })
    configType = await configType.publish()
    console.log("  Published content type: siteConfig")
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes("already exists")) {
      console.log("  Content type 'siteConfig' already exists — skipping.")
    } else {
      throw err
    }
  }

  console.log("\nDone! Content types are ready.")
  console.log("Next steps:")
  console.log("  1. Create a Contentful Delivery API token")
  console.log("  2. Set CONTENTFUL_DELIVERY_TOKEN in .env.local")
  console.log("  3. Run: pnpm dev")
}

main().catch((err) => {
  console.error("Setup failed:", err)
  process.exit(1)
})
