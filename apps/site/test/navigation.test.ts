import assert from "node:assert/strict"
import test from "node:test"

import { siteNameFallback, slugToLabel, buildNavItems } from "@ai-site-editor/site-sdk/navigation"

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
  assert.equal(hrefs.includes("/pricing"), false)
})

// --- navGroups ---

test("buildNavItems: navGroups collapses slugs into parent dropdown items", () => {
  const result = buildNavItems({
    navSlugs: ["/", "/about", "/bananas", "/strawberries", "/contact"],
    currentSlug: "/",
    siteConfig: {
      navGroups: { "Products": ["/bananas", "/strawberries"] }
    },
    siteId: "test",
    editorQuery: ""
  })

  assert.equal(result.navItems.length, 4) // Home, About, Products, Contact
  assert.equal(result.navItems[0].label, "Home")
  assert.equal(result.navItems[1].label, "About")
  assert.equal(result.navItems[2].label, "Products")
  assert.ok(result.navItems[2].children)
  assert.equal(result.navItems[2].children!.length, 2)
  assert.equal(result.navItems[2].children![0].label, "Bananas")
  assert.equal(result.navItems[2].children![1].label, "Strawberries")
  assert.equal(result.navItems[3].label, "Contact")
})

test("buildNavItems: navGroups parent isActive when child matches currentSlug", () => {
  const result = buildNavItems({
    navSlugs: ["/", "/bananas", "/strawberries"],
    currentSlug: "/strawberries",
    siteConfig: {
      navGroups: { "Fruits": ["/bananas", "/strawberries"] }
    },
    siteId: "test",
    editorQuery: ""
  })

  const fruitsItem = result.navItems.find((n) => n.label === "Fruits")
  assert.ok(fruitsItem)
  assert.equal(fruitsItem!.isActive, true)
  assert.equal(fruitsItem!.children![1].isActive, true)
  assert.equal(fruitsItem!.children![0].isActive, false)
})

test("buildNavItems: without navGroups produces flat list (backward compat)", () => {
  const result = buildNavItems({
    navSlugs: ["/", "/about", "/pricing"],
    currentSlug: "/",
    siteConfig: {},
    siteId: "test",
    editorQuery: ""
  })

  assert.equal(result.navItems.length, 3)
  assert.ok(result.navItems.every((n) => !n.children))
})

test("buildNavItems: navGroups children get editorQuery appended", () => {
  const result = buildNavItems({
    navSlugs: ["/", "/bananas", "/strawberries"],
    currentSlug: "/",
    siteConfig: {
      navGroups: { "Fruits": ["/bananas", "/strawberries"] }
    },
    siteId: "test",
    editorQuery: "?session=dev"
  })

  const fruitsItem = result.navItems.find((n) => n.label === "Fruits")
  assert.equal(fruitsItem!.children![0].href, "/bananas?session=dev")
  assert.equal(fruitsItem!.children![1].href, "/strawberries?session=dev")
})
