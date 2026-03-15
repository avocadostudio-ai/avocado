import { describe, it, beforeEach, afterEach, mock } from "node:test"
import assert from "node:assert/strict"
import { isGdriveConfigured, resetDriveClient } from "./gdrive-client.js"

describe("gdrive-client", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    resetDriveClient()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    resetDriveClient()
  })

  describe("isGdriveConfigured", () => {
    it("returns false when GOOGLE_DRIVE_FOLDER_ID is not set", () => {
      delete process.env.GOOGLE_DRIVE_FOLDER_ID
      delete process.env.GOOGLE_API_KEY
      delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON
      assert.equal(isGdriveConfigured(), false)
    })

    it("returns false when folder ID is set but no auth", () => {
      process.env.GOOGLE_DRIVE_FOLDER_ID = "abc123"
      delete process.env.GOOGLE_API_KEY
      delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON
      assert.equal(isGdriveConfigured(), false)
    })

    it("returns true when folder ID and API key are set", () => {
      process.env.GOOGLE_DRIVE_FOLDER_ID = "abc123"
      process.env.GOOGLE_API_KEY = "AIza_test"
      assert.equal(isGdriveConfigured(), true)
    })

    it("returns true when folder ID and service account are set", () => {
      process.env.GOOGLE_DRIVE_FOLDER_ID = "abc123"
      process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON = '{"type":"service_account","client_email":"test@test.iam.gserviceaccount.com","private_key":"-----BEGIN RSA PRIVATE KEY-----\\ntest\\n-----END RSA PRIVATE KEY-----\\n"}'
      assert.equal(isGdriveConfigured(), true)
    })
  })
})
