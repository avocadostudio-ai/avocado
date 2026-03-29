import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { processHtml } from "./scraper.ts"

describe("processHtml", () => {
  it("strips script tags", () => {
    const html = `<html><body><p>Hello</p><script>alert("xss")</script><p>World</p></body></html>`
    const result = processHtml(html, "https://example.com")
    assert.ok(!result.html.includes("<script"))
    assert.ok(!result.html.includes("alert"))
    assert.ok(result.html.includes("<p>Hello</p>"))
    assert.ok(result.html.includes("<p>World</p>"))
  })

  it("extracts title", () => {
    const html = `<html><head><title>My Page Title</title></head><body></body></html>`
    const result = processHtml(html, "https://example.com")
    assert.equal(result.title, "My Page Title")
  })

  it("returns empty title when none present", () => {
    const html = `<html><head></head><body></body></html>`
    const result = processHtml(html, "https://example.com")
    assert.equal(result.title, "")
  })

  it("extracts meta description", () => {
    const html = `<html><head><meta name="description" content="A great site about things"></head></html>`
    const result = processHtml(html, "https://example.com")
    assert.equal(result.metaDescription, "A great site about things")
  })

  it("extracts meta description with reversed attribute order", () => {
    const html = `<html><head><meta content="Reversed order" name="description"></head></html>`
    const result = processHtml(html, "https://example.com")
    assert.equal(result.metaDescription, "Reversed order")
  })

  it("returns empty metaDescription when none present", () => {
    const html = `<html><head></head><body></body></html>`
    const result = processHtml(html, "https://example.com")
    assert.equal(result.metaDescription, "")
  })

  it("extracts inline style content", () => {
    const html = `<html><head><style>body { color: red; }</style></head><body><style>.foo { margin: 0; }</style></body></html>`
    const result = processHtml(html, "https://example.com")
    assert.ok(result.css.includes("body { color: red; }"))
    assert.ok(result.css.includes(".foo { margin: 0; }"))
  })

  it("returns empty css when no styles present", () => {
    const html = `<html><body><p>No styles here</p></body></html>`
    const result = processHtml(html, "https://example.com")
    assert.equal(result.css, "")
  })

  it("resolves relative URLs in href attributes", () => {
    const html = `<html><body><a href="/about">About</a><a href="contact.html">Contact</a></body></html>`
    const result = processHtml(html, "https://example.com/pages/index.html")
    assert.ok(result.html.includes('href="https://example.com/about"'))
    assert.ok(result.html.includes('href="https://example.com/pages/contact.html"'))
  })

  it("resolves relative URLs in src attributes", () => {
    const html = `<html><body><img src="/images/logo.png"><img src="photo.jpg"></body></html>`
    const result = processHtml(html, "https://example.com/page/")
    assert.ok(result.html.includes('src="https://example.com/images/logo.png"'))
    assert.ok(result.html.includes('src="https://example.com/page/photo.jpg"'))
  })

  it("preserves absolute URLs", () => {
    const html = `<html><body><a href="https://other.com/page">Link</a><img src="data:image/png;base64,abc"></body></html>`
    const result = processHtml(html, "https://example.com")
    assert.ok(result.html.includes('href="https://other.com/page"'))
    assert.ok(result.html.includes('src="data:image/png;base64,abc"'))
  })

  it("strips multiple script tags including multiline", () => {
    const html = `<html><body>
      <script type="text/javascript">
        var x = 1;
        console.log(x);
      </script>
      <p>Content</p>
      <script src="app.js"></script>
    </body></html>`
    const result = processHtml(html, "https://example.com")
    assert.ok(!result.html.includes("<script"))
    assert.ok(result.html.includes("<p>Content</p>"))
  })
})
