import { mkdir, writeFile } from "node:fs/promises"
import { join, extname } from "node:path"
import type { FetchResult, ScreenshotResult, DownloadedImage, SiteStructure, DiscoveredPage, FullPageScrape } from "./types.ts"
import { extractSections, resolveLazyImages, extractNavigation, extractPageOutline, segmentByVisualGaps } from "./section-extractor.ts"

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
    const response = await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 })
    const status = response?.status() ?? 0
    if (status < 200 || status >= 400) {
      throw new Error(`HTTP ${status} from ${url} — refusing to screenshot an error page`)
    }
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

    // Scroll to bottom slowly to trigger lazy loading (300ms per step for Intersection Observer)
    /* eslint-disable @typescript-eslint/no-unsafe-return */
    await page.evaluate(`(async () => {
      const delay = ms => new Promise(r => setTimeout(r, ms));
      const h = document.body.scrollHeight, step = window.innerHeight;
      for (let y = 0; y < h; y += step) { window.scrollTo(0, y); await delay(300); }
      window.scrollTo(0, 0);
      await delay(500);
    })()`)

    // Wait for lazy-loaded content to settle
    await page.waitForLoadState("networkidle").catch(() => { /* ok */ })

    // Force-resolve lazy images that use data-src attributes (in the live page, before screenshots)
    await page.evaluate(`(() => {
      document.querySelectorAll('img[data-src], img[data-lazy-src], img[data-original], img[data-bg]').forEach(img => {
        const lazySrc = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
        if (lazySrc) img.setAttribute('src', lazySrc);
        const bgSrc = img.getAttribute('data-bg');
        if (bgSrc) img.style.backgroundImage = 'url(' + bgSrc + ')';
      });
    })()`)

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

    // Extract CSS background images from ALL visible elements (CMS-agnostic)
    const bgImages = await page.evaluate(`(() => {
      const results = [];
      const seen = new Set();
      const els = document.querySelectorAll('*');
      for (const el of els) {
        const style = window.getComputedStyle(el);
        const bg = style.backgroundImage;
        if (bg && bg !== 'none' && bg.includes('url(')) {
          const match = bg.match(/url\\(["']?([^"')]+)["']?\\)/);
          if (match && match[1] && !match[1].startsWith('data:') && !seen.has(match[1])) {
            seen.add(match[1]);
            const rect = el.getBoundingClientRect();
            if (rect.height > 20 && rect.width > 20) {
              results.push({ url: match[1], y: Math.round(rect.y), height: Math.round(rect.height) });
            }
          }
        }
      }
      return results;
    })()`) as Array<{ url: string; y: number; height: number }>

    // Extract embedded iframes AND video URLs from data attributes / consent placeholders
    const embeds = await page.evaluate(`(() => {
      const results = [];
      const seen = new Set();

      // 1. Standard iframes
      document.querySelectorAll('iframe[src]').forEach(el => {
        const src = el.src || '';
        if (!src || seen.has(src)) return;
        seen.add(src);
        const rect = el.getBoundingClientRect();
        let type = 'other';
        if (/youtube\\.com|youtu\\.be/i.test(src)) type = 'youtube';
        else if (/vimeo\\.com/i.test(src)) type = 'vimeo';
        else if (/google\\.com\\/maps|maps\\.google/i.test(src)) type = 'map';
        if (rect.height > 20) results.push({ src, type, y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });
      });

      // 2. Grep the entire HTML for video URLs — catches any embed method
      //    (data attributes, inline scripts, JSON-LD, consent placeholders, etc.)
      const html = document.documentElement.outerHTML;

      // YouTube: youtu.be/ID or youtube.com/watch?v=ID or youtube.com/embed/ID
      // Also matches JSON-escaped slashes (\\\\/) common in data attributes
      const ytMatches = html.match(/youtu(?:\\.be[\\/\\\\\\\\]+|be\\.com[\\/\\\\\\\\]+(?:watch\\?v=|embed[\\/\\\\\\\\]+))([\\w-]{11})/g) || [];
      for (const match of ytMatches) {
        const id = match.match(/([\\w-]{11})$/)?.[1];
        if (id && !seen.has(id)) {
          seen.add(id);
          // Try to find the element that contains this URL for Y position
          const el = document.querySelector('[data-settings*=\"' + id + '\"], [src*=\"' + id + '\"], [data-src*=\"' + id + '\"]');
          const rect = el ? el.getBoundingClientRect() : { y: 0, width: 0, height: 0 };
          results.push({ src: 'https://www.youtube.com/embed/' + id, type: 'youtube', y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height || 400) });
        }
      }

      // Vimeo: vimeo.com/ID or vimeo.com/video/ID
      const vimeoMatches = html.match(/vimeo\\.com\\/(?:video\\/)?(\\d{6,})/g) || [];
      for (const match of vimeoMatches) {
        const id = match.match(/(\\d{6,})$/)?.[1];
        if (id && !seen.has(id)) {
          seen.add(id);
          results.push({ src: 'https://player.vimeo.com/video/' + id, type: 'vimeo', y: 0, width: 0, height: 0 });
        }
      }

      // Google Maps embed URLs
      const mapMatches = html.match(/google\\.com\\/maps\\/embed[^\"'\\s]*/g) || [];
      for (const src of mapMatches) {
        if (!seen.has(src)) {
          seen.add(src);
          const el = document.querySelector('iframe[src*=\"maps/embed\"]');
          const rect = el ? el.getBoundingClientRect() : { y: 0, width: 0, height: 0 };
          results.push({ src: 'https://www.' + src, type: 'map', y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height || 400) });
        }
      }

      return results;
    })()`) as import("./types.ts").ExtractedEmbed[]

    // Extract ALL page images with Y positions (for distributing to visual sections)
    const pageImages = await page.evaluate(`(() => {
      const results = [];
      const seen = new Set();
      // Regular <img> elements
      document.querySelectorAll('img').forEach(img => {
        const src = img.src || img.currentSrc || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
        if (!src || src.startsWith('data:') || seen.has(src)) return;
        const rect = img.getBoundingClientRect();
        if (rect.width < 30 || rect.height < 30) return;
        seen.add(src);
        const scrollY = window.scrollY;
        results.push({ src, alt: img.alt || '', y: Math.round(rect.y + scrollY), width: Math.round(rect.width), height: Math.round(rect.height) });
      });
      return results;
    })()`) as Array<{ src: string; alt: string; y: number; width: number; height: number }>

    // Detect smooth scroll libraries (Lenis, Locomotive, native smooth-scroll)
    const scrollBehavior = await page.evaluate(`(() => {
      // Lenis
      if (document.querySelector('.lenis') || document.querySelector('[data-lenis-prevent]') || window.__lenis) {
        return { library: 'lenis', scrollContainer: '.lenis' };
      }
      // Locomotive Scroll
      if (document.querySelector('[data-scroll-container]') || document.querySelector('[data-scroll-section]')) {
        const container = document.querySelector('[data-scroll-container]');
        return { library: 'locomotive', scrollContainer: container ? container.tagName.toLowerCase() + (container.className ? '.' + container.className.split(' ')[0] : '') : '[data-scroll-container]' };
      }
      // Native smooth scroll
      const htmlStyle = getComputedStyle(document.documentElement).scrollBehavior;
      if (htmlStyle === 'smooth') {
        return { library: 'native-smooth' };
      }
      return { library: 'none' };
    })()`) as NonNullable<FullPageScrape["scrollBehavior"]>

    // Detect layered image compositions (multiple positioned/z-indexed images overlapping)
    const imageCompositions = await page.evaluate(`(() => {
      const allImgs = [...document.querySelectorAll('img')].map(img => {
        const rect = img.getBoundingClientRect();
        if (rect.width < 30 || rect.height < 30) return null;
        const cs = getComputedStyle(img);
        const parentCs = img.parentElement ? getComputedStyle(img.parentElement) : null;
        const scrollY = window.scrollY;
        return {
          src: img.src || img.currentSrc || '',
          alt: img.alt || '',
          zIndex: parseInt(cs.zIndex) || parseInt(parentCs?.zIndex || '0') || 0,
          position: cs.position || 'static',
          bounds: { x: Math.round(rect.x), y: Math.round(rect.y + scrollY), w: Math.round(rect.width), h: Math.round(rect.height) }
        };
      }).filter(Boolean);

      // Also include elements with background images
      const bgEls = [...document.querySelectorAll('*')].map(el => {
        const cs = getComputedStyle(el);
        const bg = cs.backgroundImage;
        if (!bg || bg === 'none' || !bg.includes('url(')) return null;
        const match = bg.match(/url\\(["']?([^"')]+)["']?\\)/);
        if (!match || !match[1] || match[1].startsWith('data:')) return null;
        const rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) return null;
        const scrollY = window.scrollY;
        return {
          src: match[1],
          alt: '',
          zIndex: parseInt(cs.zIndex) || 0,
          position: cs.position || 'static',
          bounds: { x: Math.round(rect.x), y: Math.round(rect.y + scrollY), w: Math.round(rect.width), h: Math.round(rect.height) }
        };
      }).filter(Boolean);

      const all = [...allImgs, ...bgEls];

      // Find overlapping groups
      function overlaps(a, b) {
        return !(a.bounds.x + a.bounds.w < b.bounds.x || b.bounds.x + b.bounds.w < a.bounds.x ||
                 a.bounds.y + a.bounds.h < b.bounds.y || b.bounds.y + b.bounds.h < a.bounds.y);
      }

      const compositions = [];
      const used = new Set();
      for (let i = 0; i < all.length; i++) {
        if (used.has(i)) continue;
        const group = [all[i]];
        used.add(i);
        for (let j = i + 1; j < all.length; j++) {
          if (used.has(j)) continue;
          if (group.some(g => overlaps(g, all[j]))) {
            group.push(all[j]);
            used.add(j);
          }
        }
        if (group.length >= 2) {
          // Multiple overlapping images = composition
          const hasZDiff = new Set(group.map(g => g.zIndex)).size > 1;
          compositions.push({
            layers: group.sort((a, b) => a.zIndex - b.zIndex),
            compositeType: hasZDiff ? 'overlay' : 'stacked'
          });
        }
      }
      return compositions;
    })()`) as import("./types.ts").ImageComposition[]

    // Extract actual rendered fonts via getComputedStyle (more reliable than CSS regex)
    const computedFonts = await page.evaluate(`(() => {
      const fonts = { heading: null, body: null };
      // Get heading font from first h1/h2
      const heading = document.querySelector('h1, h2');
      if (heading) {
        const family = getComputedStyle(heading).fontFamily.split(',')[0].trim().replace(/['"]/g, '');
        if (family && family !== 'inherit' && family !== 'initial') fonts.heading = family;
      }
      // Get body font from first visible paragraph or body
      const body = document.querySelector('p') || document.body;
      if (body) {
        const family = getComputedStyle(body).fontFamily.split(',')[0].trim().replace(/['"]/g, '');
        if (family && family !== 'inherit' && family !== 'initial') fonts.body = family;
      }
      // Also check for Google Fonts links
      const googleFonts = [...document.querySelectorAll('link[href*="fonts.googleapis.com"]')]
        .map(l => l.getAttribute('href'))
        .filter(Boolean);
      return { ...fonts, googleFontLinks: googleFonts };
    })()`) as { heading: string | null; body: string | null; googleFontLinks: string[] }

    // Extract <video> elements (background videos, hero videos, inline video players)
    const videos = await page.evaluate(`(() => {
      const results = [];
      const seen = new Set();
      document.querySelectorAll('video').forEach(vid => {
        // Get src from <video src=""> or <source src="">
        let src = vid.src || '';
        if (!src) {
          const source = vid.querySelector('source[src]');
          if (source) src = source.src || source.getAttribute('src') || '';
        }
        if (!src || src.startsWith('data:') || seen.has(src)) return;
        seen.add(src);
        const rect = vid.getBoundingClientRect();
        if (rect.width < 30 || rect.height < 30) return;
        const scrollY = window.scrollY;
        results.push({
          src,
          poster: vid.poster || undefined,
          autoplay: vid.autoplay,
          loop: vid.loop,
          muted: vid.muted,
          y: Math.round(rect.y + scrollY),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      });
      return results;
    })()`) as import("./types.ts").ExtractedVideo[]

    // Resolve CSS custom properties to actual computed values (fixes var() references in design tokens)
    const resolvedCssVars = await page.evaluate(`(() => {
      const vars = {};
      const root = document.documentElement;
      const rootStyles = getComputedStyle(root);
      // Collect all CSS custom properties declared on :root / html
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.selectorText && /^(:root|html)$/i.test(rule.selectorText.trim())) {
              for (const prop of rule.style) {
                if (prop.startsWith('--')) {
                  const resolved = rootStyles.getPropertyValue(prop).trim();
                  if (resolved) vars[prop] = resolved;
                }
              }
            }
          }
        } catch(e) {}
      }
      return vars;
    })()`) as Record<string, string>

    // Compute visual section boundaries from layout nodes (CMS-agnostic)
    const visualSections = segmentByVisualGaps(layoutNodes)

    // Extract computed styles per visual section (Site_Clone technique: getComputedStyle walker)
    // Pass Y-ranges from visual gap analysis so the browser finds elements by position, not by tag
    const sectionYRanges = visualSections.map(vs => ({ y: vs.y, h: vs.height }))

    const sectionStylesRaw = await page.evaluate(`((yRanges) => {
      const PROPS = [
        'fontSize','fontWeight','fontFamily','lineHeight','letterSpacing','color',
        'textTransform','textDecoration','textAlign',
        'backgroundColor','background','backgroundImage',
        'padding','paddingTop','paddingRight','paddingBottom','paddingLeft',
        'margin','marginTop','marginRight','marginBottom','marginLeft',
        'width','height','maxWidth','minWidth','maxHeight','minHeight',
        'display','flexDirection','justifyContent','alignItems','gap',
        'gridTemplateColumns','gridTemplateRows',
        'borderRadius','border','boxShadow',
        'overflow','position','top','right','bottom','left','zIndex',
        'opacity','transform','transition','cursor',
        'objectFit','objectPosition'
      ];
      const DEFAULTS = new Set(['none','normal','auto','0px','0','rgba(0, 0, 0, 0)','','0px 0px','0px 0px 0px 0px','start','stretch','visible','static']);
      const MAX_NODES = 500;
      const MAX_DEPTH = 8;

      function extractStyles(el) {
        const cs = getComputedStyle(el);
        const styles = {};
        for (const p of PROPS) {
          const v = cs[p];
          if (v && !DEFAULTS.has(v)) styles[p] = v;
        }
        return styles;
      }

      function selectorFor(el, parent) {
        const tag = el.tagName.toLowerCase();
        if (!parent) return tag;
        const siblings = [...parent.children].filter(c => c.tagName === el.tagName);
        if (siblings.length === 1) return tag;
        const idx = siblings.indexOf(el) + 1;
        return tag + ':nth-child(' + idx + ')';
      }

      let nodeCount = 0;
      function walk(el, depth, parentSelector) {
        if (depth > MAX_DEPTH || nodeCount >= MAX_NODES) return null;
        const rect = el.getBoundingClientRect();
        if (rect.height < 5 || rect.width < 5) return null;
        const tag = el.tagName.toLowerCase();
        if (['script','style','svg','path','link','meta','noscript'].includes(tag)) return null;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return null;

        nodeCount++;
        const seg = selectorFor(el, el.parentElement);
        const selector = parentSelector ? parentSelector + ' > ' + seg : seg;

        const isLeaf = el.children.length === 0;
        const isTextElement = ['h1','h2','h3','h4','h5','h6','p','span','a','li','label','strong','em','b','i','blockquote','figcaption','dt','dd'].includes(tag);
        const text = (isLeaf || isTextElement) && el.textContent ? el.textContent.trim().slice(0, 200) : null;
        const image = tag === 'img' ? {
          src: el.src || el.currentSrc || '',
          alt: el.alt || '',
          naturalWidth: el.naturalWidth || 0,
          naturalHeight: el.naturalHeight || 0
        } : null;

        const children = [];
        for (const child of el.children) {
          if (nodeCount >= MAX_NODES) break;
          const c = walk(child, depth + 1, selector);
          if (c) children.push(c);
        }

        return { tag, depth, selector, styles: extractStyles(el), text, image, children };
      }

      // Find the best DOM element for each visual section Y-range.
      // Uses document-relative coordinates (getBoundingClientRect + scrollY).
      // CMS-agnostic — works on any site regardless of HTML structure.
      function findElementForRange(y, h) {
        const scrollY = window.scrollY;
        const allEls = document.querySelectorAll('body *');
        let best = null;
        let bestScore = Infinity;
        for (const el of allEls) {
          const tag = el.tagName.toLowerCase();
          if (['script','style','svg','path','link','meta','noscript','br','hr'].includes(tag)) continue;
          const rect = el.getBoundingClientRect();
          const absY = rect.y + scrollY;
          const absH = rect.height;
          if (absH < 40 || rect.width < 100) continue;
          const overlapStart = Math.max(absY, y);
          const overlapEnd = Math.min(absY + absH, y + h);
          if (overlapEnd <= overlapStart) continue;
          const overlap = overlapEnd - overlapStart;
          const coverage = overlap / h;
          if (coverage < 0.5) continue;
          // Skip elements > 3x target height — page containers
          if (absH / h > 3) continue;
          // Score: prefer elements whose height is closest to the target
          const heightDiff = Math.abs(absH - h) / h;
          if (heightDiff < bestScore) {
            bestScore = heightDiff;
            best = el;
          }
        }
        return best;
      }

      return yRanges.slice(0, 20).map((range, i) => {
        const el = findElementForRange(range.y, range.h);
        if (!el) return { sectionIndex: i, root: null, matched: false };
        nodeCount = 0;
        const root = walk(el, 0, '');
        return root ? { sectionIndex: i, root, matched: true } : { sectionIndex: i, root: null, matched: false };
      });
    })(${JSON.stringify(sectionYRanges)})`) as Array<{ sectionIndex: number; root: import("./types.ts").ComputedStyleNode | null; matched: boolean }>

    // Identify unmatched visual sections (no DOM element found for Y-range)
    const unmatchedIndices = sectionStylesRaw
      .filter(s => !s.matched)
      .map(s => s.sectionIndex)

    // Extract the actual SectionStyles (filtering out unmatched)
    const sectionStyles: import("./types.ts").SectionStyles[] = sectionStylesRaw
      .filter(s => s.matched && s.root)
      .map(s => ({ sectionIndex: s.sectionIndex, root: s.root! }))

    // Fallback content extraction for unmatched visual sections.
    // When findElementForRange fails, collect all text-bearing elements within the Y-range.
    let sectionFallbackContent: FullPageScrape["sectionFallbackContent"]
    if (unmatchedIndices.length > 0) {
      const unmatchedRanges = unmatchedIndices.map(i => ({
        sectionIndex: i,
        ...sectionYRanges[i],
      }))
      sectionFallbackContent = await page.evaluate(`((ranges) => {
        const scrollY = window.scrollY;
        return ranges.map(({ sectionIndex, y, h }) => {
          const headings = [];
          const paragraphs = [];
          const links = [];
          const listItems = [];
          const seen = new Set();

          // Scan all relevant elements by Y position
          const allEls = document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,a,li,span,div,td,th,dt,dd,label,figcaption,blockquote');
          for (const el of allEls) {
            const rect = el.getBoundingClientRect();
            const absY = rect.y + scrollY;
            if (rect.height < 5 || rect.width < 50) continue;
            // Element must be within section Y-range
            if (absY < y - 20 || absY > y + h + 20) continue;

            const tag = el.tagName.toLowerCase();
            const text = el.textContent ? el.textContent.trim().slice(0, 300) : '';
            if (!text || text.length < 2) continue;

            // Deduplicate by text content (Elementor often has nested wrappers with same text)
            const key = tag + ':' + text.slice(0, 80);
            if (seen.has(key)) continue;
            seen.add(key);

            if (['h1','h2','h3','h4','h5','h6'].includes(tag)) {
              const level = parseInt(tag[1]);
              headings.push({ level, text });
            } else if (tag === 'a' && el.href) {
              links.push({ href: el.href, text });
            } else if (tag === 'li') {
              listItems.push(text);
            } else if (tag === 'p' || (tag === 'div' && el.children.length === 0 && text.length > 20)) {
              // Include leaf div text as paragraphs (Elementor uses divs for text)
              paragraphs.push(text);
            }
          }

          // Group list items into lists (each contiguous group = one list)
          const lists = listItems.length > 0 ? [listItems] : [];

          return { sectionIndex, headings, paragraphs, links, lists };
        });
      })(${JSON.stringify(unmatchedRanges)})`) as NonNullable<FullPageScrape["sectionFallbackContent"]>
    }

    // Take full-page screenshots at desktop and mobile viewports
    let screenshot: ScreenshotResult | null = null
    let mobileScreenshot: ScreenshotResult | null = null
    try {
      const buffer = await page.screenshot({ fullPage: true, type: "jpeg", quality: 75 })
      screenshot = { base64: buffer.toString("base64"), viewport: { width, height } }
    } catch { /* non-fatal */ }

    // Mobile screenshot (390px) — captures responsive layout for better block decisions
    try {
      const mobileWidth = 390
      await page.setViewportSize({ width: mobileWidth, height })
      await page.waitForTimeout(500) // let responsive styles settle
      const buffer = await page.screenshot({ fullPage: true, type: "jpeg", quality: 60 })
      mobileScreenshot = { base64: buffer.toString("base64"), viewport: { width: mobileWidth, height } }
      // Restore desktop viewport
      await page.setViewportSize({ width, height })
    } catch { /* non-fatal */ }

    // ── Interaction sweep: click tabs/accordions, detect scroll triggers ──
    // Captures style changes from dynamic interactions for better block classification.
    let interactionStates: FullPageScrape["interactionStates"]
    try {
      interactionStates = await page.evaluate(`(async () => {
        const delay = ms => new Promise(r => setTimeout(r, ms));
        const STYLE_PROPS = ['display','visibility','opacity','height','maxHeight','transform','backgroundColor','color','overflow'];
        const results = [];

        function getStyles(el) {
          const cs = getComputedStyle(el);
          const s = {};
          for (const p of STYLE_PROPS) { s[p] = cs[p]; }
          return s;
        }

        function diffStyles(before, after) {
          const changed = {};
          for (const p of STYLE_PROPS) {
            if (before[p] !== after[p]) changed[p] = { before: before[p], after: after[p] };
          }
          return Object.keys(changed).length > 0 ? changed : null;
        }

        // 1. Tab clicks: find [role=tab] or elements with tab-like classes
        const tabTriggers = [...document.querySelectorAll('[role="tab"], [data-toggle="tab"], .tab-link, .tabs__tab, .e-n-tab-title')].slice(0, 10);
        for (const trigger of tabTriggers) {
          const rect = trigger.getBoundingClientRect();
          const scrollY = window.scrollY;
          const sectionY = Math.round(rect.y + scrollY);
          // Find the associated panel
          const panelId = trigger.getAttribute('aria-controls') || trigger.getAttribute('data-target');
          const panel = panelId ? document.getElementById(panelId) || document.querySelector(panelId) : trigger.closest('[role="tablist"]')?.parentElement?.querySelector('[role="tabpanel"]');
          if (!panel) continue;

          const beforeStyles = getStyles(panel);
          trigger.click();
          await delay(350);
          const afterStyles = getStyles(panel);
          const changed = diffStyles(beforeStyles, afterStyles);
          if (changed) {
            const transition = getComputedStyle(panel).transition || '';
            results.push({
              sectionY,
              states: [{ trigger: 'click', triggerTarget: 'tab: ' + (trigger.textContent || '').trim().slice(0, 50), changedStyles: changed, transitionDuration: transition.includes('0s') ? undefined : transition.split(',')[0]?.trim() }]
            });
          }
        }

        // 2. Accordion clicks: find <details>, [data-toggle="collapse"], accordion triggers
        const accordionTriggers = [...document.querySelectorAll('details > summary, [data-toggle="collapse"], .accordion-header, .accordion-trigger, .e-n-accordion-item-title')].slice(0, 10);
        for (const trigger of accordionTriggers) {
          const rect = trigger.getBoundingClientRect();
          const scrollY = window.scrollY;
          const sectionY = Math.round(rect.y + scrollY);
          const parent = trigger.closest('details') || trigger.parentElement;
          if (!parent) continue;
          const content = parent.querySelector('.accordion-content, .accordion-body, .collapse, [role="region"], details > :not(summary)') || (trigger.tagName === 'SUMMARY' ? trigger.parentElement : null);
          if (!content) continue;

          const beforeStyles = getStyles(content);
          trigger.click();
          await delay(350);
          const afterStyles = getStyles(content);
          const changed = diffStyles(beforeStyles, afterStyles);
          if (changed) {
            const transition = getComputedStyle(content).transition || '';
            results.push({
              sectionY,
              states: [{ trigger: 'click', triggerTarget: 'accordion: ' + (trigger.textContent || '').trim().slice(0, 50), changedStyles: changed, transitionDuration: transition.includes('0s') ? undefined : transition.split(',')[0]?.trim() }]
            });
          }
        }

        // 3. Scroll-triggered elements: check for elements that change on scroll
        const stickyEls = [...document.querySelectorAll('header, nav, [class*="sticky"], [class*="fixed"]')].slice(0, 5);
        if (stickyEls.length > 0) {
          window.scrollTo(0, 0);
          await delay(200);
          const beforeMap = stickyEls.map(el => ({ el, styles: getStyles(el) }));
          window.scrollTo(0, 500);
          await delay(400);
          for (const { el, styles: before } of beforeMap) {
            const after = getStyles(el);
            const changed = diffStyles(before, after);
            if (changed) {
              const rect = el.getBoundingClientRect();
              results.push({
                sectionY: 0, // scroll triggers are typically at page top
                states: [{ trigger: 'scroll', triggerTarget: el.tagName.toLowerCase() + (el.className ? '.' + el.className.toString().split(' ')[0] : ''), changedStyles: changed }]
              });
            }
          }
          window.scrollTo(0, 0);
          await delay(200);
        }

        return results;
      })()`) as NonNullable<FullPageScrape["interactionStates"]>

      // 4. Hover state capture for buttons and links (uses Playwright hover API)
      const hoverTargets = await page.evaluate(`(() => {
        const targets = [];
        const els = document.querySelectorAll('a, button, [role="button"]');
        for (const el of [...els].slice(0, 15)) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 20 || rect.height < 20) continue;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          // Only capture elements that have non-transparent backgrounds (likely CTA/buttons)
          const bg = cs.backgroundColor;
          const hasBg = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
          const hasBoxShadow = cs.boxShadow && cs.boxShadow !== 'none';
          if (!hasBg && !hasBoxShadow && el.tagName !== 'BUTTON') continue;
          const scrollY = window.scrollY;
          targets.push({
            selector: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className ? '.' + el.className.toString().split(' ').filter(Boolean).join('.') : ''),
            y: Math.round(rect.y + scrollY),
            beforeStyles: {
              backgroundColor: cs.backgroundColor,
              color: cs.color,
              transform: cs.transform,
              boxShadow: cs.boxShadow,
              borderColor: cs.borderColor,
              opacity: cs.opacity,
              transition: cs.transition,
            }
          });
        }
        return targets;
      })()`) as Array<{ selector: string; y: number; beforeStyles: Record<string, string> }>

      for (const target of hoverTargets.slice(0, 8)) {
        try {
          const el = page.locator(target.selector).first()
          if (!await el.isVisible().catch(() => false)) continue
          await el.hover({ timeout: 1000 })
          await page.waitForTimeout(200)
          const afterStyles = await el.evaluate(`(el) => {
            const cs = getComputedStyle(el);
            return {
              backgroundColor: cs.backgroundColor,
              color: cs.color,
              transform: cs.transform,
              boxShadow: cs.boxShadow,
              borderColor: cs.borderColor,
              opacity: cs.opacity,
            };
          }`) as Record<string, string>

          const changed: Record<string, { before: string; after: string }> = {}
          for (const [prop, before] of Object.entries(target.beforeStyles)) {
            if (prop === "transition") continue
            const after = afterStyles[prop] ?? before
            if (before !== after) changed[prop] = { before, after }
          }
          if (Object.keys(changed).length > 0) {
            if (!interactionStates) interactionStates = []
            interactionStates.push({
              sectionY: target.y,
              states: [{
                trigger: "hover" as const,
                triggerTarget: target.selector,
                changedStyles: changed,
                transitionDuration: target.beforeStyles.transition?.includes("0s") ? undefined : target.beforeStyles.transition?.split(",")[0]?.trim(),
              }],
            })
          }
        } catch { /* non-fatal */ }
      }
    } catch {
      // Non-fatal — interaction sweep failure shouldn't block scraping
    }

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

    return { content, screenshot, mobileScreenshot, sections, outline, nav, sectionStyles, visualSections, embeds, videos, scrollBehavior, computedFonts, pageImages, imageCompositions, sectionFallbackContent, resolvedCssVars, interactionStates }
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

  // 3. Fall back to BFS link crawling (depth 2, max 50 pages)
  const linkPages = await bfsCrawlLinks(url, origin, 2, 50)
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

/** BFS crawl: discover pages by following internal links up to maxDepth levels, capped at maxPages */
async function bfsCrawlLinks(startUrl: string, origin: string, maxDepth: number, maxPages: number): Promise<DiscoveredPage[]> {
  const seen = new Set<string>()
  const pages: DiscoveredPage[] = []
  const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }]

  while (queue.length > 0 && pages.length < maxPages) {
    const { url, depth } = queue.shift()!
    if (depth > maxDepth) continue

    const slug = urlToSlug(url)
    if (seen.has(slug)) continue
    seen.add(slug)
    pages.push({ url, slug, title: slugToTitle(slug) })

    // Only crawl deeper if below max depth
    if (depth < maxDepth) {
      const childPages = await extractLinksFromPage(url, origin)
      for (const child of childPages) {
        if (!seen.has(child.slug) && pages.length + queue.length < maxPages * 2) {
          queue.push({ url: child.url, depth: depth + 1 })
        }
      }
    }
  }

  return pages
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
