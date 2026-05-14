import { defineConfig } from "@playwright/test"

const EDITOR_URL = process.env.EDITOR_URL ?? "http://localhost:4100"

// E2E suite for the editor preview-bridge selector. These tests require the
// full dev stack to be running (orchestrator :4200, editor :4100, site :3000).
// Start it via `pnpm dev:start` (devctl) or `pnpm dev` before running.
export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "line" : "list",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: EDITOR_URL,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
  },
})
