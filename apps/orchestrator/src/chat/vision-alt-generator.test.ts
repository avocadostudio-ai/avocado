import test from "node:test"
import assert from "node:assert/strict"
import { parseAltPathForOp } from "./vision-alt-generator.js"

test("parseAltPathForOp: top-level imageAlt → props key", () => {
  assert.deepEqual(parseAltPathForOp("imageAlt"), { kind: "props", key: "imageAlt" })
})

test("parseAltPathForOp: alt → props key", () => {
  assert.deepEqual(parseAltPathForOp("alt"), { kind: "props", key: "alt" })
})

test("parseAltPathForOp: cards[0].imageAlt → update_item", () => {
  assert.deepEqual(
    parseAltPathForOp("cards[0].imageAlt"),
    { kind: "item", listKey: "cards", index: 0, itemKey: "imageAlt" }
  )
})

test("parseAltPathForOp: features[12].imageAlt → update_item with parsed index", () => {
  assert.deepEqual(
    parseAltPathForOp("features[12].imageAlt"),
    { kind: "item", listKey: "features", index: 12, itemKey: "imageAlt" }
  )
})

test("parseAltPathForOp: nested deeper path → null (falls back to planner)", () => {
  assert.equal(parseAltPathForOp("sections[0].cards[2].imageAlt"), null)
})

test("parseAltPathForOp: invalid path with spaces → null", () => {
  assert.equal(parseAltPathForOp("alt text"), null)
})

test("parseAltPathForOp: dotted but non-array path → null", () => {
  assert.equal(parseAltPathForOp("hero.imageAlt"), null)
})
