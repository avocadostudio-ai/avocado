/**
 * Site-level agent tools using Claude Agent SDK's tool() format.
 *
 * 8 tools for site creation and migration:
 * - list_sites, create_site, scrape_url (with screenshot), extract_design_tokens,
 *   bootstrap_pages, download_remote_image, apply_theme, discover_site_structure
 */

import { mkdir, writeFile, readFile } from "node:fs/promises"
import { resolve, join, dirname } from "node:path"
import { existsSync } from "node:fs"
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk"
import { createMigrationTools } from "../migration/migration-tools.js"
import { z } from "zod"
import { getAllBlockMeta, defaultPropsForType, validateBlockProps, type BlockType } from "@ai-site-editor/shared"
import { fetchPageContent, takeScreenshot, downloadImage, extractDesignTokens, mapToThemeVariables, discoverSitePages, scrapeFullPage } from "@ai-site-editor/migration-sdk"
import { getCachedScrape, setCachedScrape } from "../migration/scrape-cache.js"
import { saveScreenshot } from "../migration/migration-tools.js"
import { scopedSessionKey, setPage, bumpVersion, getSiteConfig, setSiteConfig } from "../state/session-state.js"
import {
  listImages as listGdriveImages, downloadImage as downloadGdriveImage,
  isGdriveConfigured, resolveGdriveFolderId, fileNameToAlt,
} from "../image/gdrive-client.js"
import sharp from "sharp"
import {
  sanitizeSiteId, monorepoRoot, findAvailablePort, patchGlobalsCssVars,
  validateAndCorrectProps, fixFooterLinks, normalizePageBlocks, scaffoldSiteProject,
  analyzeCodebase, cloneRepo, detectSitePort, startAndWaitForDevServer,
  getDraftModeSecret,
  packageJson, nextConfigTs, tsconfigJson, postcssConfig, layoutTsx,
  globalsCss, defaultsTs, editorApiRoute, pageTsx, hybridPageTsx, blocksRegisterTsx,
  samplePagesJson, defaultLogoSvg, faviconSvg,
} from "./sites-agent-shared.js"

/** Convert a package name like "villa-puravida-web" → "Villa Puravida Web" */
function humanizePkgName(name: string): string {
  return name
    .replace(/^@[^/]+\//, "") // strip scope
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim() || "My Site"
}

// Match remote image URLs — extension-based OR known image CDN hostnames
const IMAGE_URL_RE = /^https?:\/\/.+\.(jpe?g|png|webp|gif|svg|avif|ico)(\?.*)?$/i
const IMAGE_CDN_RE = /^https?:\/\/(images\.unsplash\.com|plus\.unsplash\.com|res\.cloudinary\.com|images\.ctfassets\.net|cdn\.sanity\.io)/i

function isRemoteImageUrl(url: string): boolean {
  return IMAGE_URL_RE.test(url) || IMAGE_CDN_RE.test(url)
}

/** Recursively walk props and download any remote image URLs, replacing with local paths. */
async function localizeRemoteImages(
  props: Record<string, unknown>,
  imagesDir: string,
): Promise<{ props: Record<string, unknown>; downloaded: number }> {
  let downloaded = 0

  async function walk(value: unknown): Promise<unknown> {
    if (typeof value === "string" && isRemoteImageUrl(value)) {
      try {
        const result = await downloadImage(value, undefined, imagesDir)
        downloaded++
        console.log(`[sites-agent] Auto-downloaded remote image: ${value} → ${result.localPath}`)
        return `/images/${result.fileName}`
      } catch {
        console.warn(`[sites-agent] Failed to auto-download image: ${value}`)
        return value
      }
    }
    if (Array.isArray(value)) {
      return Promise.all(value.map(walk))
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>)
      const resolved = await Promise.all(entries.map(([, v]) => walk(v)))
      const result: Record<string, unknown> = {}
      entries.forEach(([k], i) => { result[k] = resolved[i] })
      return result
    }
    return value
  }

  const result = await walk(props) as Record<string, unknown>
  return { props: result, downloaded }
}

// Shared utilities imported from sites-agent-shared.ts

/**
 * Create the MCP server with all sites-agent tools.
 */
