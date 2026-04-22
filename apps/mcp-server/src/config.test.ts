import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { loadConfig } from "./config.ts"

describe("loadConfig", () => {
  it("requires AVOCADO_SITE_ID", () => {
    assert.throws(() => loadConfig({}), /AVOCADO_SITE_ID/)
  })

  it("defaults session to 'dev' and orchestratorUrl to localhost", () => {
    const config = loadConfig({ AVOCADO_SITE_ID: "avocado-stories" })
    assert.equal(config.siteId, "avocado-stories")
    assert.equal(config.session, "dev")
    assert.equal(config.orchestratorUrl, "http://localhost:4200")
  })

  it("strips trailing slashes from ORCHESTRATOR_URL", () => {
    const config = loadConfig({ AVOCADO_SITE_ID: "x", ORCHESTRATOR_URL: "https://example.com///" })
    assert.equal(config.orchestratorUrl, "https://example.com")
  })

  it("uses provided session + orchestratorUrl", () => {
    const config = loadConfig({
      AVOCADO_SITE_ID: "x",
      AVOCADO_SESSION: "my-sess",
      ORCHESTRATOR_URL: "https://api.example.com",
    })
    assert.equal(config.session, "my-sess")
    assert.equal(config.orchestratorUrl, "https://api.example.com")
  })
})
