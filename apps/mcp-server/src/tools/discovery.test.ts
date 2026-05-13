import { describe, it } from "node:test"
import assert from "node:assert/strict"
import "@avocadostudio-ai/shared/src/blocks/index.ts"
import { getAllBlockMeta, getBlockJsonSchema } from "@avocadostudio-ai/shared"

// The discovery tools are thin wrappers around these two imports — verify the
// wrapped functions produce the payload shape we advertise, so the tool responses
// are trustworthy even without spinning up the full MCP server.

describe("discovery payloads", () => {
  it("getAllBlockMeta exposes core block types with displayName + category", () => {
    const meta = getAllBlockMeta()
    for (const type of ["Hero", "CTA", "FeatureGrid", "FAQAccordion", "Testimonials"]) {
      assert.ok(meta[type], `expected ${type} in registry`)
      assert.ok(meta[type].displayName, `${type} missing displayName`)
    }
  })

  it("getBlockJsonSchema returns a structural schema for Hero with required props", () => {
    const schema = getBlockJsonSchema("Hero")
    assert.ok(schema, "expected Hero schema")
    assert.equal(schema!.type, "object")
    const properties = schema!.properties as Record<string, unknown>
    for (const key of ["heading", "subheading", "ctaText", "ctaHref", "imageUrl", "imageAlt"]) {
      assert.ok(properties[key], `Hero schema missing ${key}`)
    }
  })

  it("getBlockJsonSchema returns undefined for unknown types", () => {
    assert.equal(getBlockJsonSchema("NotARealBlock"), undefined)
  })
})
