import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { gdriveBrowseManifest, gdriveBrowseHandler } from "./gdrive-browse.js"
import { resetDriveClient } from "../../image/gdrive-client.js"

describe("gdrive-browse tool", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    resetDriveClient()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    resetDriveClient()
  })

  it("has correct manifest shape", () => {
    assert.equal(gdriveBrowseManifest.name, "gdrive.browse")
    assert.equal(gdriveBrowseManifest.capability, "read")
    assert.equal(gdriveBrowseManifest.idempotent, true)
    assert.ok(gdriveBrowseManifest.inputSchema)
    assert.ok(gdriveBrowseManifest.outputSchema)
  })

  it("returns empty items when not configured", async () => {
    delete process.env.GOOGLE_DRIVE_FOLDER_ID
    delete process.env.GOOGLE_API_KEY
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON
    const result = await gdriveBrowseHandler({
      input: { query: "test" },
      context: { siteId: "test", sessionId: "s1", traceId: "t1", plannerProvider: "demo" },
      manifest: gdriveBrowseManifest
    }) as { items: unknown[] }
    assert.ok(Array.isArray(result.items))
    assert.equal(result.items.length, 0)
  })

  it("output schema requires items array", () => {
    const schema = gdriveBrowseManifest.outputSchema as Record<string, unknown>
    assert.equal(schema.type, "object")
    const props = schema.properties as Record<string, { type: string }>
    assert.ok(props.items)
    assert.equal(props.items.type, "array")
  })
})
