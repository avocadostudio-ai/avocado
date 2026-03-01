import test from "node:test"
import assert from "node:assert/strict"
import { isChatStrictPrimaryOpMode } from "./chat/planner.js"

test("isChatStrictPrimaryOpMode reads env at call time", () => {
  const original = process.env.CHAT_STRICT_PRIMARY_OP_MODE

  process.env.CHAT_STRICT_PRIMARY_OP_MODE = "1"
  assert.equal(isChatStrictPrimaryOpMode(), true)

  process.env.CHAT_STRICT_PRIMARY_OP_MODE = "off"
  assert.equal(isChatStrictPrimaryOpMode(), false)

  process.env.CHAT_STRICT_PRIMARY_OP_MODE = "true"
  assert.equal(isChatStrictPrimaryOpMode(), true)

  if (original === undefined) {
    delete process.env.CHAT_STRICT_PRIMARY_OP_MODE
  } else {
    process.env.CHAT_STRICT_PRIMARY_OP_MODE = original
  }
})

