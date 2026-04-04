/**
 * Migration tools for the sites-agent — higher-level alternatives to scrape_url
 * that include computed style extraction and section spec generation.
 *
 * These give the LLM rich, block-type-agnostic data so it can decide:
 * use an existing block type OR spawn block-coder for a custom one.
 */

import { tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { writeFile, mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { homedir } from "node:os"
import {
  scrapeFullPage,
  buildPageSpecs,
  extractDesignTokens,
  mapToThemeVariables,
  augmentThemeFromComputedStyles,
} from "@ai-site-editor/migration-sdk"
import { getCachedScrape, setCachedScrape } from "./scrape-cache.js"

export const MIGRATION_DEBUG_DIR = resolve(homedir(), ".data/migration-debug")

function debugFilename(url: string, suffix: string): string {
  const slug = url.replace(/https?:\/\//, "").replace(/[^a-z0-9]+/gi, "-").slice(0, 60)
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  return `${ts}_${slug}_${suffix}`
}

/** Save a base64 screenshot to disk for post-run analysis. */
export async function saveScreenshot(label: string, base64: string, url: string): Promise<string> {
  await mkdir(MIGRATION_DEBUG_DIR, { recursive: true })
  const filepath = resolve(MIGRATION_DEBUG_DIR, debugFilename(url, `${label}.jpg`))
  await writeFile(filepath, Buffer.from(base64, "base64"))
  return filepath
}

/** Save full scrape debug data (specs, tokens, nav) to JSON for analysis. */
export async function saveScrapeDebug(url: string, data: Record<string, unknown>): Promise<string> {
  await mkdir(MIGRATION_DEBUG_DIR, { recursive: true })
  const filepath = resolve(MIGRATION_DEBUG_DIR, debugFilename(url, "specs.json"))
  await writeFile(filepath, JSON.stringify(data, null, 2), "utf-8")
  return filepath
}

/**
 * Primary migration tool: scrape a URL and generate block-type-agnostic
 * section specs with exact computed CSS styles, DOM structure, content,
 * and design notes.
 */
const generatePageSpecsTool = tool(
  "generate_page_specs",
  `Scrape a URL and generate detailed section specs with exact computed CSS styles, DOM structure, content, and design notes.
Returns block-type-agnostic specs — use them to decide which sections map to existing blocks and which need custom blocks via block-coder.

Each spec contains:
- content: verbatim text, images, links from the source section
- structure: layout pattern, repeat count/signature, interaction model (static/accordion/tabs/carousel)
- styles: exact computed CSS for container, heading, body text, repeated items, CTA buttons
- designNotes: colors, fonts, layout summary, gradients, shadows
- suggestedBlockType: heuristic hint (not authoritative — you decide)

Also returns designTokens (colors, fonts, radii) and themeVariables (CSS custom property mapping).`,
  { url: z.string().url().describe("The URL to scrape and analyze") },
  async ({ url }) => {
    try {
      const cached = !!getCachedScrape(url)
      const t0 = Date.now()
      let scrape = getCachedScrape(url)
      if (!scrape) {
        console.log(`[generate_page_specs] Scraping ${url}...`)
        scrape = await scrapeFullPage(url)
        setCachedScrape(url, scrape)
      }
      const scrapeMs = Date.now() - t0

      const specs = buildPageSpecs(scrape)
      const tokens = extractDesignTokens(scrape.content.css, scrape.resolvedCssVars)
      let theme = mapToThemeVariables(tokens)

      // Augment theme with actual computed CSS values from section specs.
      // Computed styles (getComputedStyle) are far more reliable than CSS regex,
      // especially for CMS sites using CSS variables, inline styles, or shadow DOM.
      const sectionStyleData = specs
        .filter(s => Object.keys(s.styles.container).length > 0)
        .map(s => s.styles)
      if (sectionStyleData.length > 0) {
        // Collect hover states from interaction sweep for brand-hover extraction
        const hoverStates = scrape.interactionStates
          ?.flatMap(is => is.states)
          .filter(s => s.trigger === "hover")
          .map(s => ({ triggerTarget: s.triggerTarget, changedStyles: s.changedStyles }))
        theme = augmentThemeFromComputedStyles(theme, sectionStyleData, hoverStates)
      }

      // Override fonts with computed values (more reliable than CSS regex)
      if (scrape.computedFonts) {
        if (scrape.computedFonts.heading) theme["--font-heading"] = scrape.computedFonts.heading + ", sans-serif"
        if (scrape.computedFonts.body) theme["--font-body"] = scrape.computedFonts.body + ", sans-serif"
      }

      const totalMs = Date.now() - t0

      // Log summary
      console.log(
        `[generate_page_specs] ${url} → ${specs.length} sections, ` +
        `${tokens.colors.length} colors, ${tokens.fonts.length} fonts | ` +
        `${cached ? "cached" : `scraped in ${scrapeMs}ms`} | total ${totalMs}ms`
      )
      for (const spec of specs) {
        const blockHint = spec.suggestedBlockType ?? "unknown"
        const conf = spec.suggestedConfidence.toFixed(2)
        const pattern = spec.structure.pattern
        const repeat = spec.structure.repeatCount > 0 ? ` (${spec.structure.repeatCount}x ${spec.structure.repeatSignature ?? "?"})` : ""
        const headings = spec.content.headings.map(h => h.text).join(", ").slice(0, 80)
        console.log(
          `  [${spec.sectionIndex}] ${blockHint} (${conf}) — ${pattern}${repeat}` +
          (headings ? ` — "${headings}"` : "")
        )
      }

      // Save debug artifacts to ~/.data/migration-debug/
      const debugData: Record<string, unknown> = {
        url,
        scrapedAt: new Date().toISOString(),
        scrapeMs,
        totalMs,
        cached,
        pageTitle: scrape.content.title,
        pageDescription: scrape.content.metaDescription,
        sectionCount: specs.length,
        visualSectionCount: scrape.visualSections?.length ?? 0,
        specs,
        designTokens: tokens,
        themeVariables: theme,
        nav: scrape.nav,
        embeds: scrape.embeds,
        videos: scrape.videos,
        imageCompositions: scrape.imageCompositions?.length ? scrape.imageCompositions : undefined,
        computedFonts: scrape.computedFonts,
      }

      // Fire-and-forget debug artifact saves — non-critical, don't block tool return
      const debugWrites: Promise<string>[] = []
      if (scrape.screenshot) debugWrites.push(saveScreenshot("desktop", scrape.screenshot.base64, url))
      if (scrape.mobileScreenshot) debugWrites.push(saveScreenshot("mobile", scrape.mobileScreenshot.base64, url))
      debugWrites.push(saveScrapeDebug(url, debugData))
      Promise.all(debugWrites)
        .then(files => console.log(`[generate_page_specs] Debug artifacts saved: ${files.map(f => f.split("/").pop()).join(", ")}`))
        .catch(e => console.warn(`[generate_page_specs] Failed to save debug artifacts: ${e instanceof Error ? e.message : String(e)}`))

      const result = {
        pageTitle: scrape.content.title,
        pageDescription: scrape.content.metaDescription,
        sectionCount: specs.length,
        specs,
        designTokens: tokens,
        themeVariables: theme,
        nav: scrape.nav,
      }

      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/jpeg" }> = [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ]
      // Include screenshots so the LLM can visually analyze sections
      if (scrape.screenshot) content.push({ type: "image" as const, data: scrape.screenshot.base64, mimeType: "image/jpeg" as const })
      if (scrape.mobileScreenshot) content.push({ type: "image" as const, data: scrape.mobileScreenshot.base64, mimeType: "image/jpeg" as const })

      return { content }
    } catch (e: unknown) {
      console.error(`[generate_page_specs] ERROR for ${url}:`, e instanceof Error ? e.message : String(e))
      return {
        content: [{ type: "text" as const, text: `Error generating page specs: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      }
    }
  },
  { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } }
)

/** Returns all migration tools for the sites-agent MCP server. */
export function createMigrationTools() {
  return [generatePageSpecsTool]
}
