import assert from "node:assert/strict"
import test from "node:test"

import { siteNameFallback, slugToLabel, buildNavItems } from "../lib/navigation.ts"

// --- siteNameFallback ---

test("siteNameFallback: converts kebab-case siteId to title case", () => {
  assert.equal(siteNameFallback("avocado-stories"), "Avocado Stories")
})

test("siteNameFallback: handles single word", () => {
  assert.equal(siteNameFallback("blog"), "Blog")
})

test("siteNameFallback: handles empty string", () => {
  assert.equal(siteNameFallback(""), "")
})

// --- slugToLabel ---

test("slugToLabel: root returns Home", () => {
  assert.equal(slugToLabel("/"), "Home")
})

test("slugToLabel: single segment", () => {
  assert.equal(slugToLabel("/pricing"), "Pricing")
})

test("slugToLabel: replaces dashes and underscores with spaces", () => {
  assert.equal(slugToLabel("/about-us"), "About us")
})

test("slugToLabel: nested slug uses / separator", () => {
  assert.equal(slugToLabel("/docs/getting-started"), "Docs / Getting started")
})

// --- buildNavItems ---

test("buildNavItems: builds nav with home first and marks active slug", () => {
  const result = buildNavItems({
    navSlugs: ["/", "/pricing", "/about"],
    currentSlug: "/pricing",
    siteConfig: { name: "Test Site", logo: "/logo.svg" },
    siteId: "test-site",
    editorQuery: ""
  })

  assert.equal(result.siteName, "Test Site")
  assert.equal(result.siteLogo, "/logo.svg")
  assert.equal(result.homeHref, "/")
  assert.equal(result.navItems[0].href, "/")
  assert.equal(result.navItems[0].label, "Home")
  assert.equal(result.navItems[0].isActive, false)
  assert.equal(result.navItems[1].isActive, true)
  assert.equal(result.navItems[1].label, "Pricing")
})

test("buildNavItems: falls back to siteNameFallback when no config name", () => {
  const result = buildNavItems({
    navSlugs: ["/"],
    currentSlug: "/",
    siteConfig: {},
    siteId: "my-cool-site",
    editorQuery: ""
  })

  assert.equal(result.siteName, "My Cool Site")
  assert.equal(result.siteLogo, "/logos/default.svg")
})

test("buildNavItems: appends editorQuery to hrefs", () => {
  const result = buildNavItems({
    navSlugs: ["/", "/pricing"],
    currentSlug: "/",
    siteConfig: {},
    siteId: "test",
    editorQuery: "?session=dev&siteId=test"
  })

  assert.equal(result.navItems[0].href, "/?session=dev&siteId=test")
  assert.equal(result.navItems[1].href, "/pricing?session=dev&siteId=test")
  assert.equal(result.homeHref, "/?session=dev&siteId=test")
})

test("buildNavItems: uses navLabels from siteConfig when provided", () => {
  const result = buildNavItems({
    navSlugs: ["/", "/pricing"],
    currentSlug: "/",
    siteConfig: { navLabels: { "/": "Start", "/pricing": "Plans" } },
    siteId: "test",
    editorQuery: ""
  })

  assert.equal(result.navItems[0].label, "Start")
  assert.equal(result.navItems[1].label, "Plans")
})

test("buildNavItems: adds current slug if not in navSlugs", () => {
  const result = buildNavItems({
    navSlugs: ["/"],
    currentSlug: "/secret",
    siteConfig: {},
    siteId: "test",
    editorQuery: ""
  })

  const hrefs = result.navItems.map((n) => n.href)
  assert.ok(hrefs.includes("/secret"))
})

test("buildNavItems: defaults to fallback slugs when navSlugs is empty", () => {
  const result = buildNavItems({
    navSlugs: [],
    currentSlug: "/",
    siteConfig: {},
    siteId: "test",
    editorQuery: ""
  })

  const hrefs = result.navItems.map((n) => n.href)
  assert.ok(hrefs.includes("/"))
  assert.ok(hrefs.includes("/pricing"))
})
