import { mkdir, writeFile } from "node:fs/promises"
import { join, extname } from "node:path"
import type { FetchResult, ScreenshotResult, DownloadedImage, SiteStructure, DiscoveredPage, FullPageScrape } from "./types.ts"
import { extractSections, resolveLazyImages, extractNavigation, extractPageOutline } from "./section-extractor.ts"

const USER_AGENT = "MigrationBot/1.0 (ai-site-editor)"
const MAX_IMAGE_SIZE = 10 * 1024 * 1024 // 10 MB

// ── Pure HTML processing (exported for testability) ──

export function processHtml(
  rawHtml: string,
  baseUrl: string,
): { html: string; css: string; title: string; metaDescription: string } {
  // Extract title
  const titleMatch = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? titleMatch[1].trim() : ""

  // Extract meta description
  const metaMatch = rawHtml.match(
    /<meta\s+[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([\s\S]*?)["'][^>]*/i,
  ) ?? rawHtml.match(
    /<meta\s+[^>]*content\s*=\s*["']([\s\S]*?)["'][^>]*name\s*=\s*["']description["'][^>]*/i,
  )
  const metaDescription = metaMatch ? metaMatch[1].trim() : ""

  // Extract inline <style> content
  const styleBlocks: string[] = []
  const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi
  let styleMatch: RegExpExecArray | null
  while ((styleMatch = styleRe.exec(rawHtml)) !== null) {
    const content = styleMatch[1].trim()
    if (content) styleBlocks.push(content)
  }
  const css = styleBlocks.join("\n\n")

  // Strip <script> tags
  let html = rawHtml.replace(/<script[\s\S]*?<\/script>/gi, "")

  // Resolve relative URLs in href and src attributes
  html = html.replace(
    /(\s(?:href|src)\s*=\s*["'])([^"']+)(["'])/gi,
    (_match, prefix: string, value: string, suffix: string) => {
      // Skip data URIs, anchors, and already-absolute URLs
      if (/^(https?:|data:|mailto:|tel:|#|javascript:)/i.test(value)) {
        return prefix + value + suffix
      }
      try {
        const resolved = new URL(value, baseUrl).href
        return prefix + resolved + suffix
      } catch {
        return prefix + value + suffix
      }
    },
  )

  return { html, css, title, metaDescription }
}

// ── Playwright helpers ──

async function launchBrowser() {
  const { chromium } = await import("playwright")
  return chromium.launch({ headless: true })
}

// ── Exported scraper functions ──

export async function fetchPageContent(url: string): Promise<FetchResult> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`)
  const rawHtml = await res.text()
  const baseUrl = url

  const result = processHtml(rawHtml, baseUrl)

  // Collect external stylesheet URLs, then fetch in parallel
  const stylesheetUrls: string[] = []
  const linkRe = /<link[^>]+rel\s*=\s*["']stylesheet["'][^>]*>/gi
  let linkMatch: RegExpExecArray | null
  while ((linkMatch = linkRe.exec(rawHtml)) !== null) {
    const hrefMatch = linkMatch[0].match(/href\s*=\s*["']([^"']+)["']/i)
    if (!hrefMatch) continue
    try { stylesheetUrls.push(new URL(hrefMatch[1], baseUrl).href) } catch { /* invalid URL */ }
  }

  const externalResults = await Promise.allSettled(
    stylesheetUrls.map(async (cssUrl) => {
      const cssRes = await fetch(cssUrl, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(5_000),
      })
      return cssRes.ok ? cssRes.text() : ""
    })
  )
  const externalCssParts = externalResults
    .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled" && !!r.value)
    .map(r => r.value)

  // Combine inline CSS (from processHtml) with external stylesheets
  const css = [result.css, ...externalCssParts].filter(Boolean).join("\n\n")
  const { html, title, metaDescription } = result

  return { html, css, baseUrl, title, metaDescription }
}

export async function takeScreenshot(
  url: string,
  _options?: Record<string, unknown>,
): Promise<ScreenshotResult> {
  const browser = await launchBrowser()
  try {
    const width = 1440
    const height = 900
    const page = await browser.newPage()
    await page.setViewportSize({ width, height })
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 })
    const buffer = await page.screenshot({ fullPage: true, type: "jpeg", quality: 75 })
    return { base64: buffer.toString("base64"), viewport: { width, height } }
  } finally {
    await browser.close()
  }
}

export async function downloadImage(
  url: string,
  _alt?: string,
  outputDir?: string,
): Promise<DownloadedImage> {
  const dir =
    outputDir ?? process.env.ORCHESTRATOR_GENERATED_IMAGE_DIR ?? "./generated-images"

  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Failed to download image ${url}: ${res.status}`)

  const contentType = res.headers.get("content-type") ?? ""
  if (!contentType.startsWith("image/")) {
    throw new Error(`Not an image: content-type is "${contentType}"`)
  }

  // Pre-flight size check via Content-Length header when available
  const contentLength = res.headers.get("content-length")
  if (contentLength && Number(contentLength) > MAX_IMAGE_SIZE) {
    throw new Error(`Image exceeds 10 MB limit (${contentLength} bytes)`)
  }

  const arrayBuf = await res.arrayBuffer()
  if (arrayBuf.byteLength > MAX_IMAGE_SIZE) {
    throw new Error(`Image exceeds 10 MB limit (${arrayBuf.byteLength} bytes)`)
  }

  // Derive extension from content-type or URL
  let ext = extname(new URL(url).pathname).replace(/^\./, "") || "png"
  if (ext.includes("?")) ext = ext.split("?")[0]
  // Normalize common MIME subtypes
  const mimeToExt: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
  }
  if (mimeToExt[contentType]) ext = mimeToExt[contentType]

  const timestamp = Date.now()
  const rand = Math.random().toString(36).slice(2, 8)
  const fileName = `migrated_${timestamp}_${rand}.${ext}`
  const localPath = join(dir, fileName)

  await mkdir(dir, { recursive: true })
  await writeFile(localPath, Buffer.from(arrayBuf))

  return { localPath, fileName, width: 0, height: 0 }
}

// ── Full page scrape (Playwright: rendered DOM + screenshot + sections) ──

/**
 * Scrape a page using Playwright — combines screenshot, rendered DOM extraction,
 * and section analysis in a single browser session.
 *
 * Handles JS-rendered content (Elementor, lazy loading, SPAs) that
 * plain HTTP fetch misses. Uses auto-waiting for reliable rendering.
 */
export async function scrapeFullPage(url: string): Promise<FullPageScrape> {
  const browser = await launchBrowser()
  try {
    const width = 1440
    const height = 900
    const page = await browser.newPage()
    await page.setViewportSize({ width, height })
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 })

    // Scroll to bottom to trigger lazy loading
    /* eslint-disable @typescript-eslint/no-unsafe-return */
    await page.evaluate(`(async () => {
      const delay = ms => new Promise(r => setTimeout(r, ms));
      const h = document.body.scrollHeight, step = window.innerHeight;
      for (let y = 0; y < h; y += step) { window.scrollTo(0, y); await delay(150); }
      window.scrollTo(0, 0);
      await delay(300);
    })()`)

    // Wait for lazy-loaded content to settle
    await page.waitForLoadState("networkidle").catch(() => { /* ok */ })

    // Extract rendered DOM and computed CSS
    const { renderedHtml, stylesheets } = await page.evaluate(`(() => {
      const html = document.documentElement.outerHTML;
      const sheets = [];
      for (const sheet of document.styleSheets) {
        try { sheets.push(Array.from(sheet.cssRules).map(r => r.cssText).join("\\n")); }
        catch (e) {}
      }
      return { renderedHtml: html, stylesheets: sheets };
    })()`) as { renderedHtml: string; stylesheets: string[] }

    // Extract visual layout metadata (bounding boxes for gap detection + repetition)
    const layoutNodes = await page.evaluate(`(() => {
      const nodes = [];
      const walk = (el, depth) => {
        if (depth > 8) return;
        const rect = el.getBoundingClientRect();
        if (rect.height < 40 || rect.width < 100) return;
        const tag = el.tagName.toLowerCase();
        if (['script','style','svg','path','link','meta','noscript','br','hr'].includes(tag)) return;
        const text = (el.innerText || '').slice(0, 200).trim();
        const imgs = el.querySelectorAll(':scope > img, :scope > picture img').length;
        if (!text && !imgs && depth > 2) return;
        nodes.push({
          tag, depth,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          text: text.slice(0, 150),
          childCount: el.children.length,
          imgCount: imgs,
          linkCount: el.querySelectorAll(':scope > a').length,
          classes: (el.className || '').toString().slice(0, 100),
          role: el.getAttribute('role') || '',
          widgetType: el.getAttribute('data-widget_type') || '',
        });
        for (const child of el.children) walk(child, depth + 1);
      };
      walk(document.body, 0);
      return nodes;
    })()`) as import("./types.ts").LayoutNode[]

    // Extract CSS background images from hero/large sections (not available in HTML source)
    const bgImages = await page.evaluate(`(() => {
      const results = [];
      const els = document.querySelectorAll('section, [class*="hero"], [class*="banner"], [class*="cover"], [data-widget_type]');
      for (const el of els) {
        const style = window.getComputedStyle(el);
        const bg = style.backgroundImage;
        if (bg && bg !== 'none' && bg.includes('url(')) {
          const match = bg.match(/url\\(["']?([^"')]+)["']?\\)/);
          if (match && match[1] && !match[1].startsWith('data:')) {
            const rect = el.getBoundingClientRect();
            results.push({ url: match[1], y: Math.round(rect.y), height: Math.round(rect.height) });
          }
        }
      }
      return results;
    })()`) as Array<{ url: string; y: number; height: number }>

    // Take full-page screenshot
    let screenshot: ScreenshotResult | null = null
    try {
      const buffer = await page.screenshot({ fullPage: true, type: "jpeg", quality: 75 })
      screenshot = { base64: buffer.toString("base64"), viewport: { width, height } }
    } catch { /* non-fatal */ }

    // Process the rendered HTML
    const resolvedHtml = resolveLazyImages(renderedHtml)
    const processed = processHtml(resolvedHtml, url)
    const css = [processed.css, ...stylesheets].join("\n\n")

    const content: FetchResult = {
      html: processed.html,
      css,
      baseUrl: url,
      title: processed.title,
      metaDescription: processed.metaDescription,
    }

    const sections = extractSections(processed.html, url)
    const outline = extractPageOutline(processed.html, url, layoutNodes)
    const nav = extractNavigation(processed.html, url)

    // Inject CSS background images into sections/outline that have zero images
    if (bgImages.length > 0) {
      for (const bg of bgImages) {
        const resolvedUrl = bg.url.startsWith("http") ? bg.url : (() => { try { return new URL(bg.url, url).href } catch { return bg.url } })()
        // Add to the first section with zero images whose Y range overlaps
        for (const section of sections) {
          if (section.content.images.length === 0) {
            section.content.images.push({ src: resolvedUrl, alt: "", isLazy: false })
            break
          }
        }
        // Also add to outline sections
        for (const os of outline.sections) {
          if (os.imageCount === 0 && os.type === "hero") {
            os.imageCount = 1
            break
          }
        }
      }
    }

    return { content, screenshot, sections, outline, nav }
  } finally {
    await browser.close()
  }
}

