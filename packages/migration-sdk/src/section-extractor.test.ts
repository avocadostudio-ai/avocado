import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { extractSections, resolveLazyImages } from "./section-extractor.ts"

const BASE = "https://example.com"

describe("extractSections", () => {
  it("extracts semantic <section> tags", () => {
    const html = `
      <body>
        <section class="hero-section">
          <h1>Welcome</h1>
          <p>This is the hero</p>
          <img src="/hero.jpg" alt="Hero image">
          <a href="/about">Learn more</a>
        </section>
        <section id="features">
          <h2>Features</h2>
          <p>Feature one</p>
          <p>Feature two</p>
        </section>
      </body>`

    const sections = extractSections(html, BASE)
    assert.equal(sections.length, 2)

    assert.equal(sections[0].suggestedBlockType, "Hero")
    assert.equal(sections[0].content.headings[0].text, "Welcome")
    assert.equal(sections[0].content.headings[0].level, 1)
    assert.equal(sections[0].content.images.length, 1)
    assert.equal(sections[0].content.images[0].src, "https://example.com/hero.jpg")
    assert.equal(sections[0].content.links.length, 1)

    assert.equal(sections[1].suggestedBlockType, "FeatureGrid")
    assert.equal(sections[1].id, "features")
    assert.equal(sections[1].content.headings[0].text, "Features")
  })

  it("classifies by CSS class patterns", () => {
    const html = `
      <section class="testimonials-section">
        <h2>What clients say</h2>
        <p>Great service!</p>
      </section>
      <section class="faq-accordion">
        <h2>FAQ</h2>
        <details><summary>Q1</summary><p>A1</p></details>
        <details><summary>Q2</summary><p>A2</p></details>
      </section>`

    const sections = extractSections(html, BASE)
    assert.equal(sections[0].suggestedBlockType, "Testimonials")
    assert.equal(sections[1].suggestedBlockType, "FAQAccordion")
  })

  it("skips header and footer chrome sections", () => {
    const html = `
      <header class="site-header"><nav>Nav</nav></header>
      <section class="hero"><h1>Main</h1><p>Content here for the hero section.</p></section>
      <footer class="site-footer"><p>Copyright</p></footer>`

    const sections = extractSections(html, BASE)
    assert.equal(sections.length, 1)
    assert.equal(sections[0].suggestedBlockType, "Hero")
  })

  it("resolves lazy-loaded images", () => {
    const html = `
      <section>
        <h2>Gallery</h2>
        <img data-src="https://example.com/lazy1.jpg" src="placeholder.gif" alt="Lazy 1">
        <img data-lazy-src="https://example.com/lazy2.jpg" alt="Lazy 2">
        <img src="https://example.com/normal.jpg" alt="Normal">
        <img data-src="https://example.com/lazy3.jpg" src="placeholder.gif" alt="Lazy 3">
        <img data-src="https://example.com/lazy4.jpg" src="placeholder.gif" alt="Lazy 4">
      </section>`

    const sections = extractSections(html, BASE)
    assert.equal(sections[0].content.images.length, 5)
    assert.equal(sections[0].content.images[0].src, "https://example.com/lazy1.jpg")
    assert.equal(sections[0].content.images[0].isLazy, true)
    assert.equal(sections[0].content.images[2].src, "https://example.com/normal.jpg")
    assert.equal(sections[0].content.images[2].isLazy, false)
  })

  it("detects FAQ by content (details tags)", () => {
    const html = `
      <section>
        <h2>Questions</h2>
        <details><summary>What is this?</summary><p>An answer.</p></details>
        <details><summary>How does it work?</summary><p>Like this.</p></details>
        <details><summary>Where can I find?</summary><p>Here.</p></details>
      </section>`

    const sections = extractSections(html, BASE)
    assert.equal(sections[0].suggestedBlockType, "FAQAccordion")
  })

  it("detects Stats by numeric content", () => {
    const html = `
      <section class="some-section">
        <span>500+</span> <span>Users</span>
        <span>99%</span> <span>Uptime</span>
        <span>24/7</span> <span>Support</span>
      </section>`

    const sections = extractSections(html, BASE)
    assert.equal(sections[0].suggestedBlockType, "Stats")
  })

  it("extracts lists", () => {
    const html = `
      <section>
        <h2>Benefits</h2>
        <ul>
          <li>Fast delivery</li>
          <li>Great support</li>
          <li>Easy setup</li>
        </ul>
        <p>More content here to avoid empty filtering.</p>
      </section>`

    const sections = extractSections(html, BASE)
    assert.equal(sections[0].content.lists.length, 1)
    assert.deepEqual(sections[0].content.lists[0], ["Fast delivery", "Great support", "Easy setup"])
  })

  it("skips empty and hidden sections", () => {
    const html = `
      <section style="display:none"><p>Hidden</p></section>
      <section><p>   </p></section>
      <section><h2>Visible</h2><p>Real content here.</p></section>`

    const sections = extractSections(html, BASE)
    assert.equal(sections.length, 1)
    assert.equal(sections[0].content.headings[0].text, "Visible")
  })

  it("truncates large section rawHtml to ~5KB", () => {
    const longContent = "<p>" + "x".repeat(6000) + "</p>"
    const html = `<section>${longContent}</section>`

    const sections = extractSections(html, BASE)
    assert.ok(sections[0].rawHtml.length <= 5100) // 5000 + truncation marker
    assert.ok(sections[0].rawHtml.includes("<!-- truncated -->"))
  })

  it("handles Elementor class patterns", () => {
    const html = `
      <section class="elementor-section elementor-section-hero">
        <h1>Hero Title</h1>
        <p>Elementor hero content for the page visitor.</p>
      </section>`

    const sections = extractSections(html, BASE)
    assert.equal(sections[0].suggestedBlockType, "Hero")
    assert.ok(sections[0].classHints.includes("hero"))
  })

  it("resolves relative URLs in images and links", () => {
    const html = `
      <section>
        <h2>About</h2>
        <img src="/images/photo.jpg" alt="Photo">
        <a href="/contact">Contact us</a>
        <p>Some content for the about section.</p>
      </section>`

    const sections = extractSections(html, BASE)
    assert.equal(sections[0].content.images[0].src, "https://example.com/images/photo.jpg")
    assert.equal(sections[0].content.links[0].href, "https://example.com/contact")
  })
})

describe("resolveLazyImages", () => {
  it("replaces data-src with src", () => {
    const html = `<img data-src="real.jpg" src="placeholder.gif" alt="Test">`
    const result = resolveLazyImages(html)
    assert.ok(result.includes('src="real.jpg"'))
    assert.ok(!result.includes('src="placeholder.gif"'))
  })

  it("adds src when only data-src exists", () => {
    const html = `<img data-src="real.jpg" alt="Test">`
    const result = resolveLazyImages(html)
    assert.ok(result.includes('src="real.jpg"'))
  })
})
