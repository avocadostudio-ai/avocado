import test from "node:test"
import assert from "node:assert/strict"
import { extractUnsplashQuery, heroImageQueryFromContext } from "./image-helpers.js"

test("extractUnsplashQuery parses German replace-image phrasing", () => {
  const message = "ersetze bild durch eine große gelbe zitrone mit wassertropfen und kind"
  const query = extractUnsplashQuery(message)
  assert.equal(query, "große gelbe zitrone wassertropfen und kind")
})

test("extractUnsplashQuery ignores unrelated quoted debug values", () => {
  const message = [
    "changes: Will resolve an image for: \"test\".",
    "Found a matching image from Unsplash.",
    "prompt: ersetze bild durch eine große gelbe zitrone mit wassertropfen und kind"
  ].join("\n")
  const query = extractUnsplashQuery(message)
  assert.equal(query, "große gelbe zitrone wassertropfen und kind")
})

test("extractUnsplashQuery parses 'replace image by' phrasing", () => {
  const query = extractUnsplashQuery("replace image by ripe grapes")
  assert.equal(query, "ripe grapes")
})

test("heroImageQueryFromContext prefers explicit request over fallback page title", () => {
  const query = heroImageQueryFromContext({
    message: "replace the hero image with a large yellow lemon with water droplets and a child",
    currentPage: { title: "test" } as any,
    targetBlock: {
      type: "Hero",
      props: {
        heading: "Discover the Magic of Avocados",
        subheading: "Experience avocado excellence",
        imageAlt: "Avocados"
      }
    } as any
  })
  assert.equal(query, "large yellow lemon water droplets and child")
})
