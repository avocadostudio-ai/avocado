import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseEnvFile, resolveConfig } from "./config.js"

test("parseEnvFile: plain key=value", () => {
  assert.deepEqual(parseEnvFile("A=1\nB=hello"), { A: "1", B: "hello" })
})

test("parseEnvFile: skips blank lines and comments", () => {
  const input = ["# header", "", "A=1", "   # indented comment", "B=2", ""].join("\n")
  assert.deepEqual(parseEnvFile(input), { A: "1", B: "2" })
})

test("parseEnvFile: strips matching single and double quotes", () => {
  assert.deepEqual(
    parseEnvFile(`A="quoted"\nB='also'\nC=raw`),
    { A: "quoted", B: "also", C: "raw" },
  )
})

test("parseEnvFile: preserves = in values", () => {
  assert.deepEqual(parseEnvFile("URL=http://x?a=1&b=2"), { URL: "http://x?a=1&b=2" })
})

test("parseEnvFile: ignores malformed lines without =", () => {
  assert.deepEqual(parseEnvFile("A=1\nBADLINE\nB=2"), { A: "1", B: "2" })
})

test("resolveConfig: defaults when nothing is set", () => {
  const dir = mkdtempSync(join(tmpdir(), "avc-config-"))
  try {
    const original = { ...process.env }
    delete process.env.ORCHESTRATOR_URL
    delete process.env.AVC_SESSION
    delete process.env.AVC_SITE_ID
    delete process.env.NEXT_PUBLIC_DEFAULT_SITE_ID
    delete process.env.PUBLISH_TOKEN
    delete process.env.SITE_ORIGIN
    delete process.env.NEXT_PUBLIC_SITE_ORIGIN
    try {
      const cfg = resolveConfig({ cwd: dir })
      assert.equal(cfg.orchestrator, "http://localhost:4200")
      assert.equal(cfg.session, "dev")
      assert.equal(cfg.siteId, undefined)
      assert.equal(cfg.publishToken, undefined)
    } finally {
      Object.assign(process.env, original)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("resolveConfig: flags beat env beat .env.local", () => {
  const dir = mkdtempSync(join(tmpdir(), "avc-config-"))
  try {
    writeFileSync(
      join(dir, ".env.local"),
      [
        "ORCHESTRATOR_URL=http://from-file:4200",
        "NEXT_PUBLIC_DEFAULT_SITE_ID=from-file",
        "PUBLISH_TOKEN=token-from-file",
      ].join("\n"),
    )
    const original = { ...process.env }
    process.env.ORCHESTRATOR_URL = "http://from-env:4200"
    try {
      // env beats .env.local
      const fromEnv = resolveConfig({ cwd: dir })
      assert.equal(fromEnv.orchestrator, "http://from-env:4200")
      assert.equal(fromEnv.siteId, "from-file")
      assert.equal(fromEnv.publishToken, "token-from-file")

      // flags beat env
      const fromFlag = resolveConfig({ cwd: dir, orchestrator: "http://from-flag:9999" })
      assert.equal(fromFlag.orchestrator, "http://from-flag:9999")
    } finally {
      Object.assign(process.env, original)
      delete process.env.ORCHESTRATOR_URL
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("resolveConfig: strips trailing slashes from orchestrator URL", () => {
  const cfg = resolveConfig({ orchestrator: "http://localhost:4200///" })
  assert.equal(cfg.orchestrator, "http://localhost:4200")
})
