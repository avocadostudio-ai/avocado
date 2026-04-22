import { test } from "node:test"
import assert from "node:assert/strict"
import { formatRelative } from "./restore.js"

test("formatRelative: empty input returns empty string", () => {
  assert.equal(formatRelative(undefined), "")
  assert.equal(formatRelative(""), "")
})

test("formatRelative: unparseable ISO returns empty string", () => {
  assert.equal(formatRelative("not-a-date"), "")
})

test("formatRelative: sub-minute returns 'just now'", () => {
  const now = new Date().toISOString()
  assert.equal(formatRelative(now), "just now")
})

test("formatRelative: minutes, hours, days", () => {
  const minutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
  const hoursAgo = new Date(Date.now() - 3 * 3600 * 1000).toISOString()
  const daysAgo = new Date(Date.now() - 4 * 86_400 * 1000).toISOString()
  assert.equal(formatRelative(minutesAgo), "5m ago")
  assert.equal(formatRelative(hoursAgo), "3h ago")
  assert.equal(formatRelative(daysAgo), "4d ago")
})