// ── Site structure discovery ──

/** Derive a slug from a URL path */
function urlToSlug(urlStr: string): string {
  try {
    const u = new URL(urlStr)
    const path = u.pathname.replace(/\/+$/, "") || "/"
    return path
  } catch {
    return urlStr.startsWith("/") ? urlStr : `/${urlStr}`
  }
}

/** Derive a page title from a slug */
function slugToTitle(slug: string): string {
  if (slug === "/") return "Home"
  return slug
    .replace(/^\//, "")
    .split(/[/-]/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

/**
 * Discover pages on a website via sitemap.xml, robots.txt, and link crawling.
 *
 * Strategy (in priority order):
 * 1. Try sitemap.xml at the site root
 * 2. Try robots.txt for Sitemap: directives
 * 3. Fall back to extracting <a> links from the homepage
 */
export async function discoverSitePages(url: string): Promise<SiteStructure> {
  const origin = new URL(url).origin

  // 1. Try sitemap.xml
  const sitemapPages = await fetchSitemap(`${origin}/sitemap.xml`, origin)
  if (sitemapPages.length > 0) {
    return { origin, pages: sitemapPages, source: "sitemap", totalFound: sitemapPages.length }
  }

  // 2. Try robots.txt for Sitemap: directives
  const robotsSitemapUrls = await fetchRobotsSitemaps(origin)
  for (const sitemapUrl of robotsSitemapUrls) {
    const pages = await fetchSitemap(sitemapUrl, origin)
    if (pages.length > 0) {
      return { origin, pages, source: "robots", totalFound: pages.length }
    }
  }

  // 3. Fall back to link crawling from homepage
  const linkPages = await extractLinksFromPage(url, origin)
  if (linkPages.length > 0) {
    return { origin, pages: linkPages, source: "links", totalFound: linkPages.length }
  }

  // 4. Single page fallback
  return {
    origin,
    pages: [{ url, slug: "/", title: "Home" }],
    source: "single",
    totalFound: 1,
  }
}

async function fetchSitemap(sitemapUrl: string, origin: string): Promise<DiscoveredPage[]> {
  try {
    const res = await fetch(sitemapUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return []
    const xml = await res.text()

    // Parse <loc> tags
    const locRe = /<loc>([\s\S]*?)<\/loc>/gi
    const pages: DiscoveredPage[] = []
    const seen = new Set<string>()
    let match: RegExpExecArray | null
    while ((match = locRe.exec(xml)) !== null) {
      const pageUrl = match[1].trim()
      // Filter to same origin
      if (!pageUrl.startsWith(origin)) continue
      const slug = urlToSlug(pageUrl)
      if (seen.has(slug)) continue
      seen.add(slug)
      pages.push({ url: pageUrl, slug, title: slugToTitle(slug) })
    }
    return pages
  } catch {
    return []
  }
}

async function fetchRobotsSitemaps(origin: string): Promise<string[]> {
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return []
    const text = await res.text()

    const urls: string[] = []
    for (const line of text.split("\n")) {
      const match = line.match(/^Sitemap:\s*(.+)/i)
      if (match) urls.push(match[1].trim())
    }
    return urls
  } catch {
    return []
  }
}

async function extractLinksFromPage(url: string, origin: string): Promise<DiscoveredPage[]> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return []
    const html = await res.text()

    // Extract all <a href="..."> links
    const linkRe = /<a[^>]+href\s*=\s*["']([^"'#]+)["']/gi
    const seen = new Set<string>()
    const pages: DiscoveredPage[] = []
    let match: RegExpExecArray | null
    while ((match = linkRe.exec(html)) !== null) {
      let href = match[1].trim()
      if (!href || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) continue

      // Resolve relative URLs
      try {
        const resolved = new URL(href, url).href
        if (!resolved.startsWith(origin)) continue // skip external links
        href = resolved
      } catch { continue }

      const slug = urlToSlug(href)
      if (seen.has(slug)) continue
      // Skip asset/API paths
      if (/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|pdf|zip)$/i.test(slug)) continue
      if (/^\/(api|_next|static|assets|cdn|wp-content|wp-admin|wp-includes)\//i.test(slug)) continue
      seen.add(slug)
      pages.push({ url: href, slug, title: slugToTitle(slug) })
    }
    return pages
  } catch {
    return []
  }
}
