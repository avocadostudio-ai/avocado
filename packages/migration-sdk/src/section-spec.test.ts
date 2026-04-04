import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildSectionSpec, buildPageSpecs } from "./section-spec.ts"
import type {
  ExtractedSection,
  SectionStyles,
  ComputedStyleNode,
  PageOutline,
  FullPageScrape,
} from "./types.ts"

// ── Helpers ──

function makeSection(overrides?: Partial<ExtractedSection>): ExtractedSection {
  return {
    index: 0,
    tag: "section",
    classHints: [],
    content: {
      headings: [{ level: 1, text: "Welcome" }],
      paragraphs: ["This is a paragraph with enough text to pass filters."],
      images: [{ src: "https://example.com/hero.jpg", alt: "Hero", isLazy: false }],
      links: [{ href: "/about", text: "Learn more" }],
      lists: [],
    },
    rawHtml: "<section><h1>Welcome</h1><p>This is a paragraph</p></section>",
    ...overrides,
  }
}

function makeStyleNode(overrides?: Partial<ComputedStyleNode>): ComputedStyleNode {
  return {
    tag: "section",
    depth: 0,
    selector: "section",
    styles: {
      display: "flex",
      flexDirection: "row",
      backgroundColor: "rgb(24, 24, 24)",
      padding: "80px 40px",
    },
    text: null,
    image: null,
    children: [],
    ...overrides,
  }
}

function makeSectionStyles(root: ComputedStyleNode, index = 0): SectionStyles {
  return { sectionIndex: index, root }
}

// ── Tests ──

describe("buildSectionSpec", () => {
  it("assembles content from section", () => {
    const section = makeSection()
    const spec = buildSectionSpec(section)

    assert.equal(spec.sectionIndex, 0)
    assert.equal(spec.content.headings[0].text, "Welcome")
    assert.equal(spec.content.paragraphs[0], "This is a paragraph with enough text to pass filters.")
    assert.equal(spec.content.images[0].src, "https://example.com/hero.jpg")
    assert.equal(spec.content.images[0].isBackground, false)
    assert.equal(spec.content.links[0].text, "Learn more")
  })

  it("injects background images from computed styles", () => {
    const section = makeSection({
      content: { headings: [], paragraphs: [], images: [], links: [], lists: [] },
    })
    const root = makeStyleNode({
      styles: { backgroundImage: 'url("https://example.com/bg.jpg")' },
    })
    const spec = buildSectionSpec(section, makeSectionStyles(root))

    assert.equal(spec.content.images.length, 1)
    assert.equal(spec.content.images[0].src, "https://example.com/bg.jpg")
    assert.equal(spec.content.images[0].isBackground, true)
  })

  it("infers side-by-side pattern from flex row", () => {
    const root = makeStyleNode({
      styles: { display: "flex", flexDirection: "row" },
      children: [
        makeStyleNode({ tag: "div", depth: 1, selector: "div:nth-child(1)" }),
        makeStyleNode({ tag: "div", depth: 1, selector: "div:nth-child(2)" }),
      ],
    })
    const spec = buildSectionSpec(makeSection(), makeSectionStyles(root))

    assert.equal(spec.structure.pattern, "side-by-side layout")
  })

  it("infers grid pattern with column count", () => {
    const root = makeStyleNode({
      styles: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr" },
    })
    const spec = buildSectionSpec(makeSection(), makeSectionStyles(root))

    assert.match(spec.structure.pattern, /3-column grid/)
  })

  it("detects repeated children", () => {
    const makeCard = (n: number): ComputedStyleNode => makeStyleNode({
      tag: "div",
      depth: 1,
      selector: `div:nth-child(${n})`,
      children: [
        makeStyleNode({ tag: "img", depth: 2, selector: "img", image: { src: "", alt: "", naturalWidth: 0, naturalHeight: 0 } }),
        makeStyleNode({ tag: "h3", depth: 2, selector: "h3", text: `Card ${n}` }),
        makeStyleNode({ tag: "p", depth: 2, selector: "p", text: "Description" }),
      ],
    })

    const root = makeStyleNode({
      styles: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr" },
      children: [makeCard(1), makeCard(2), makeCard(3)],
    })

    const spec = buildSectionSpec(makeSection(), makeSectionStyles(root))

    assert.equal(spec.structure.repeatCount, 3)
    assert.equal(spec.structure.repeatSignature, "img + h3 + p")
    assert.match(spec.structure.pattern, /3-column grid of 3 items/)
  })

  it("detects accordion interaction model", () => {
    const section = makeSection({
      rawHtml: "<section><details><summary>Q1</summary><p>A1</p></details></section>",
    })
    const spec = buildSectionSpec(section)

    assert.equal(spec.structure.interactionModel, "accordion")
  })

  it("detects tabs interaction model", () => {
    const section = makeSection({
      rawHtml: '<section><div role="tablist"><button role="tab">Tab 1</button></div><div role="tabpanel">Content</div></section>',
    })
    const spec = buildSectionSpec(section)

    assert.equal(spec.structure.interactionModel, "tabs")
  })

  it("detects carousel interaction model", () => {
    const section = makeSection({
      rawHtml: '<section class="carousel-wrapper"><div class="swiper-container"></div></section>',
    })
    const spec = buildSectionSpec(section)

    assert.equal(spec.structure.interactionModel, "carousel")
  })

  it("extracts role-based styles", () => {
    const root = makeStyleNode({
      styles: { display: "flex", flexDirection: "column", backgroundColor: "rgb(0, 0, 0)", padding: "60px" },
      children: [
        makeStyleNode({
          tag: "h2",
          depth: 1,
          selector: "h2",
          text: "Title",
          styles: { fontSize: "48px", fontWeight: "800", fontFamily: "Montserrat", color: "rgb(240, 240, 240)" },
        }),
        makeStyleNode({
          tag: "p",
          depth: 1,
          selector: "p",
          text: "Body text that is long enough",
          styles: { fontSize: "16px", color: "rgb(180, 180, 180)" },
        }),
        makeStyleNode({
          tag: "a",
          depth: 1,
          selector: "a",
          text: "Click me",
          styles: { backgroundColor: "rgb(231, 71, 33)", color: "rgb(255, 255, 255)", borderRadius: "4px" },
        }),
      ],
    })

    const spec = buildSectionSpec(makeSection(), makeSectionStyles(root))

    // Container
    assert.equal(spec.styles.container.backgroundColor, "rgb(0, 0, 0)")

    // Heading
    assert.equal(spec.styles.heading?.fontSize, "48px")
    assert.equal(spec.styles.heading?.fontFamily, "Montserrat")

    // Body text
    assert.equal(spec.styles.bodyText?.fontSize, "16px")

    // CTA
    assert.equal(spec.styles.cta?.backgroundColor, "rgb(231, 71, 33)")

    // Design notes
    assert.equal(spec.designNotes.backgroundColor, "rgb(0, 0, 0)")
    assert.equal(spec.designNotes.textColor, "rgb(240, 240, 240)")
    assert.equal(spec.designNotes.headingFont, "Montserrat")
    assert.equal(spec.designNotes.headingSize, "48px")
  })

  it("carries forward suggestedBlockType as non-authoritative hint", () => {
    const section = makeSection({ suggestedBlockType: "Hero" })
    const spec = buildSectionSpec(section)

    assert.equal(spec.suggestedBlockType, "Hero")
    assert.ok(spec.suggestedConfidence > 0, "should have non-zero confidence")
    assert.ok(spec.suggestedConfidence <= 1, "should be at most 1")
  })

  it("returns zero confidence when no block type suggested and no structural signals", () => {
    const section = makeSection({
      suggestedBlockType: undefined,
      content: {
        headings: [{ level: 3, text: "Small heading" }],
        paragraphs: ["Short text"],
        images: [],
        links: [],
        lists: [],
      },
    })
    const spec = buildSectionSpec(section)

    assert.equal(spec.suggestedBlockType, undefined)
    assert.equal(spec.suggestedConfidence, 0)
  })

  it("works without computed styles (graceful degradation)", () => {
    const section = makeSection()
    const spec = buildSectionSpec(section, undefined, undefined)

    assert.equal(spec.structure.pattern, "unknown")
    assert.equal(spec.structure.elementCount, 0)
    assert.equal(spec.structure.interactionModel, "static")
    assert.deepEqual(spec.styles.container, {})
  })
})

