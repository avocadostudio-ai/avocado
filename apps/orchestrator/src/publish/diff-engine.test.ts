import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { PageDoc } from "@avocadostudio-ai/shared"
import { computePublishDiff } from "./diff-engine.js"

function page(slug: string, blocks: Array<{ id: string; type: string; props?: Record<string, unknown> }>, extras?: Partial<PageDoc>): PageDoc {
  return {
    id: `p_${slug.replace(/\W+/g, "_") || "root"}`,
    slug,
    title: extras?.title ?? slug,
    updatedAt: "2026-01-01T00:00:00.000Z",
    blocks: blocks.map((b) => ({ id: b.id, type: b.type, props: b.props ?? {} })),
    ...extras,
  }
}

describe("computePublishDiff", () => {
  it("returns no pages when both sides are empty", () => {
    const diff = computePublishDiff([], [])
    assert.deepEqual(diff.summary, {
      pagesAdded: 0,
      pagesRemoved: 0,
      pagesModified: 0,
      pagesUnchanged: 0,
      totalChangedFields: 0,
      siteConfigChangedFields: 0,
    })
    assert.deepEqual(diff.pages, [])
    assert.equal(diff.siteConfig.status, "unchanged")
    assert.deepEqual(diff.siteConfig.fieldDiffs, [])
  })

  it("marks a page as added when present in draft only", () => {
    const draft = [page("/about", [{ id: "b1", type: "Hero", props: { heading: "Hello" } }])]
    const diff = computePublishDiff(draft, [])
    assert.equal(diff.summary.pagesAdded, 1)
    assert.equal(diff.pages[0].status, "added")
    assert.equal(diff.pages[0].blockDiffs[0].status, "added")
  })

  it("marks a page as removed when only published has it", () => {
    const published = [page("/old", [{ id: "b1", type: "CTA" }])]
    const diff = computePublishDiff([], published)
    assert.equal(diff.summary.pagesRemoved, 1)
    assert.equal(diff.pages[0].status, "removed")
    assert.equal(diff.pages[0].blockDiffs[0].status, "removed")
  })

  it("marks a page as unchanged when props match deeply", () => {
    const published = [page("/", [{ id: "b1", type: "Hero", props: { heading: "Hello", items: [{ q: "a" }] } }])]
    const draft = [page("/", [{ id: "b1", type: "Hero", props: { heading: "Hello", items: [{ q: "a" }] } }])]
    const diff = computePublishDiff(draft, published)
    assert.equal(diff.summary.pagesUnchanged, 1)
    assert.equal(diff.summary.pagesModified, 0)
    assert.equal(diff.pages[0].status, "unchanged")
  })

  it("detects a simple field change on an existing block", () => {
    const published = [page("/", [{ id: "b1", type: "Hero", props: { heading: "Hello", subheading: "World" } }])]
    const draft = [page("/", [{ id: "b1", type: "Hero", props: { heading: "Hi there", subheading: "World" } }])]
    const diff = computePublishDiff(draft, published)
    assert.equal(diff.summary.pagesModified, 1)
    assert.equal(diff.summary.totalChangedFields, 1)
    const bd = diff.pages[0].blockDiffs[0]
    assert.equal(bd.status, "modified")
    assert.deepEqual(bd.fieldDiffs, [{ path: "heading", before: "Hello", after: "Hi there", kind: "text" }])
  })

  it("emits nested list-item diffs with bracket paths", () => {
    const published = [page("/faq", [{ id: "b1", type: "FAQAccordion", props: { items: [{ q: "A", a: "1" }, { q: "B", a: "2" }] } }])]
    const draft = [page("/faq", [{ id: "b1", type: "FAQAccordion", props: { items: [{ q: "A", a: "1" }, { q: "B!", a: "2" }] } }])]
    const diff = computePublishDiff(draft, published)
    const paths = diff.pages[0].blockDiffs[0].fieldDiffs?.map((f) => f.path)
    assert.deepEqual(paths, ["items[1].q"])
  })

  it("infers image kind for imageUrl-like paths", () => {
    const published = [page("/", [{ id: "b1", type: "Hero", props: { imageUrl: "/a.jpg" } }])]
    const draft = [page("/", [{ id: "b1", type: "Hero", props: { imageUrl: "/b.jpg" } }])]
    const diff = computePublishDiff(draft, published)
    assert.equal(diff.pages[0].blockDiffs[0].fieldDiffs?.[0].kind, "image")
  })

  it("flags moved blocks (same id, different index)", () => {
    const published = [page("/", [
      { id: "b1", type: "Hero", props: { heading: "H" } },
      { id: "b2", type: "CTA", props: { title: "C" } },
    ])]
    const draft = [page("/", [
      { id: "b2", type: "CTA", props: { title: "C" } },
      { id: "b1", type: "Hero", props: { heading: "H" } },
    ])]
    const diff = computePublishDiff(draft, published)
    const statuses = diff.pages[0].blockDiffs.map((bd) => ({ id: bd.blockId, status: bd.status }))
    // Both moved, no prop changes — both should be "moved"
    assert.ok(statuses.every((s) => s.status === "moved"))
  })

  it("records title changes at page level", () => {
    const published = [page("/", [{ id: "b1", type: "Hero" }], { title: "Old" })]
    const draft = [page("/", [{ id: "b1", type: "Hero" }], { title: "New" })]
    const diff = computePublishDiff(draft, published)
    assert.equal(diff.pages[0].status, "modified")
    assert.equal(diff.pages[0].titleBefore, "Old")
    assert.equal(diff.pages[0].titleAfter, "New")
  })

  it("orders pages: added, modified, removed, unchanged", () => {
    const published = [
      page("/gone", [{ id: "g1", type: "Hero" }]),
      page("/same", [{ id: "s1", type: "Hero", props: { heading: "x" } }]),
      page("/changed", [{ id: "c1", type: "Hero", props: { heading: "old" } }]),
    ]
    const draft = [
      page("/new", [{ id: "n1", type: "Hero" }]),
      page("/same", [{ id: "s1", type: "Hero", props: { heading: "x" } }]),
      page("/changed", [{ id: "c1", type: "Hero", props: { heading: "new" } }]),
    ]
    const diff = computePublishDiff(draft, published)
    const statuses = diff.pages.map((p) => p.status)
    assert.deepEqual(statuses, ["added", "modified", "removed", "unchanged"])
  })

  describe("siteConfig diff", () => {
    it("returns unchanged when no siteConfig is passed", () => {
      const diff = computePublishDiff([], [])
      assert.equal(diff.siteConfig.status, "unchanged")
      assert.equal(diff.siteConfig.fieldDiffs.length, 0)
      assert.equal(diff.summary.siteConfigChangedFields, 0)
    })

    it("returns unchanged when both configs match", () => {
      const cfg = { name: "Acme", logo: "/logo.svg", navLabels: { "/about": "About" } }
      const diff = computePublishDiff([], [], {
        draftSiteConfig: cfg,
        publishedSiteConfig: cfg,
      })
      assert.equal(diff.siteConfig.status, "unchanged")
      assert.equal(diff.siteConfig.fieldDiffs.length, 0)
    })

    it("detects a site name change as text kind", () => {
      const diff = computePublishDiff([], [], {
        draftSiteConfig: { name: "The Avocado Studio" },
        publishedSiteConfig: { name: "The Avocado Hub" },
      })
      assert.equal(diff.siteConfig.status, "modified")
      assert.equal(diff.summary.siteConfigChangedFields, 1)
      assert.deepEqual(diff.siteConfig.fieldDiffs, [
        { path: "name", before: "The Avocado Hub", after: "The Avocado Studio", kind: "text" },
      ])
    })

    it("detects a logo change as image kind", () => {
      const diff = computePublishDiff([], [], {
        draftSiteConfig: { logo: "/v2.svg" },
        publishedSiteConfig: { logo: "/v1.svg" },
      })
      assert.equal(diff.siteConfig.fieldDiffs[0].kind, "image")
      assert.equal(diff.siteConfig.fieldDiffs[0].path, "logo")
    })

    it("emits one diff per added, removed, and changed navLabel", () => {
      const diff = computePublishDiff([], [], {
        draftSiteConfig: {
          navLabels: {
            "/about": "About Us",         // changed
            "/contact": "Contact",        // added
          },
        },
        publishedSiteConfig: {
          navLabels: {
            "/about": "About",            // changed
            "/pricing": "Pricing",        // removed
          },
        },
      })
      const paths = diff.siteConfig.fieldDiffs.map((d) => d.path).sort()
      assert.deepEqual(paths, [
        'navLabels["/about"]',
        'navLabels["/contact"]',
        'navLabels["/pricing"]',
      ])
      assert.equal(diff.summary.siteConfigChangedFields, 3)
    })

    it("emits one diff per added, removed, and changed navGroup", () => {
      const diff = computePublishDiff([], [], {
        draftSiteConfig: {
          navGroups: {
            "Produce": ["/apples", "/bananas"],     // changed (order/contents differ)
            "Explore": ["/recipes"],                // added
          },
        },
        publishedSiteConfig: {
          navGroups: {
            "Produce": ["/apples"],
            "Old": ["/dead"],                       // removed
          },
        },
      })
      const paths = diff.siteConfig.fieldDiffs.map((d) => d.path).sort()
      assert.deepEqual(paths, [
        'navGroups["Explore"]',
        'navGroups["Old"]',
        'navGroups["Produce"]',
      ])
    })

    it("marks status as added when published config was empty", () => {
      const diff = computePublishDiff([], [], {
        draftSiteConfig: { name: "Acme", logo: "/logo.svg" },
        publishedSiteConfig: null,
      })
      assert.equal(diff.siteConfig.status, "added")
      assert.equal(diff.siteConfig.fieldDiffs.length, 2)
    })

    it("marks status as removed when draft config dropped all header fields", () => {
      const diff = computePublishDiff([], [], {
        draftSiteConfig: {},
        publishedSiteConfig: { name: "Old", logo: "/old.svg" },
      })
      assert.equal(diff.siteConfig.status, "removed")
      assert.equal(diff.siteConfig.fieldDiffs.length, 2)
    })

    it("ignores non-header keys like purpose, tone, themeOverrides", () => {
      const diff = computePublishDiff([], [], {
        draftSiteConfig: { name: "Acme", purpose: "Sell stuff", tone: "Witty", themeOverrides: { "--brand": "#000" } },
        publishedSiteConfig: { name: "Acme", purpose: "Other", tone: "Formal", themeOverrides: { "--brand": "#fff" } },
      })
      assert.equal(diff.siteConfig.status, "unchanged")
      assert.equal(diff.siteConfig.fieldDiffs.length, 0)
    })
  })
})