export function createSitesAgentMcpServer(options: {
  session: string
  emitSiteCreated: (config: Record<string, unknown>) => void
  emitPhaseOutcome?: (outcome: { tool: string; data: Record<string, unknown> }) => void
}) {
  const { session, emitSiteCreated, emitPhaseOutcome } = options

  // ── LIST SITES ──
  const listSitesTool = tool(
    "list_sites",
    "List all site project directories in the monorepo apps/ folder.",
    {},
    async () => {
      try {
        const root = monorepoRoot()
        const appsDir = join(root, "apps")
        const { readdir, stat } = await import("node:fs/promises")
        const entries = await readdir(appsDir)
        const sites: { id: string; path: string; hasPackageJson: boolean }[] = []
        for (const entry of entries) {
          if (entry === "editor" || entry === "orchestrator") continue
          const entryPath = join(appsDir, entry)
          const s = await stat(entryPath).catch(() => null)
          if (!s?.isDirectory()) continue
          const hasPkg = existsSync(join(entryPath, "package.json"))
          sites.push({ id: entry, path: entryPath, hasPackageJson: hasPkg })
        }
        return { content: [{ type: "text" as const, text: JSON.stringify({ sites }) }] }
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
      }
    },
    { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }
  )

  // ── DISCOVER SITE STRUCTURE ──
  const discoverStructureTool = tool(
    "discover_site_structure",
    "Discover all pages on a website by checking sitemap.xml, robots.txt, and crawling links from the homepage. Returns a list of pages with URLs and slugs. Use this before migration to understand the site's page structure.",
    {
      url: z.string().describe("Homepage URL of the site to analyze, e.g. 'https://example.com'"),
    },
    async (args) => {
      try {
        console.log(`[discover_structure] Discovering pages on ${args.url}...`)
        const structure = await discoverSitePages(args.url)
        console.log(`[discover_structure] Found ${structure.totalFound} pages via ${structure.source} on ${structure.origin}`)
        emitPhaseOutcome?.({ tool: "discover_site_structure", data: { totalPages: structure.totalFound, origin: structure.origin } })
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              origin: structure.origin,
              source: structure.source,
              totalPages: structure.totalFound,
              pages: structure.pages,
            }),
          }],
        }
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error discovering site structure: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
      }
    },
    { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } }
  )

  // ── CREATE SITE ──
  const createSiteTool = tool(
    "create_site",
    "Scaffold a complete, runnable Next.js site project in the monorepo. Creates package.json, next.config, layout, page routing, editor API integration, and content files. After creation the site is ready to run with 'pnpm dev'.",
    {
      name: z.string().describe("Human-readable site name, e.g. 'My Portfolio'"),
      siteId: z.string().optional().describe("Kebab-case ID. If omitted, derived from name."),
      purpose: z.string().optional().describe("What the site is about (used in AI context)"),
      tone: z.string().optional().describe("Voice/tone for AI editing"),
      port: z.number().optional().describe("Dev server port (auto-assigned if omitted)"),
    },
    async (args) => {
      try {
        const siteId = args.siteId?.trim() || sanitizeSiteId(args.name)
        const root = monorepoRoot()
        const projectDir = join(root, "apps", siteId)

        let existingPort = 0
        if (existsSync(projectDir)) {
          // Clean content from previous migration but keep project skeleton (package.json, node_modules, etc.)
          const { rm } = await import("node:fs/promises")
          for (const dir of ["content", "blocks", "public/images", ".next"]) {
            const target = join(projectDir, dir)
            if (existsSync(target)) await rm(target, { recursive: true, force: true })
          }
          console.log(`[sites-agent] Cleaned previous content from apps/${siteId}`)

          // Reuse the existing port if not explicitly overridden
          if (!args.port) {
            try {
              const existingPkg = JSON.parse(await readFile(join(projectDir, "package.json"), "utf-8"))
              const portMatch = existingPkg.scripts?.dev?.match(/-p\s*(\d+)/)
              if (portMatch) existingPort = Number(portMatch[1])
            } catch { /* use new port */ }
          }
        }

        // Validate requested/existing port is actually free; fall back to auto-assign
        let port = args.port || existingPort || 0
        if (port) {
          const { createServer } = await import("node:net")
          const free = await new Promise<boolean>((res) => {
            const s = createServer()
            s.once("error", () => res(false))
            s.once("listening", () => { s.close(() => res(true)) })
            s.listen(port, "127.0.0.1")
          })
          if (!free) {
            console.log(`[create_site] Requested port ${port} in use, auto-assigning...`)
            port = 0
          }
        }
        if (!port) port = await findAvailablePort(root)
        console.log(`[create_site] START siteId=${siteId} port=${port} name="${args.name}"`)

        // Create project structure
        await mkdir(projectDir, { recursive: true })
        await writeFile(join(projectDir, "package.json"), packageJson(siteId, args.name, port), "utf-8")
        await writeFile(join(projectDir, "next.config.ts"), nextConfigTs(), "utf-8")
        await writeFile(join(projectDir, "tsconfig.json"), tsconfigJson(), "utf-8")
        await writeFile(join(projectDir, "postcss.config.mjs"), postcssConfig(), "utf-8")
        await mkdir(join(projectDir, "app"), { recursive: true })
        await writeFile(join(projectDir, "app/layout.tsx"), layoutTsx(args.name), "utf-8")
        await writeFile(join(projectDir, "app/globals.css"), globalsCss(), "utf-8")
        await mkdir(join(projectDir, "app/api/editor/[...path]"), { recursive: true })
        await writeFile(join(projectDir, "app/api/editor/[...path]/route.ts"), editorApiRoute(), "utf-8")
        await mkdir(join(projectDir, "app/[[...slug]]"), { recursive: true })
        await writeFile(join(projectDir, "app/[[...slug]]/page.tsx"), pageTsx(siteId), "utf-8")
        await mkdir(join(projectDir, "content"), { recursive: true })
        await writeFile(join(projectDir, "content/pages.json"), samplePagesJson(), "utf-8")
        await mkdir(join(projectDir, "lib"), { recursive: true })
        await writeFile(join(projectDir, "lib/defaults.ts"), defaultsTs(siteId, args.name), "utf-8")
        await mkdir(join(projectDir, "public"), { recursive: true })
        await writeFile(join(projectDir, "public/.gitkeep"), "", "utf-8")
        await mkdir(join(projectDir, "blocks"), { recursive: true })
        await writeFile(join(projectDir, "blocks/register.tsx"), blocksRegisterTsx(), "utf-8")
        await writeFile(join(projectDir, "public/logo.svg"), defaultLogoSvg(args.name), "utf-8")
        await writeFile(join(projectDir, "public/favicon.svg"), faviconSvg(args.name), "utf-8")

        const envContent = `ORCHESTRATOR_URL=http://localhost:4200\nDRAFT_MODE_SECRET=${getDraftModeSecret()}\nNEXT_PUBLIC_DEFAULT_SITE_ID=${siteId}\nNEXT_PUBLIC_SITE_NAME=${args.name}\nNEXT_PUBLIC_EDITOR_ORIGIN=http://localhost:4100\n`
        await writeFile(join(projectDir, ".env.local"), envContent, "utf-8")
        console.log(`[create_site] Wrote 13 project files to apps/${siteId}/`)

        // Run pnpm install if needed (skip if node_modules exists from previous run)
        if (!existsSync(join(projectDir, "node_modules"))) {
          console.log(`[create_site] Running pnpm install...`)
          const { execFile } = await import("node:child_process")
          const { promisify } = await import("node:util")
          await promisify(execFile)("pnpm", ["install", "--no-frozen-lockfile"], { cwd: root, timeout: 60_000 })
          console.log(`[create_site] pnpm install complete`)
        } else {
          console.log(`[create_site] Skipping pnpm install — node_modules exists`)
        }

        const siteConfig = {
          id: siteId,
          name: args.name,
          purpose: args.purpose ?? "",
          tone: args.tone ?? "",
          hosting: "local",
          previewUrl: `http://localhost:${port}`,
          constraints: [],
        }

        // Initialize orchestrator session
        const sessionKey = scopedSessionKey(session, siteId)
        setPage(sessionKey, {
          id: "p_home", slug: "/", title: "Home", blocks: [], updatedAt: new Date().toISOString(),
        })
        bumpVersion(sessionKey)

        // Start dev server and wait for it to be ready
        console.log(`[create_site] Starting dev server on port ${port}...`)
        const { serverReady } = await startAndWaitForDevServer({
          siteId, port, cwd: root, useFilter: true,
        })
        console.log(`[create_site] Dev server ${serverReady ? "READY" : "FAILED"} on port ${port}`)

        emitSiteCreated(siteConfig)
        emitPhaseOutcome?.({ tool: "create_site", data: { siteId, port, name: args.name, serverReady } })
        console.log(`[create_site] DONE siteId=${siteId} port=${port} serverReady=${serverReady}`)

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "site_created",
              config: siteConfig,
              projectPath: projectDir,
              port,
              devServerStarted: serverReady,
              instructions: serverReady
                ? `Site scaffolded at apps/${siteId} and dev server running on port ${port}.`
                : `Site scaffolded at apps/${siteId} but dev server failed to start on port ${port}.`,
            }),
          }],
        }
      } catch (e: unknown) {
        console.error(`[create_site] ERROR: ${e instanceof Error ? e.message : String(e)}`)
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
      }
    },
    { annotations: { destructiveHint: false, openWorldHint: false } }
  )

  // ── SCRAPE URL (Playwright: rendered DOM + screenshot + sections) ──
  const scrapeUrlTool = tool(
    "scrape_url",
    "Scrape a web page using a headless browser. Returns: page title/meta, pre-extracted sections with block type suggestions, design tokens, and a full-page screenshot. Handles JS-rendered content, Elementor, and lazy-loaded images. Use this to analyze an existing website for migration.",
    {
      url: z.string().describe("Full URL to scrape, e.g. 'https://example.com'"),
    },
    async (args) => {
      try {
        const scrapeStart = Date.now()
        let result = getCachedScrape(args.url)
        const cached = !!result
        if (!result) {
          console.log(`[scrape_url] Scraping ${args.url} (browser)...`)
          result = await scrapeFullPage(args.url)
          setCachedScrape(args.url, result)
        }
        const { content, screenshot, sections, outline, nav } = result
        console.log(`[scrape_url] ${cached ? "CACHED" : "SCRAPED"} ${args.url} in ${Date.now() - scrapeStart}ms — ${sections.length} sections, screenshot=${!!screenshot}, nav=${!!nav}`)

        // Extract design tokens from CSS (with resolved CSS variables from Playwright)
        const tokens = extractDesignTokens(content.css, result.resolvedCssVars)
        const themeVars = mapToThemeVariables(tokens)

        const textData = JSON.stringify({
          title: content.title,
          metaDescription: content.metaDescription,
          baseUrl: content.baseUrl,
          navigation: nav ? { siteName: nav.siteName, logoUrl: nav.logoUrl, items: nav.items } : null,
          // Page outline — compact representation of ALL sections on the page (~2KB)
          // USE THIS as the primary source for identifying sections and blocks.
          pageOutline: outline,
          // Extracted sections with structured content (no rawHtml to save tokens)
          sections: sections.map(s => ({
            index: s.index,
            suggestedBlockType: s.suggestedBlockType,
            classHints: s.classHints,
            id: s.id,
            content: s.content,
          })),
          sectionCount: sections.length,
          designTokens: { colors: tokens.colors.slice(0, 15), fonts: tokens.fonts, radii: tokens.radii.slice(0, 5) },
          themeVariables: themeVars,
        })

        const { mobileScreenshot } = result
        const contentBlocks: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/jpeg" }> = [
          { type: "text" as const, text: textData },
        ]
        if (screenshot) contentBlocks.push({ type: "image" as const, data: screenshot.base64, mimeType: "image/jpeg" as const })
        if (mobileScreenshot) contentBlocks.push({ type: "image" as const, data: mobileScreenshot.base64, mimeType: "image/jpeg" as const })

        // Fire-and-forget screenshot saves — non-critical debug artifacts
        const writes: Promise<string>[] = []
        if (screenshot) writes.push(saveScreenshot("desktop", screenshot.base64, args.url))
        if (mobileScreenshot) writes.push(saveScreenshot("mobile", mobileScreenshot.base64, args.url))
        if (writes.length) Promise.all(writes).then(() => console.log(`[scrape_url] Screenshots saved`)).catch(() => {})

        return { content: contentBlocks }
      } catch (e: unknown) {
        // Fall back to simple HTTP fetch (no browser)
        try {
          console.warn(`[sites-agent] Browser scrape failed, falling back to HTTP: ${e instanceof Error ? e.message : String(e)}`)
          const content = await fetchPageContent(args.url)
          const { extractSections: extract, extractPageOutline: outline, extractNavigation: navExtract } = await import("@ai-site-editor/migration-sdk")
          const sections = extract(content.html, content.baseUrl)
          const pageOutline = outline(content.html, content.baseUrl)
          const navResult = navExtract(content.html, content.baseUrl)
          const tokens = extractDesignTokens(content.css)
          const themeVars = mapToThemeVariables(tokens)

          const textData = JSON.stringify({
            title: content.title,
            metaDescription: content.metaDescription,
            baseUrl: content.baseUrl,
            navigation: navResult ? { siteName: navResult.siteName, logoUrl: navResult.logoUrl, items: navResult.items } : null,
            pageOutline,
            sections: sections.map(s => ({
              index: s.index,
              suggestedBlockType: s.suggestedBlockType,
              classHints: s.classHints,
              content: s.content,
            })),
            sectionCount: sections.length,
            designTokens: { colors: tokens.colors.slice(0, 15), fonts: tokens.fonts, radii: tokens.radii.slice(0, 5) },
            themeVariables: themeVars,
          })

          return { content: [{ type: "text" as const, text: textData }] }
        } catch (fallbackErr: unknown) {
          return { content: [{ type: "text" as const, text: `Error scraping URL: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}` }], isError: true }
        }
      }
    },
    { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } }
  )

  // ── EXTRACT DESIGN TOKENS ──
  const extractTokensTool = tool(
    "extract_design_tokens",
    "Extract design tokens (colors, fonts, border radii) from CSS text. Maps them to theme variables (--brand, --bg-0, --text-100, etc.).",
    {
      css: z.string().describe("Raw CSS text to analyze"),
    },
    async (args) => {
      try {
        const tokens = extractDesignTokens(args.css)
        const themeVars = mapToThemeVariables(tokens)
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              tokens: { colors: tokens.colors.slice(0, 20), fonts: tokens.fonts, radii: tokens.radii.slice(0, 5) },
              themeVariables: themeVars,
            }),
          }],
        }
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
      }
    },
    { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }
  )

  // ── BOOTSTRAP PAGES ──
  const bootstrapPagesTool = tool(
    "bootstrap_pages",
    `Create pages with blocks for a site. The site project must exist under apps/{siteId} (created via create_site or integrate_site). Built-in block types: ${Object.keys(getAllBlockMeta()).join(", ")}. Custom block types registered in blocks/register.ts are also supported — use the exact component name as the block type.`,
    {
      siteId: z.string().describe("Site ID to create pages for"),
      pages: z.array(z.object({
        slug: z.string().describe("Page slug, e.g. '/' or '/about'"),
        title: z.string().describe("Page title"),
        blocks: z.array(z.object({
          type: z.string().describe("Block type (e.g. Hero, FeatureGrid, CTA)"),
          props: z.record(z.string(), z.unknown()).describe("Block props matching the block schema"),
        })),
        meta: z.object({
          title: z.string().optional().describe("SEO title (from <title> tag)"),
          description: z.string().optional().describe("SEO description (from <meta name='description'>)"),
          ogImage: z.string().optional().describe("Open Graph image URL"),
        }).optional().describe("SEO metadata for the page"),
      })),
      themeOverrides: z.record(z.string(), z.string()).optional().describe("CSS variable overrides for theming"),
      navLabels: z.record(z.string(), z.string()).optional().describe("Custom nav labels per slug, e.g. { '/about': 'Über uns', '/events/teamevent': 'Teamevent' }. Overrides auto-generated labels."),
      navGroups: z.record(z.string(), z.array(z.string())).optional().describe("Group child pages under a parent nav dropdown, e.g. { 'Events': ['/events/teamevent', '/events/polterabend'] }. Parent has no href, children shown in dropdown."),
      siteLogo: z.string().optional().describe("Logo URL (relative, e.g. '/images/logo.png'). Set after downloading with download_remote_image."),
      siteName: z.string().optional().describe("Site name displayed in the header nav bar."),
      purpose: z.string().optional().describe("What the site is about — 1-2 sentences describing the business/project. Shown in editor settings and used as AI context for future edits."),
      tone: z.string().optional().describe("Voice/tone guide for AI content generation, e.g. 'Professional but approachable, uses du-form (German informal)'"),
      constraints: z.array(z.string()).optional().describe("Content rules the AI must follow, e.g. ['Always use Swiss German spelling', 'Never discount below CHF 49']"),
    },
    async (args) => {
      try {
        const totalBlocks = args.pages.reduce((sum, p) => sum + p.blocks.length, 0)
        const slugs = args.pages.map(p => p.slug)
        console.log(`[bootstrap_pages] START siteId=${args.siteId} pages=${args.pages.length} blocks=${totalBlocks} slugs=[${slugs.join(", ")}]`)

        // Verify the site project was scaffolded first
        const root = monorepoRoot()
        const projectPkg = join(root, "apps", args.siteId, "package.json")
        if (!existsSync(projectPkg)) {
          console.error(`[bootstrap_pages] GUARD FAILED: apps/${args.siteId}/package.json not found — create_site was not called`)
          return { content: [{ type: "text" as const, text: `Error: Site project apps/${args.siteId} does not exist. Call create_site first.` }], isError: true }
        }

        const sessionKey = scopedSessionKey(session, args.siteId)
        let strippedCount = 0
        let footerBlock: { type: string; props: Record<string, unknown> } | null = null

        // Normalize slugs — ensure leading / and no trailing /
        const normalizedPages = args.pages.map(page => ({
          ...page,
          slug: page.slug === "/" ? "/" : `/${page.slug.replace(/^\/+/, "").replace(/\/+$/, "")}`,
        }))

        // Build page docs once — reused for both session state and file persistence
        const imagesDir = join(root, "apps", args.siteId, "public", "images")
        await mkdir(imagesDir, { recursive: true })
        let totalAutoDownloaded = 0

        // Process pages sequentially to avoid unbounded concurrent image downloads
        const pageDocs = []
        for (const [pageIdx, page] of normalizedPages.entries()) {
          console.log(`[bootstrap_pages] Processing page ${pageIdx + 1}/${normalizedPages.length}: ${page.slug} (${page.blocks.length} blocks)`)
          const contentBlocks = page.blocks.filter(b => {
            if (b.type === "SiteHeader") { strippedCount++; return false }
            if (b.type === "Footer") {
              if (!footerBlock) {
                let fp = fixFooterLinks(b.props)
                const v = validateAndCorrectProps("Footer", fp)
                if (v.corrected) fp = v.props
                footerBlock = { type: b.type, props: fp }
              }
              strippedCount++
              return false
            }
            return true
          })
          const blocks = contentBlocks.map((b, i) => {
            const blockMeta = getAllBlockMeta()[b.type]
            const baseProps = blockMeta ? defaultPropsForType(b.type as BlockType) : {}
            let mergedProps: Record<string, unknown> = { ...baseProps }
            for (const [key, value] of Object.entries(b.props)) {
              mergedProps[key] = value
            }
            if (blockMeta) {
              const validation = validateAndCorrectProps(b.type, mergedProps)
              if (validation.corrected) {
                console.log(`[bootstrap_pages]   Block ${b.type}: auto-corrected props`)
                mergedProps = { ...baseProps }
                for (const [key, value] of Object.entries(validation.props)) {
                  mergedProps[key] = value
                }
              } else if (validation.error) {
                console.warn(`[bootstrap_pages]   Block ${b.type}: validation error — ${validation.error}`)
              }
            } else if (!getAllBlockMeta()[b.type]) {
              console.log(`[bootstrap_pages]   Block ${b.type}: custom type (not in built-in registry)`)
            }
            return { id: `b_${b.type.toLowerCase()}_${i + 1}`, type: b.type, props: mergedProps }
          })

          // Auto-download any remote image URLs the agent missed
          for (const block of blocks) {
            const { props: localizedProps, downloaded } = await localizeRemoteImages(block.props as Record<string, unknown>, imagesDir)
            if (downloaded > 0) {
              block.props = localizedProps
              totalAutoDownloaded += downloaded
            }
          }

          pageDocs.push({
            id: `p_${page.slug === "/" ? "home" : page.slug.replace(/^\//, "").replace(/\//g, "_")}`,
            slug: page.slug,
            title: page.title,
            blocks,
            ...(page.meta ? { meta: page.meta } : {}),
            updatedAt: new Date().toISOString(),
          })
        }
        if (strippedCount > 0) console.log(`[sites-agent] Stripped ${strippedCount} chrome blocks (SiteHeader/Footer)`)
        if (totalAutoDownloaded > 0) console.log(`[sites-agent] Auto-downloaded ${totalAutoDownloaded} remote images as safety net`)

        // Write to session state
        for (const doc of pageDocs) setPage(sessionKey, doc)
        const createdPages = pageDocs.map(d => d.slug)

        // Apply site config
        const existing = getSiteConfig(sessionKey)
        const patch: Record<string, unknown> = { ...existing }
        if (args.themeOverrides && Object.keys(args.themeOverrides).length > 0) {
          patch.themeOverrides = { ...(existing.themeOverrides ?? {}), ...args.themeOverrides }
        }
        if (args.navLabels) patch.navLabels = { ...(existing.navLabels ?? {}), ...args.navLabels }
        if (args.navGroups) patch.navGroups = { ...(existing.navGroups ?? {}), ...args.navGroups }
        if (args.siteLogo) patch.logo = args.siteLogo
        if (args.siteName) patch.name = args.siteName
        if (args.purpose) patch.purpose = args.purpose
        if (args.tone) patch.tone = args.tone
        if (args.constraints && args.constraints.length > 0) patch.constraints = args.constraints
        setSiteConfig(sessionKey, patch)
        bumpVersion(sessionKey)

        // Persist to content/pages.json
        const pagesJsonPath = join(root, "apps", args.siteId, "content", "pages.json")
        try {
          let existingPages: Array<Record<string, unknown>> = []
          try { existingPages = JSON.parse(await readFile(pagesJsonPath, "utf-8")) } catch { /* fresh */ }

          const allPages = [...existingPages]
          for (const doc of pageDocs) {
            const idx = allPages.findIndex(p => p.slug === doc.slug)
            if (idx >= 0) allPages[idx] = doc
            else allPages.push(doc)
          }

          await mkdir(dirname(pagesJsonPath), { recursive: true })
          await writeFile(pagesJsonPath, JSON.stringify(allPages, null, 2) + "\n", "utf-8")
          console.log(`[sites-agent] Wrote ${allPages.length} pages to ${pagesJsonPath}`)
        } catch (writeErr) {
          console.warn(`[sites-agent] Failed to write pages.json:`, writeErr)
        }

        // Persist site config (nav labels, nav groups, logo, name, footer) to content/site-config.json
        {
          const configPath = join(root, "apps", args.siteId, "content", "site-config.json")
          try {
            let existing: Record<string, unknown> = {}
            if (existsSync(configPath)) {
              try { existing = JSON.parse(await readFile(configPath, "utf-8")) } catch { /* fresh */ }
            }
            const config: Record<string, unknown> = { ...existing }
            if (args.siteName) config.name = args.siteName
            if (args.siteLogo) config.logo = args.siteLogo
            if (args.purpose) config.purpose = args.purpose
            if (args.tone) config.tone = args.tone
            if (args.constraints && args.constraints.length > 0) config.constraints = args.constraints
            if (args.navLabels) config.navLabels = { ...(existing.navLabels as Record<string, string> ?? {}), ...args.navLabels }
            if (args.navGroups) config.navGroups = { ...(existing.navGroups as Record<string, string[]> ?? {}), ...args.navGroups }
            if (footerBlock) {
              const fb = footerBlock as { type: string; props: Record<string, unknown> }
              config.footer = { id: "chrome_footer", type: fb.type, props: fb.props }
            }
            await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8")
            console.log(`[sites-agent] Wrote site config to ${configPath}`)
          } catch (err) {
            console.warn(`[sites-agent] Failed to write site-config.json:`, err)
          }
        }

        // Persist theme overrides to globals.css
        if (args.themeOverrides && Object.keys(args.themeOverrides).length > 0) {
          try {
            await patchGlobalsCssVars(join(root, "apps", args.siteId, "app", "globals.css"), args.themeOverrides)
            console.log(`[sites-agent] Updated ${Object.keys(args.themeOverrides).length} theme vars in globals.css`)
          } catch (cssErr) {
            console.warn(`[sites-agent] Failed to update globals.css:`, cssErr)
          }
        }

        const totalBlocksFinal = args.pages.reduce((sum, p) => sum + p.blocks.length, 0)
        emitPhaseOutcome?.({ tool: "bootstrap_pages", data: { pagesCreated: createdPages.length, totalBlocks: totalBlocksFinal, pages: createdPages } })
        console.log(`[bootstrap_pages] DONE siteId=${args.siteId} pages=${createdPages.length} blocks=${totalBlocksFinal} autoDownloaded=${totalAutoDownloaded}`)

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "applied",
              pagesCreated: createdPages,
              totalBlocks: totalBlocksFinal,
              persistedToFile: true,
            }),
          }],
        }
      } catch (e: unknown) {
        console.error(`[bootstrap_pages] ERROR: ${e instanceof Error ? e.message : String(e)}`)
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
      }
    },
    { annotations: { destructiveHint: false, openWorldHint: false } }
  )

  // ── DOWNLOAD REMOTE IMAGE ──
  const downloadImageTool = tool(
    "download_remote_image",
    "Download a remote image and save it to the site's public/images/ directory. Returns a relative URL (/images/filename) for use in block props. Next.js serves files from public/ automatically.",
    {
      url: z.string().describe("Image URL to download"),
      siteId: z.string().describe("Site ID — image saved to apps/{siteId}/public/images/"),
      alt: z.string().optional().describe("Alt text for the image"),
    },
    async (args) => {
      try {
        const root = monorepoRoot()
        const outputDir = join(root, "apps", args.siteId, "public", "images")
        console.log(`[download_image] ${args.url.slice(0, 100)}`)
        const result = await downloadImage(args.url, args.alt, outputDir)
        const localUrl = `/images/${result.fileName}`
        console.log(`[download_image] OK → ${localUrl}`)
        emitPhaseOutcome?.({ tool: "download_remote_image", data: { fileName: result.fileName } })
        return { content: [{ type: "text" as const, text: JSON.stringify({ localUrl, fileName: result.fileName }) }] }
      } catch (e: unknown) {
        console.warn(`[download_image] FAILED ${args.url.slice(0, 100)} — ${e instanceof Error ? e.message : String(e)}`)
        return { content: [{ type: "text" as const, text: JSON.stringify({ localUrl: args.url, error: "Download failed, using original URL" }) }] }
      }
    },
    { annotations: { destructiveHint: false, openWorldHint: true } }
  )

  // ── BATCH DOWNLOAD IMAGES ──
  const downloadImagesTool = tool(
    "download_remote_images",
    "Download multiple remote images in one call. Much more efficient than calling download_remote_image repeatedly — use this when you have 3+ images to download. Returns an array of { url, localUrl } mappings.",
    {
      siteId: z.string().describe("Site ID — images saved to apps/{siteId}/public/images/"),
      images: z.array(z.object({
        url: z.string().describe("Image URL to download"),
        alt: z.string().optional().describe("Alt text"),
      })).describe("Array of images to download"),
    },
    async (args) => {
      const root = monorepoRoot()
      const outputDir = join(root, "apps", args.siteId, "public", "images")
      await mkdir(outputDir, { recursive: true })

      // Download 4 at a time to avoid overwhelming the source server
      const results: Array<{ url: string; localUrl: string; error?: string }> = []
      for (let i = 0; i < args.images.length; i += 4) {
        const batch = args.images.slice(i, i + 4)
        const batchResults = await Promise.all(batch.map(async (img) => {
          try {
            const result = await downloadImage(img.url, img.alt, outputDir)
            return { url: img.url, localUrl: `/images/${result.fileName}` }
          } catch {
            return { url: img.url, localUrl: img.url, error: "Download failed" }
          }
        }))
        results.push(...batchResults)
      }

      const succeeded = results.filter(r => !r.error).length
      emitPhaseOutcome?.({ tool: "download_remote_images", data: { succeeded, total: results.length } })
      console.log(`[sites-agent] Batch downloaded ${succeeded}/${results.length} images`)

      return { content: [{ type: "text" as const, text: JSON.stringify({ results, succeeded, failed: results.length - succeeded }) }] }
    },
    { annotations: { destructiveHint: false, openWorldHint: true } }
  )

  // ── BROWSE GOOGLE DRIVE IMAGES ──
  const browseGdriveTool = tool(
    "browse_gdrive_images",
    "Browse images in a Google Drive folder. Downloads them to the site's public/images/ and returns thumbnails so you can see the images and decide where to place them. Use BEFORE bootstrap_pages when the user provides a Google Drive folder.",
    {
      siteId: z.string().describe("Site ID — images saved to apps/{siteId}/public/images/"),
      folderId: z.string().optional().describe("Google Drive folder ID or URL. Falls back to the configured default folder."),
      query: z.string().optional().describe("Optional search text to filter images by filename"),
      limit: z.number().optional().describe("Max images to return (1-15, default 10)"),
    },
    async (args) => {
      if (!isGdriveConfigured() && !args.folderId) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Google Drive not configured. Set GOOGLE_DRIVE_FOLDER_ID and GOOGLE_API_KEY in .env, or provide a folderId." }) }] }
      }

      const folderId = resolveGdriveFolderId(args.folderId)
      if (!folderId) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "No folder ID provided or configured." }) }] }
      }

      const limit = Math.min(15, Math.max(1, Math.trunc(args.limit ?? 10)))
      const files = await listGdriveImages(folderId, args.query, undefined, limit)
      if (files.length === 0) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ images: [], message: "No images found in the specified folder." }) }] }
      }

      const root = monorepoRoot()
      const outputDir = join(root, "apps", args.siteId, "public", "images")
      await mkdir(outputDir, { recursive: true })

      const THUMB_WIDTH = 256
      const manifest: Array<{ name: string; localUrl: string; alt: string }> = []
      const contentBlocks: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/webp" }> = []

      // Download and thumbnail 4 at a time
      for (let i = 0; i < files.length; i += 4) {
        const batch = files.slice(i, i + 4)
        const batchResults = await Promise.all(batch.map(async (file) => {
          try {
            const result = await downloadGdriveImage(file.id)
            if (!result) return null

            // Copy to site's public/images/
            const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").toLowerCase()
            const localName = `gdrive_${safeName.replace(/\.[^.]+$/, "")}.webp`
            const localPath = join(outputDir, localName)
            const fullImage = await readFile(result.filePath)
            await writeFile(localPath, fullImage)

            // Generate small thumbnail for vision
            const thumb = await sharp(fullImage)
              .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
              .webp({ quality: 60 })
              .toBuffer()

            return {
              name: file.name,
              localUrl: `/images/${localName}`,
              alt: fileNameToAlt(file.name),
              thumbBase64: thumb.toString("base64"),
            }
          } catch {
            return null
          }
        }))

        for (const r of batchResults) {
          if (!r) continue
          manifest.push({ name: r.name, localUrl: r.localUrl, alt: r.alt })
          contentBlocks.push({ type: "image" as const, data: r.thumbBase64, mimeType: "image/webp" as const })
          contentBlocks.push({ type: "text" as const, text: `↑ ${r.name} → ${r.localUrl}` })
        }
      }

      console.log(`[sites-agent] Browsed GDrive: ${manifest.length}/${files.length} images downloaded`)

      return {
        content: [
          { type: "text" as const, text: `Found ${manifest.length} images. Thumbnails below — use localUrl paths in block props.\n${JSON.stringify(manifest, null, 2)}` },
          ...contentBlocks,
        ],
      }
    },
    { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } }
  )

  // ── APPLY THEME ──
  const applyThemeTool = tool(
    "apply_theme",
    "Apply CSS custom property overrides to a site's theme. These are injected into the preview so blocks render with the migrated site's colors and fonts.",
    {
      siteId: z.string().describe("Site ID to apply theme to"),
      variables: z.record(z.string(), z.string()).describe("CSS variable overrides, e.g. { '--brand': '#2563eb' }"),
    },
    async (args) => {
      const sessionKey = scopedSessionKey(session, args.siteId)
      const existing = getSiteConfig(sessionKey)
      setSiteConfig(sessionKey, {
        ...existing,
        themeOverrides: { ...(existing.themeOverrides ?? {}), ...args.variables },
      })

      // Also persist to the site's globals.css
      try {
        await patchGlobalsCssVars(join(monorepoRoot(), "apps", args.siteId, "app", "globals.css"), args.variables)
      } catch (err) {
        console.warn(`[sites-agent] Failed to persist theme to globals.css:`, err)
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ status: "applied", variableCount: Object.keys(args.variables).length, persistedToCss: true }),
        }],
      }
    },
    { annotations: { destructiveHint: false, openWorldHint: false } }
  )

  // ── CLONE REPO ──
  const cloneRepoTool = tool(
    "clone_repo",
    "Clone a GitHub repository to a local directory inside the monorepo. Uses `gh repo clone` for auth, falls back to `git clone`. Returns the local path for use with analyze_codebase.",
    {
      url: z.string().describe("GitHub repo URL (e.g. 'https://github.com/user/repo') or shorthand ('user/repo')"),
      targetDir: z.string().optional().describe("Target directory name inside apps/. Defaults to repo name."),
    },
    async (args) => {
      try {
        const result = await cloneRepo(args.url, args.targetDir)
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error cloning repo: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
      }
    },
    { annotations: { destructiveHint: false, openWorldHint: true } }
  )

  // ── INTEGRATE SITE (composite — replaces 8-10 individual tool calls) ──
  const integrateSiteTool = tool(
    "integrate_site",
    "Add AI Site Editor SDK integration to an existing Next.js project in ONE step. Creates all integration files (catch-all page, editor API route, CMS adapter, content directory, .env.local, blocks register), adds block styles import to layout, installs workspace deps if needed, and starts the dev server. Returns the site config. Use this AFTER analyze_codebase confirms the project is a Next.js app-router site without existing integration.",
    {
      siteId: z.string().describe("Site ID (kebab-case, matches the directory name in apps/)"),
      name: z.string().describe("Human-readable site name"),
      purpose: z.string().optional().describe("What the site is about"),
      layoutPath: z.string().optional().describe("Relative path to layout file (from analyze_codebase)"),
      useSrcDir: z.boolean().optional().describe("Whether the project uses src/app/ instead of app/"),
    },
    async (args) => {
      try {
        const root = monorepoRoot()
        const projectDir = join(root, "apps", args.siteId)

        if (!existsSync(join(projectDir, "package.json"))) {
          return { content: [{ type: "text" as const, text: `Error: apps/${args.siteId}/package.json not found.` }], isError: true }
        }

        const appDir = args.useSrcDir ? "src/app" : "app"
        const filesCreated: string[] = []

        // 1. Add workspace deps to package.json if missing
        const pkgPath = join(projectDir, "package.json")
        const pkg = JSON.parse(await readFile(pkgPath, "utf-8"))

        // Auto-detect site name: prefer <title> from layout metadata, fall back to package.json
        let siteName = args.name
        const genericNames = new Set(["sample site", "my site", "site", "test site", "new site", "untitled", ""])
        if (!siteName || genericNames.has(siteName.toLowerCase())) {
          // Try extracting title from layout metadata
          const layoutFile = args.layoutPath
            ? join(projectDir, args.layoutPath)
            : join(projectDir, appDir, "layout.tsx")
          if (existsSync(layoutFile)) {
            const layoutSrc = await readFile(layoutFile, "utf-8")
            // Match: title: "..." or title: { default: "..." }
            const titleMatch = layoutSrc.match(/title:\s*(?:\{\s*default:\s*)?["']([^"']+)["']/)
            if (titleMatch?.[1]) siteName = titleMatch[1]
          }
          // Fall back to humanized package name
          if (!siteName || genericNames.has(siteName.toLowerCase())) {
            siteName = humanizePkgName(String(pkg.name ?? args.siteId))
          }
        }
        const deps = pkg.dependencies ?? {}
        let depsAdded = false
        for (const dep of ["@ai-site-editor/site-sdk", "@ai-site-editor/blocks", "@ai-site-editor/shared"]) {
          if (!deps[dep]) {
            deps[dep] = "workspace:*"
            depsAdded = true
          }
        }
        if (depsAdded) {
          pkg.dependencies = deps
          await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8")
          filesCreated.push("package.json (deps added)")
        }

        // 2. Create or wrap catch-all page route for editor-managed pages
        const catchAllDir = join(projectDir, appDir, "[[...slug]]")
        const catchAllPage = join(catchAllDir, "page.tsx")
        const originalPage = join(catchAllDir, "_original-page.tsx")
        const editorPage = join(catchAllDir, "_editor-page.tsx")
        const blocksPrefix = args.useSrcDir ? "../../../" : "../../"
        let isHybrid = false

        if (!existsSync(catchAllDir)) {
          // Case A: No catch-all — create standard editor catch-all
          await mkdir(catchAllDir, { recursive: true })
          const pageContent = pageTsx(args.siteId)
            .replace('import "../../blocks/register"', `import "${blocksPrefix}blocks/register"`)
          await writeFile(catchAllPage, pageContent, "utf-8")
          filesCreated.push(`${appDir}/[[...slug]]/page.tsx`)
        } else if (existsSync(catchAllPage) && !existsSync(originalPage)) {
          // Case B: Existing catch-all, not yet wrapped — create hybrid
          isHybrid = true
          const { rename } = await import("node:fs/promises")
          await rename(catchAllPage, originalPage)
          const editorContent = pageTsx(args.siteId, { chrome: false })
            .replace('import "../../blocks/register"', `import "${blocksPrefix}blocks/register"`)
          await writeFile(editorPage, editorContent, "utf-8")
          await writeFile(catchAllPage, hybridPageTsx(args.siteId), "utf-8")
          filesCreated.push(`${appDir}/[[...slug]]/_original-page.tsx (preserved)`)
          filesCreated.push(`${appDir}/[[...slug]]/_editor-page.tsx`)
          filesCreated.push(`${appDir}/[[...slug]]/page.tsx (hybrid wrapper)`)
        } else if (existsSync(originalPage)) {
          isHybrid = true // already integrated
        }

        // 3. Create editor API route
        const apiDir = join(projectDir, appDir, "api/editor/[...path]")
        if (!existsSync(apiDir)) {
          await mkdir(apiDir, { recursive: true })
          const apiBlocksPrefix = args.useSrcDir ? "../../../../../" : "../../../../"
          const routeContent = editorApiRoute()
            .replace('import "../../../../blocks/register"', `import "${apiBlocksPrefix}blocks/register"`)
          await writeFile(join(apiDir, "route.ts"), routeContent, "utf-8")
          filesCreated.push(`${appDir}/api/editor/[...path]/route.ts`)
        }

        // 4. Create content directory (empty for hybrid — existing pages fall through to original)
        const contentDir = join(projectDir, "content")
        if (!existsSync(join(contentDir, "pages.json"))) {
          await mkdir(contentDir, { recursive: true })
          await writeFile(join(contentDir, "pages.json"), isHybrid ? "[]\n" : samplePagesJson(), "utf-8")
          filesCreated.push("content/pages.json")
        }

        // 5. Create blocks register file
        const blocksDir = join(projectDir, "blocks")
        if (!existsSync(join(blocksDir, "register.ts")) && !existsSync(join(blocksDir, "register.tsx"))) {
          await mkdir(blocksDir, { recursive: true })
          await writeFile(join(blocksDir, "register.tsx"), blocksRegisterTsx(), "utf-8")
          filesCreated.push("blocks/register.tsx")
        }

        // 6. Create lib/defaults.ts
        const libDir = join(projectDir, "lib")
        if (!existsSync(join(libDir, "defaults.ts"))) {
          await mkdir(libDir, { recursive: true })
          await writeFile(join(libDir, "defaults.ts"), defaultsTs(args.siteId, siteName), "utf-8")
          filesCreated.push("lib/defaults.ts")
        }

        // 7. Create/merge .env.local
        const envPath = join(projectDir, ".env.local")
        const envVars: Record<string, string> = {
          ORCHESTRATOR_URL: "http://localhost:4200",
          DRAFT_MODE_SECRET: getDraftModeSecret(),
          NEXT_PUBLIC_DEFAULT_SITE_ID: args.siteId,
          NEXT_PUBLIC_SITE_NAME: siteName,
          NEXT_PUBLIC_EDITOR_ORIGIN: "http://localhost:4100",
        }
        if (existsSync(envPath)) {
          const existing = await readFile(envPath, "utf-8")
          const existingKeys = new Set(existing.split("\n").map(l => l.split("=")[0]).filter(Boolean))
          const newLines: string[] = []
          for (const [k, v] of Object.entries(envVars)) {
            if (!existingKeys.has(k)) newLines.push(`${k}=${v}`)
          }
          if (newLines.length > 0) {
            await writeFile(envPath, existing.trimEnd() + "\n" + newLines.join("\n") + "\n", "utf-8")
            filesCreated.push(".env.local (merged)")
          }
        } else {
          await writeFile(envPath, Object.entries(envVars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", "utf-8")
          filesCreated.push(".env.local")
        }

        // 8. Add block styles import + EditorOverlay to existing layout
        const layoutFile = args.layoutPath
          ? join(projectDir, args.layoutPath)
          : join(projectDir, appDir, "layout.tsx")
        if (existsSync(layoutFile)) {
          let layoutContent = await readFile(layoutFile, "utf-8")
          let layoutModified = false

          // Add block styles import
          if (!layoutContent.includes("@ai-site-editor/blocks/styles.css")) {
            const lines = layoutContent.split("\n")
            let lastImportIdx = -1
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].startsWith("import ")) lastImportIdx = i
            }
            if (lastImportIdx >= 0) {
              lines.splice(lastImportIdx + 1, 0, 'import "@ai-site-editor/blocks/styles.css"')
            } else {
              lines.unshift('import "@ai-site-editor/blocks/styles.css"')
            }
            layoutContent = lines.join("\n")
            layoutModified = true
          }

          // Add EditorOverlay for preview bridge (enables editor communication)
          if (!layoutContent.includes("EditorOverlay")) {
            // Add import
            const lines = layoutContent.split("\n")
            let lastImportIdx = -1
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].startsWith("import ")) lastImportIdx = i
            }
            const overlayImport = 'import { EditorOverlay } from "@ai-site-editor/site-sdk/editor"'
            if (lastImportIdx >= 0) {
              lines.splice(lastImportIdx + 1, 0, overlayImport)
            } else {
              lines.unshift(overlayImport)
            }
            layoutContent = lines.join("\n")

            // Insert <EditorOverlay /> before closing </body>
            layoutContent = layoutContent.replace(
              "</body>",
              `        <EditorOverlay slug="/" editorOrigin={process.env.NEXT_PUBLIC_EDITOR_ORIGIN ?? "http://localhost:4100"} />\n      </body>`
            )
            layoutModified = true
          }

          if (layoutModified) {
            await writeFile(layoutFile, layoutContent, "utf-8")
            filesCreated.push(args.layoutPath ?? `${appDir}/layout.tsx (styles + editor overlay added)`)
          }
        }

        // 9. Create public dir and default assets if missing
        const publicDir = join(projectDir, "public")
        if (!existsSync(publicDir)) await mkdir(publicDir, { recursive: true })
        if (!existsSync(join(publicDir, "logo.svg"))) {
          await writeFile(join(publicDir, "logo.svg"), defaultLogoSvg(siteName), "utf-8")
          filesCreated.push("public/logo.svg")
        }
        if (!existsSync(join(publicDir, "favicon.svg"))) {
          await writeFile(join(publicDir, "favicon.svg"), faviconSvg(siteName), "utf-8")
          filesCreated.push("public/favicon.svg")
        }

        // 10. Install dependencies (skip if monorepo root node_modules exists)
        const rootNodeModules = join(root, "node_modules")
        if (depsAdded && existsSync(rootNodeModules)) {
          const { execFile } = await import("node:child_process")
          const { promisify } = await import("node:util")
          await promisify(execFile)("pnpm", ["install", "--no-frozen-lockfile"], { cwd: root, timeout: 60_000 })
        }

        // 11. Start dev server and register site in editor dashboard
        // (Previously split into separate launch_site step — now self-contained like create_site)
        let port = await detectSitePort(projectDir)

        // Check if port is in use — find a free one
        try {
          const { execSync } = await import("node:child_process")
          const pids = execSync(`lsof -ti:${port} 2>/dev/null`, { encoding: "utf-8" }).trim()
          if (pids) {
            console.log(`[integrate_site] Port ${port} in use, finding free port...`)
            port = await findAvailablePort(root)
            const pkg = JSON.parse(await readFile(join(projectDir, "package.json"), "utf-8"))
            if (pkg.scripts?.dev) {
              pkg.scripts.dev = pkg.scripts.dev.replace(/-p\s*\d+/, `-p ${port}`)
              await writeFile(join(projectDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf-8")
            }
          }
        } catch { /* no process on port — good */ }

        // Initialize orchestrator session
        const sessionKey = scopedSessionKey(session, args.siteId)
        setPage(sessionKey, {
          id: "p_home", slug: "/", title: "Home", blocks: [], updatedAt: new Date().toISOString(),
        })
        bumpVersion(sessionKey)

        // Start dev server and wait for ready
        const previewUrl = `http://localhost:${port}`
        const { serverReady } = await startAndWaitForDevServer({
          siteId: args.siteId, port, cwd: projectDir,
        })

        // Register in editor dashboard (emits site_created SSE event)
        const siteConfig = {
          id: args.siteId,
          name: siteName,
          purpose: args.purpose ?? "",
          tone: "",
          hosting: "local",
          previewUrl,
          constraints: [],
        }
        emitSiteCreated(siteConfig)

        emitPhaseOutcome?.({ tool: "integrate_site", data: { siteId: args.siteId, port, name: siteName, filesCreated: filesCreated.length, serverReady } })

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: serverReady ? "running" : "integrated",
              siteId: args.siteId,
              port,
              previewUrl,
              name: siteName,
              filesCreated,
              serverReady,
            }),
          }],
        }
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
      }
    },
    { annotations: { destructiveHint: false, openWorldHint: false } }
  )

  // ── LAUNCH SITE ──
  const launchSiteTool = tool(
    "launch_site",
    "Start the dev server for an integrated site, wait for it to be ready, and register it in the editor. Call this AFTER integrate_site completes. Returns the confirmed preview URL once the server is responding.",
    {
      siteId: z.string().describe("Site ID (matches the directory name in apps/)"),
      name: z.string().optional().describe("Human-readable site name"),
      purpose: z.string().optional().describe("What the site is about"),
    },
    async (args) => {
      try {
        const root = monorepoRoot()
        const projectDir = join(root, "apps", args.siteId)

        if (!existsSync(join(projectDir, "package.json"))) {
          return { content: [{ type: "text" as const, text: `Error: apps/${args.siteId}/package.json not found.` }], isError: true }
        }

        let port = await detectSitePort(projectDir)

        // Check if port is in use — if so, find a free one and update package.json
        try {
          const { execSync } = await import("node:child_process")
          const pids = execSync(`lsof -ti:${port} 2>/dev/null`, { encoding: "utf-8" }).trim()
          if (pids) {
            console.log(`[sites-agent] Port ${port} in use, finding free port...`)
            port = await findAvailablePort(root)
            // Update dev script with new port
            const pkg = JSON.parse(await readFile(join(projectDir, "package.json"), "utf-8"))
            if (pkg.scripts?.dev) {
              pkg.scripts.dev = pkg.scripts.dev.replace(/-p\s*\d+/, `-p ${port}`)
              await writeFile(join(projectDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf-8")
            }
          }
        } catch { /* no process on port — good */ }

        // Initialize orchestrator session
        const sessionKey = scopedSessionKey(session, args.siteId)
        setPage(sessionKey, {
          id: "p_home", slug: "/", title: "Home", blocks: [], updatedAt: new Date().toISOString(),
        })
        bumpVersion(sessionKey)

        // Start dev server and wait for it to be ready
        const previewUrl = `http://localhost:${port}`
        const { serverReady } = await startAndWaitForDevServer({
          siteId: args.siteId, port, cwd: projectDir,
        })

        const siteName = args.name ?? args.siteId
        const siteConfig = {
          id: args.siteId,
          name: siteName,
          purpose: args.purpose ?? "",
          tone: "",
          hosting: "local",
          previewUrl,
          constraints: [],
        }

        emitSiteCreated(siteConfig)
        emitPhaseOutcome?.({ tool: "launch_site", data: { siteId: args.siteId, port, name: siteName, serverReady } })

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ status: serverReady ? "running" : "timeout", siteId: args.siteId, port, previewUrl, name: siteName, serverReady }),
          }],
        }
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
      }
    },
    { annotations: { destructiveHint: false, openWorldHint: false } }
  )

  // ── REGISTER SITE ──
  const registerSiteTool = tool(
    "register_site",
    "Register an existing site project with the editor and start its dev server. Call this AFTER integrating the SDK into an existing codebase. The site will appear in the editor's site list and be ready for editing.",
    {
      siteId: z.string().describe("Site ID (kebab-case, matches the directory name in apps/)"),
      name: z.string().describe("Human-readable site name"),
      purpose: z.string().optional().describe("What the site is about"),
      port: z.number().optional().describe("Dev server port (auto-detected from package.json if omitted)"),
    },
    async (args) => {
      try {
        const root = monorepoRoot()
        const projectDir = join(root, "apps", args.siteId)

        if (!existsSync(join(projectDir, "package.json"))) {
          return { content: [{ type: "text" as const, text: `Error: apps/${args.siteId}/package.json not found. Ensure the project exists.` }], isError: true }
        }

        const port = args.port || await detectSitePort(projectDir)

        // Initialize orchestrator session state
        const sessionKey = scopedSessionKey(session, args.siteId)
        setPage(sessionKey, {
          id: "p_home", slug: "/", title: "Home", blocks: [], updatedAt: new Date().toISOString(),
        })
        bumpVersion(sessionKey)

        // Kill any existing process on the allocated port
        try {
          const { execSync } = await import("node:child_process")
          const pids = execSync(`lsof -ti:${port} 2>/dev/null`, { encoding: "utf-8" }).trim()
          if (pids) {
            for (const pid of pids.split("\n")) {
              try { process.kill(Number(pid), "SIGKILL") } catch { /* already dead */ }
            }
          }
        } catch { /* no process on port */ }

        // Install dependencies if needed
        if (!existsSync(join(projectDir, "node_modules"))) {
          const { execFile } = await import("node:child_process")
          const { promisify } = await import("node:util")
          await promisify(execFile)("pnpm", ["install", "--no-frozen-lockfile"], { cwd: root, timeout: 60_000 })
        }

        // Start dev server and wait for readiness
        const { serverReady } = await startAndWaitForDevServer({
          siteId: args.siteId, port, cwd: root, useFilter: true,
        })

        const siteConfig = {
          id: args.siteId,
          name: args.name,
          purpose: args.purpose ?? "",
          tone: "",
          hosting: "local",
          previewUrl: `http://localhost:${port}`,
          constraints: [],
        }

        emitSiteCreated(siteConfig)
        emitPhaseOutcome?.({ tool: "register_site", data: { siteId: args.siteId, port, name: args.name, serverReady } })

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "registered",
              siteId: args.siteId,
              config: siteConfig,
              port,
              name: args.name,
              previewUrl: `http://localhost:${port}`,
              devServerStarted: serverReady,
            }),
          }],
        }
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
      }
    },
    { annotations: { destructiveHint: false, openWorldHint: false } }
  )

  // ── ANALYZE CODEBASE ──
  const analyzeCodebaseTool = tool(
    "analyze_codebase",
    "Analyze an existing site project to detect its framework, CMS, routes, styling, and readiness for AI Site Editor integration. Use this before integrating an existing codebase.",
    {
      projectPath: z.string().describe("Absolute path to the project root directory"),
    },
    async (args) => {
      try {
        const analysis = await analyzeCodebase(args.projectPath)
        emitPhaseOutcome?.({ tool: "analyze_codebase", data: { framework: analysis.framework, routes: analysis.existingRoutes.length } })
        return { content: [{ type: "text" as const, text: JSON.stringify(analysis, null, 2) }] }
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error analyzing codebase: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
      }
    },
    { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }
  )

  // ── VISUAL QA DIFF ──
  const visualQaDiffTool = tool(
    "visual_qa_diff",
    "Take screenshots of the generated site and compare with original source screenshots. Returns a list of visual discrepancies found by comparing the screenshots. Use this AFTER bootstrap_pages to verify migration fidelity.",
    {
      generatedSiteUrl: z.string().describe("URL of the generated site to screenshot (e.g. http://localhost:3000)"),
      originalUrl: z.string().describe("URL of the original source site that was migrated"),
    },
    async (args) => {
      try {
        // Take screenshots of the generated site (scrapeFullPage gives us both desktop + mobile)
        const genScrape = await scrapeFullPage(args.generatedSiteUrl)
        const genDesktop = genScrape.screenshot
        const genMobile = genScrape.mobileScreenshot

        // Get original screenshots from cache (should be available from prior scrape_url call)
        const cachedScrape = getCachedScrape(args.originalUrl)

        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = []
        content.push({ type: "text", text: "Visual QA comparison. The following images are paired: ORIGINAL then GENERATED for each viewport. Identify all visual discrepancies (colors, spacing, layout, fonts, missing images, wrong block types) and suggest specific fixes." })

        // Desktop comparison
        if (cachedScrape?.screenshot) {
          content.push({ type: "image", data: cachedScrape.screenshot.base64, mimeType: "image/jpeg" })
          content.push({ type: "text", text: "^ ORIGINAL desktop (1440px)" })
        }
        if (genDesktop) {
          content.push({ type: "image", data: genDesktop.base64, mimeType: "image/jpeg" })
          content.push({ type: "text", text: "^ GENERATED desktop (1440px)" })
        }

        // Mobile comparison
        if (cachedScrape?.mobileScreenshot && genMobile) {
          content.push({ type: "image", data: cachedScrape.mobileScreenshot.base64, mimeType: "image/jpeg" })
          content.push({ type: "text", text: "^ ORIGINAL mobile (390px)" })
          content.push({ type: "image", data: genMobile.base64, mimeType: "image/jpeg" })
          content.push({ type: "text", text: "^ GENERATED mobile (390px)" })
        }

        content.push({ type: "text", text: "List all discrepancies with severity (critical/major/minor) and suggest specific operations to fix them." })

        emitPhaseOutcome?.({ tool: "visual_qa_diff", data: { hasOriginal: !!cachedScrape?.screenshot, hasMobile: !!genMobile } })
        return { content }
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error during visual QA: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
      }
    },
    { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } }
  )

  return createSdkMcpServer({
    name: "sites-agent",
    version: "1.0.0",
    tools: [listSitesTool, discoverStructureTool, createSiteTool, scrapeUrlTool, extractTokensTool, bootstrapPagesTool, downloadImageTool, downloadImagesTool, browseGdriveTool, applyThemeTool, analyzeCodebaseTool, cloneRepoTool, integrateSiteTool, launchSiteTool, registerSiteTool, visualQaDiffTool, ...createMigrationTools()],
  })
}

// Template functions now live in sites-agent-shared.ts — imported at the top of this file.
// (sanitizeSiteId, monorepoRoot, findAvailablePort, patchGlobalsCssVars,
//  validateAndCorrectProps, normalizePageBlocks, scaffoldSiteProject,
//  packageJson, nextConfigTs, tsconfigJson, postcssConfig, layoutTsx, globalsCss,
//  defaultsTs, editorApiRoute, pageTsx, blocksRegisterTsx, samplePagesJson,
//  defaultLogoSvg, faviconSvg)
