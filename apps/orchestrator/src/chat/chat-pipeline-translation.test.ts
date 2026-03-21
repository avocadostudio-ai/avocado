import test from "node:test"
import assert from "node:assert/strict"
import {
  sanitizeMessageForPlanning,
  inferTranslationScopeFromMessage,
  normalizeVariationTypos
} from "./chat-pipeline-translation.js"

// ---------------------------------------------------------------------------
// sanitizeMessageForPlanning — smart quote normalization
// ---------------------------------------------------------------------------

test("sanitizeMessageForPlanning: normalizes smart single quotes", () => {
  const result = sanitizeMessageForPlanning("change the heading to \u2018Hello\u2019")
  assert.ok(result.includes("'Hello'"))
  assert.ok(!result.includes("\u2018"))
  assert.ok(!result.includes("\u2019"))
})

test("sanitizeMessageForPlanning: normalizes smart double quotes", () => {
  const result = sanitizeMessageForPlanning("set title to \u201CHello World\u201D")
  assert.ok(result.includes('"Hello World"'))
  assert.ok(!result.includes("\u201C"))
  assert.ok(!result.includes("\u201D"))
})

test("sanitizeMessageForPlanning: normalizes prime characters", () => {
  const result = sanitizeMessageForPlanning("change to \u2032test\u2032")
  assert.ok(result.includes("'test'"))
})

// ---------------------------------------------------------------------------
// sanitizeMessageForPlanning — typo normalization
// ---------------------------------------------------------------------------

test("sanitizeMessageForPlanning: fixes common typos", () => {
  assert.ok(sanitizeMessageForPlanning("add testomonials section").includes("testimonials"))
  assert.ok(sanitizeMessageForPlanning("update the fetures").includes("features"))
  assert.ok(sanitizeMessageForPlanning("change the heding").includes("heading"))
  assert.ok(sanitizeMessageForPlanning("ad a new block").includes("add a"))
  assert.ok(sanitizeMessageForPlanning("updte the hero").includes("update"))
})

// ---------------------------------------------------------------------------
// sanitizeMessageForPlanning — debug echo stripping
// ---------------------------------------------------------------------------

test("sanitizeMessageForPlanning: strips debug echo blocks", () => {
  const input = [
    "change the heading",
    "debug",
    "traceid: abc-123",
    "outcome: success",
    "intent: edit",
    "opcount: 1"
  ].join("\n")
  const result = sanitizeMessageForPlanning(input)
  assert.equal(result, "change the heading")
})

test("sanitizeMessageForPlanning: extracts prompt from debug echo", () => {
  const input = [
    "debug",
    "traceid: abc",
    "prompt: rewrite the hero heading",
    "outcome: success"
  ].join("\n")
  const result = sanitizeMessageForPlanning(input)
  assert.equal(result, "rewrite the hero heading")
})

test("sanitizeMessageForPlanning: strips performance awareness lines", () => {
  const input = [
    "change heading",
    "debug",
    "performance awareness detected",
    "semantic relevance and supports seo, accessibility, and conversion checks."
  ].join("\n")
  const result = sanitizeMessageForPlanning(input)
  assert.equal(result, "change heading")
})

test("sanitizeMessageForPlanning: passes through clean messages unchanged (modulo trim)", () => {
  assert.equal(sanitizeMessageForPlanning("add a CTA section"), "add a CTA section")
  assert.equal(sanitizeMessageForPlanning("  hello world  "), "hello world")
})

test("sanitizeMessageForPlanning: handles empty input", () => {
  assert.equal(sanitizeMessageForPlanning(""), "")
  assert.equal(sanitizeMessageForPlanning("   "), "")
})

test("sanitizeMessageForPlanning: normalizes \\r\\n to \\n", () => {
  const result = sanitizeMessageForPlanning("line1\r\nline2")
  assert.ok(!result.includes("\r"))
})

// ---------------------------------------------------------------------------
// inferTranslationScopeFromMessage
// ---------------------------------------------------------------------------

test("inferTranslationScopeFromMessage: returns 'none' for non-translation messages", () => {
  assert.equal(inferTranslationScopeFromMessage("change the heading"), "none")
  assert.equal(inferTranslationScopeFromMessage("add a new section"), "none")
  assert.equal(inferTranslationScopeFromMessage("rewrite the copy"), "none")
})

test("inferTranslationScopeFromMessage: detects translation keywords", () => {
  assert.notEqual(inferTranslationScopeFromMessage("translate to Spanish"), "none")
  assert.notEqual(inferTranslationScopeFromMessage("localize the content"), "none")
  assert.notEqual(inferTranslationScopeFromMessage("convert to German"), "none")
  assert.notEqual(inferTranslationScopeFromMessage("make it Deutsch"), "none")
})

test("inferTranslationScopeFromMessage: returns 'page' for explicit page scope", () => {
  assert.equal(inferTranslationScopeFromMessage("translate the entire page to Spanish"), "page")
  assert.equal(inferTranslationScopeFromMessage("translate this page to German"), "page")
  assert.equal(inferTranslationScopeFromMessage("localize the whole page"), "page")
  assert.equal(inferTranslationScopeFromMessage("translate all sections to French"), "page")
  assert.equal(inferTranslationScopeFromMessage("translate page to Italian"), "page")
})

test("inferTranslationScopeFromMessage: returns 'component' for component scope", () => {
  assert.equal(inferTranslationScopeFromMessage("translate this block to Spanish"), "component")
  assert.equal(inferTranslationScopeFromMessage("translate the selected component"), "component")
  assert.equal(inferTranslationScopeFromMessage("translate this section to German"), "component")
  assert.equal(inferTranslationScopeFromMessage("translate the current block"), "component")
})

test("inferTranslationScopeFromMessage: defaults to 'page' for ambiguous translation", () => {
  assert.equal(inferTranslationScopeFromMessage("translate to German"), "page")
  assert.equal(inferTranslationScopeFromMessage("translate the heading to Spanish"), "page")
})

// ---------------------------------------------------------------------------
// normalizeVariationTypos
// ---------------------------------------------------------------------------

test("normalizeVariationTypos: fixes common misspellings", () => {
  assert.equal(normalizeVariationTypos("show variaqtions"), "show variations")
  assert.equal(normalizeVariationTypos("show variatons"), "show variations")
  assert.equal(normalizeVariationTypos("show varitions"), "show variations")
})

test("normalizeVariationTypos: normalizes 'variant' to 'variation'", () => {
  assert.equal(normalizeVariationTypos("show variant"), "show variation")
  assert.equal(normalizeVariationTypos("show variants"), "show variations")
})

test("normalizeVariationTypos: leaves correct spelling unchanged", () => {
  assert.equal(normalizeVariationTypos("show variations"), "show variations")
})