describe("buildPageSpecs", () => {
  it("correlates sections with sectionStyles by index", () => {
    const scrape: FullPageScrape = {
      content: { html: "", css: "", baseUrl: "https://example.com", title: "Test", metaDescription: "" },
      screenshot: null,
      mobileScreenshot: null,
      sections: [
        makeSection({ index: 0, suggestedBlockType: "Hero" }),
        makeSection({ index: 1, suggestedBlockType: "FeatureGrid" }),
      ],
      outline: {
        headings: [],
        sections: [
          { type: "hero", heading: "Welcome", contentSummary: "", imageCount: 1, linkCount: 1, listItemCount: 0, hasForm: false, hasPricing: false, hasVideo: false },
          { type: "features", heading: "Features", contentSummary: "", imageCount: 0, linkCount: 0, listItemCount: 3, hasForm: false, hasPricing: false, hasVideo: false },
        ],
        totalImages: 1,
        totalLinks: 1,
      },
      sectionStyles: [
        makeSectionStyles(makeStyleNode({ styles: { display: "flex", flexDirection: "row" } }), 0),
        makeSectionStyles(makeStyleNode({ styles: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr" } }), 1),
      ],
    }

    const specs = buildPageSpecs(scrape)

    assert.equal(specs.length, 2)
    assert.equal(specs[0].suggestedBlockType, "Hero")
    assert.equal(specs[0].styles.container.display, "flex")
    assert.equal(specs[1].suggestedBlockType, "FeatureGrid")
    assert.equal(specs[1].styles.container.display, "grid")
  })

  it("handles missing sectionStyles gracefully", () => {
    const scrape: FullPageScrape = {
      content: { html: "", css: "", baseUrl: "https://example.com", title: "Test", metaDescription: "" },
      screenshot: null,
      mobileScreenshot: null,
      sections: [makeSection({ index: 0 })],
      outline: { headings: [], sections: [], totalImages: 0, totalLinks: 0 },
    }

    const specs = buildPageSpecs(scrape)
    assert.equal(specs.length, 1)
    assert.deepEqual(specs[0].styles.container, {})
  })
})
