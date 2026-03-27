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
import { z } from "zod"
import { getAllBlockMeta, defaultPropsForType, validateBlockProps, type BlockType } from "@ai-site-editor/shared"
import { fetchPageContent, takeScreenshot, downloadImage, extractDesignTokens, mapToThemeVariables, discoverSitePages, scrapeFullPage } from "@ai-site-editor/migration-sdk"
import { scopedSessionKey, setPage, bumpVersion, getSiteConfig, setSiteConfig } from "../state/session-state.js"

/** Sanitize a site name into a kebab-case ID */
function sanitizeSiteId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "my-site"
}

/** Resolve the monorepo root */
function monorepoRoot(): string {
  return resolve(dirname(new URL(import.meta.url).pathname), "../../../../")
}

async function findAvailablePort(root: string): Promise<number> {
  const appsDir = join(root, "apps")
  const { readdir } = await import("node:fs/promises")
  const usedPorts = new Set<number>([3000, 4100, 4200])
  try {
    // Scan apps/ and examples/ for used ports
    for (const dir of [appsDir, join(root, "examples")]) {
      if (!existsSync(dir)) continue
      const entries = await readdir(dir)
      for (const entry of entries) {
        const pkgPath = join(dir, entry, "package.json")
        if (!existsSync(pkgPath)) continue
        try {
          const pkg = JSON.parse(await readFile(pkgPath, "utf-8"))
          const devScript = pkg.scripts?.dev ?? ""
          // Match all port patterns: -p 3001, --port 3001, -p3001
          const portMatches = devScript.matchAll(/(?:-p\s*|--port\s+)(\d+)/g)
          for (const m of portMatches) usedPorts.add(Number(m[1]))
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }

  // Also check if ports are actually in use via net.createServer
  const { createServer } = await import("node:net")
  let port = 3500
  while (usedPorts.has(port) || !(await isPortFree(createServer, port))) port++
  console.log(`[sites-agent] Selected port ${port} (used: ${[...usedPorts].sort().join(", ")})`)
  return port
}

function isPortFree(createServer: typeof import("node:net").createServer, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once("error", () => resolve(false))
    server.once("listening", () => { server.close(() => resolve(true)) })
    server.listen(port, "127.0.0.1")
  })
}

// ── CSS variable persistence ──

/** Patch CSS variables into a globals.css :root block. */
async function patchGlobalsCssVars(cssPath: string, vars: Record<string, string>): Promise<void> {
  if (!existsSync(cssPath)) return
  let css = await readFile(cssPath, "utf-8")
  for (const [prop, value] of Object.entries(vars)) {
    const varRegex = new RegExp(`(${prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}):\\s*[^;]+;`)
    if (varRegex.test(css)) {
      css = css.replace(varRegex, `$1: ${value};`)
    } else {
      css = css.replace(/(:root\s*\{[^}]*)(\})/, `$1  ${prop}: ${value};\n$2`)
    }
  }
  await writeFile(cssPath, css, "utf-8")
}

// ── Schema validation + auto-correction ──

/** Common LLM prop-name mistakes per block type */
const PROP_RENAME_RULES: Record<string, Record<string, string>> = {
  FAQAccordion: { question: "q", answer: "a" },
  FeatureGrid: { items: "features" },
  Stats: { items: "stats" },
  CardGrid: { items: "cards" },
  CTA: { heading: "title", buttonText: "ctaText", buttonHref: "ctaHref" },
  Testimonials: { testimonials: "items" },
  Footer: { heading: "title" },
}

/**
 * Fix Footer columns.links — LLMs send [{label,href}] objects but schema expects
 * pipe-delimited strings: "Label|/url\nLabel2|/url2"
 */
function fixFooterLinks(props: Record<string, unknown>): Record<string, unknown> {
  const columns = props.columns
  if (!Array.isArray(columns)) return props
  return {
    ...props,
    columns: columns.map((col: unknown) => {
      if (!col || typeof col !== "object") return col
      const c = col as Record<string, unknown>
      const links = c.links
      // Already a string — fine
      if (typeof links === "string") return c
      // Array of {label, href} objects → convert to pipe-delimited string
      if (Array.isArray(links)) {
        const formatted = links
          .filter((l: unknown) => l && typeof l === "object")
          .map((l: unknown) => {
            const link = l as Record<string, unknown>
            const label = String(link.label ?? link.text ?? "")
            const href = String(link.href ?? link.url ?? "")
            return href ? `${label}|${href}` : label
          })
          .join("\n")
        return { ...c, links: formatted }
      }
      return c
    }),
  }
}

/** Rename keys in an object (top-level and within arrays) */
function renameKeys(obj: Record<string, unknown>, renames: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    const newKey = renames[key] ?? key
    if (Array.isArray(value)) {
      result[newKey] = value.map(item =>
        item && typeof item === "object" && !Array.isArray(item)
          ? renameKeys(item as Record<string, unknown>, renames)
          : item
      )
    } else {
      result[newKey] = value
    }
  }
  return result
}

/** Auto-correct common LLM mistakes and validate block props */
function validateAndCorrectProps(
  blockType: string,
  props: Record<string, unknown>,
): { props: Record<string, unknown>; corrected: boolean; error?: string } {
  // First try validation as-is
  const first = validateBlockProps(blockType, props)
  if (first.success) return { props, corrected: false }

  // Try auto-correction: rename keys + type-specific fixes
  let corrected = { ...props }

  // Coerce booleans to strings for enum fields that expect "true"/"false"
  for (const [key, value] of Object.entries(corrected)) {
    if (typeof value === "boolean") corrected[key] = String(value)
  }

  const renames = PROP_RENAME_RULES[blockType]
  if (renames) corrected = renameKeys(corrected, renames)
  if (blockType === "Footer") corrected = fixFooterLinks(corrected)

  const second = validateBlockProps(blockType, corrected)
  if (second.success) {
    console.log(`[sites-agent] Auto-corrected ${blockType} props`)
    return { props: corrected, corrected: true }
  }

  // Return original with error — caller decides fallback
  const errorMsg = first.success === false && "error" in first
    ? (first.error as { issues?: Array<{ path: unknown[]; message: string }> }).issues?.map(
        (i: { path: unknown[]; message: string }) => `${i.path.join(".")}: ${i.message}`
      ).join("; ") ?? "validation failed"
    : "validation failed"
  return { props, corrected: false, error: errorMsg }
}

/**
 * Create the MCP server with all sites-agent tools.
 */
export function createSitesAgentMcpServer(options: {
  session: string
  emitSiteCreated: (config: Record<string, unknown>) => void
}) {
  const { session, emitSiteCreated } = options

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
    }
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
        const structure = await discoverSitePages(args.url)
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
    }
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

        if (existsSync(projectDir)) {
          return { content: [{ type: "text" as const, text: `Error: Directory apps/${siteId} already exists` }], isError: true }
        }

        const port = args.port || await findAvailablePort(root)

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
        await writeFile(join(projectDir, "blocks/register.ts"), blocksRegisterTs(), "utf-8")
        await writeFile(join(projectDir, "public/logo.svg"), defaultLogoSvg(args.name), "utf-8")
        await writeFile(join(projectDir, "public/favicon.svg"), faviconSvg(args.name), "utf-8")

        const envContent = `ORCHESTRATOR_URL=http://localhost:4200\nDRAFT_MODE_SECRET=dev-secret\nNEXT_PUBLIC_DEFAULT_SITE_ID=${siteId}\nNEXT_PUBLIC_SITE_NAME=${args.name}\nNEXT_PUBLIC_EDITOR_ORIGIN=http://localhost:4100\n`
        await writeFile(join(projectDir, ".env.local"), envContent, "utf-8")

        // Run pnpm install (async to avoid blocking event loop)
        const { execFile } = await import("node:child_process")
        const { promisify } = await import("node:util")
        await promisify(execFile)("pnpm", ["install", "--no-frozen-lockfile"], { cwd: root, timeout: 60_000 })

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

        // Launch dev server in background (fire-and-forget)
        console.log(`[sites-agent] Starting dev server for ${siteId} on port ${port}...`)
        const { spawn } = await import("node:child_process")
        const devProcess = spawn("pnpm", ["--filter", `@ai-site-editor/${siteId}`, "dev"], {
          cwd: root,
          stdio: "ignore",
          detached: true,
        })
        devProcess.unref() // don't block orchestrator shutdown

        emitSiteCreated(siteConfig)

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "site_created",
              config: siteConfig,
              projectPath: projectDir,
              port,
              devServerStarted: true,
              instructions: `Site scaffolded at apps/${siteId} and dev server starting on port ${port}.`,
            }),
          }],
        }
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
      }
    }
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
        const result = await scrapeFullPage(args.url)
        const { content, screenshot, sections, outline, nav } = result

        // Extract design tokens from CSS
        const tokens = extractDesignTokens(content.css)
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

        if (screenshot) {
          return {
            content: [
              { type: "text" as const, text: textData },
              { type: "image" as const, data: screenshot.base64, mimeType: "image/jpeg" as const },
            ],
          }
        }

        return { content: [{ type: "text" as const, text: textData }] }
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
    }
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
    }
  )

  // ── BOOTSTRAP PAGES ──
  const bootstrapPagesTool = tool(
    "bootstrap_pages",
    `Create pages with blocks for a site. REQUIRES create_site to be called first — will error if the site project doesn't exist. Available block types: ${Object.keys(getAllBlockMeta()).join(", ")}`,
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
    },
    async (args) => {
      try {
        // Verify the site project was scaffolded first
        const root = monorepoRoot()
        const projectPkg = join(root, "apps", args.siteId, "package.json")
        if (!existsSync(projectPkg)) {
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
        const pageDocs = normalizedPages.map(page => {
          const contentBlocks = page.blocks.filter(b => {
            if (b.type === "SiteHeader") { strippedCount++; return false }
            if (b.type === "Footer") {
              if (!footerBlock) footerBlock = { type: b.type, props: b.props }
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
                mergedProps = { ...baseProps }
                for (const [key, value] of Object.entries(validation.props)) {
                  mergedProps[key] = value
                }
              } else if (validation.error) {
                console.warn(`[sites-agent] ${b.type} block validation: ${validation.error}`)
              }
            }
            return { id: `b_${b.type.toLowerCase()}_${i + 1}`, type: b.type, props: mergedProps }
          })

          return {
            id: `p_${page.slug === "/" ? "home" : page.slug.replace(/^\//, "").replace(/\//g, "_")}`,
            slug: page.slug,
            title: page.title,
            blocks,
            ...(page.meta ? { meta: page.meta } : {}),
            updatedAt: new Date().toISOString(),
          }
        })
        if (strippedCount > 0) console.log(`[sites-agent] Stripped ${strippedCount} chrome blocks (SiteHeader/Footer)`)

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

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "applied",
              pagesCreated: createdPages,
              totalBlocks: args.pages.reduce((sum, p) => sum + p.blocks.length, 0),
              persistedToFile: true,
            }),
          }],
        }
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
      }
    }
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
        const result = await downloadImage(args.url, args.alt, outputDir)
        const localUrl = `/images/${result.fileName}`
        return { content: [{ type: "text" as const, text: JSON.stringify({ localUrl, fileName: result.fileName }) }] }
      } catch {
        return { content: [{ type: "text" as const, text: JSON.stringify({ localUrl: args.url, error: "Download failed, using original URL" }) }] }
      }
    }
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
    }
  )

  return createSdkMcpServer({
    name: "sites-agent",
    version: "1.0.0",
    tools: [listSitesTool, discoverStructureTool, createSiteTool, scrapeUrlTool, extractTokensTool, bootstrapPagesTool, downloadImageTool, applyThemeTool],
  })
}

// ── Boilerplate template functions (unchanged from original) ──

function packageJson(siteId: string, name: string, port: number): string {
  return JSON.stringify({
    name: `@ai-site-editor/${siteId}`,
    version: "0.0.1",
    private: true,
    type: "module",
    scripts: { dev: `next dev -p ${port}`, build: "next build", start: `next start -p ${port}`, typecheck: "tsc --noEmit" },
    dependencies: {
      "@ai-site-editor/blocks": "workspace:*", "@ai-site-editor/shared": "workspace:*", "@ai-site-editor/site-sdk": "workspace:*",
      "@tailwindcss/postcss": "^4.2.1", next: "15.2.8", react: "^19.0.0", "react-dom": "^19.0.0", tailwindcss: "^4.2.1", zod: "^4.3.6",
    },
    devDependencies: { "@types/node": "^22.13.10", "@types/react": "^19.0.10", "@types/react-dom": "^19.0.4", typescript: "^5.7.3" },
  }, null, 2) + "\n"
}

function nextConfigTs(): string {
  return `import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: [
    "@ai-site-editor/preview-adapter",
    "@ai-site-editor/site-sdk",
    "@ai-site-editor/blocks",
    "@ai-site-editor/shared",
  ],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "plus.unsplash.com" },
      { protocol: "https", hostname: "oaidalleapiprodscus.blob.core.windows.net" },
      { protocol: "https", hostname: "placehold.co" },
      { protocol: "http", hostname: "localhost" },
    ],
  },
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = { ...config.watchOptions, followSymlinks: true }
      config.resolve = { ...config.resolve, symlinks: false }
      config.cache = { ...config.cache, version: \`\${process.env.WORKSPACE_CACHE_BUST ?? Date.now()}\` }
    }
    return config
  },
}

export default nextConfig
`
}

function tsconfigJson(): string {
  return JSON.stringify({
    compilerOptions: {
      target: "ES2022", lib: ["dom", "dom.iterable", "es2022"], allowJs: false, skipLibCheck: true,
      strict: true, noEmit: true, esModuleInterop: true, module: "esnext", moduleResolution: "bundler",
      resolveJsonModule: true, isolatedModules: true, allowImportingTsExtensions: true, jsx: "preserve",
      incremental: true, plugins: [{ name: "next" }],
    },
    include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
    exclude: ["node_modules"],
  }, null, 2) + "\n"
}

function postcssConfig(): string {
  return `export default {\n  plugins: {\n    "@tailwindcss/postcss": {}\n  }\n}\n`
}

function layoutTsx(siteName: string): string {
  return `import "./globals.css"
import type { Metadata } from "next"
import type { ReactNode } from "react"

export const metadata: Metadata = {
  title: { default: ${JSON.stringify(siteName)}, template: \`%s · ${siteName}\` },
  description: ${JSON.stringify(siteName)},
  icons: { icon: "/favicon.svg" },
}

const themeScript = \`(function(){try{var t=localStorage.getItem('site-theme-v1');if(t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme:dark)').matches))document.documentElement.classList.add('dark')}catch(e){}})()\`

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
`
}

function globalsCss(): string {
  return `@import "tailwindcss";
@import "@ai-site-editor/blocks/styles.css";

:root {
  /* Backgrounds */
  --bg-0: #ffffff;
  --bg-100: #f8f9fa;
  --bg-1: #ffffff;
  --section-bg: var(--bg-100);

  /* Text */
  --text-100: #1a1a2e;
  --text-200: #4a4a6a;
  --heading: #1a1a2e;
  --body: #333355;
  --body-secondary: #6b7280;
  --text-300: #52525b;
  --caption: #64748b;

  /* Brand */
  --brand: #2563eb;
  --brand-hover: #1d4ed8;
  --brand-subtle: #dbeafe;
  --brand-fg: #ffffff;

  /* Surfaces */
  --surface: #ffffff;
  --surface-border: #e5e7eb;
  --border: #e5e7eb;
  --card-bg: #f8fafc;
  --card-shadow: 0 1px 3px rgba(0,0,0,0.08);
  --hero-bg: var(--bg-0);
  --cta-bg: var(--bg-100);
  --placeholder-img: #e2e8f0;

  /* Footer */
  --footer-bg: #1a1a2e;
  --footer-text: #cbd5e1;
  --footer-heading: #f1f5f9;
  --footer-link: #94a3b8;
  --footer-link-hover: #e2e8f0;
  --footer-border: #2d2d4a;

  /* Typography */
  --font-body: system-ui, -apple-system, sans-serif;
  --font-heading: system-ui, -apple-system, sans-serif;

  /* Shapes */
  --radius-btn: 6px;
  --radius-card: 8px;
  --radius-feature: 8px;
}

/* Dark mode — follows system preference or .dark class on <html> */
@media (prefers-color-scheme: dark) {
  :root:not(.light) {
    --bg-0: #0f172a;
    --bg-100: #1e293b;
    --bg-1: #0f172a;
    --section-bg: var(--bg-100);

    --text-100: #f1f5f9;
    --text-200: #cbd5e1;
    --heading: #f1f5f9;
    --body: #cbd5e1;
    --body-secondary: #94a3b8;
    --text-300: #94a3b8;
    --caption: #94a3b8;

    --brand: #3b82f6;
    --brand-hover: #60a5fa;
    --brand-subtle: #1e3a5f;
    --brand-fg: #ffffff;

    --surface: #1e293b;
    --surface-border: #334155;
    --border: #334155;
    --card-bg: #1e293b;
    --card-shadow: 0 1px 3px rgba(0,0,0,0.3);
    --hero-bg: var(--bg-0);
    --cta-bg: var(--bg-100);
    --placeholder-img: #334155;

    --footer-bg: #020617;
    --footer-text: #94a3b8;
    --footer-heading: #e2e8f0;
    --footer-link: #64748b;
    --footer-link-hover: #cbd5e1;
    --footer-border: #1e293b;
  }
}

/* Explicit .dark class override (from JS toggle or localStorage) */
.dark {
  --bg-0: #0f172a;
  --bg-100: #1e293b;
  --bg-1: #0f172a;
  --section-bg: var(--bg-100);

  --text-100: #f1f5f9;
  --text-200: #cbd5e1;
  --heading: #f1f5f9;
  --body: #cbd5e1;
  --body-secondary: #94a3b8;
  --text-300: #94a3b8;
  --caption: #94a3b8;

  --brand: #3b82f6;
  --brand-hover: #60a5fa;
  --brand-subtle: #1e3a5f;
  --brand-fg: #ffffff;

  --surface: #1e293b;
  --surface-border: #334155;
  --border: #334155;
  --card-bg: #1e293b;
  --card-shadow: 0 1px 3px rgba(0,0,0,0.3);
  --hero-bg: var(--bg-0);
  --cta-bg: var(--bg-100);
  --placeholder-img: #334155;

  --footer-bg: #020617;
  --footer-text: #94a3b8;
  --footer-heading: #e2e8f0;
  --footer-link: #64748b;
  --footer-link-hover: #cbd5e1;
  --footer-border: #1e293b;
}
`
}

function defaultsTs(siteId: string, siteName: string): string {
  return `export const DEFAULT_SITE_ID = process.env.NEXT_PUBLIC_DEFAULT_SITE_ID?.trim() || ${JSON.stringify(siteId)}
export const DEFAULT_SESSION = process.env.DRAFT_DEFAULT_SESSION?.trim() || "dev"
export const DEFAULT_SITE_NAME = process.env.NEXT_PUBLIC_SITE_NAME?.trim() || ${JSON.stringify(siteName)}
`
}

function editorApiRoute(): string {
  return `import { createEditorApiHandler } from "@ai-site-editor/site-sdk/routes"
import { createJsonFilePublishHandler } from "@ai-site-editor/site-sdk/publish-handlers/json-file"
import { resolve } from "node:path"
import { readFile } from "node:fs/promises"
import type { PageDoc } from "@ai-site-editor/shared"

const PAGES_PATH = resolve(process.cwd(), "content/pages.json")

async function loadPages(): Promise<PageDoc[]> {
  try {
    return JSON.parse(await readFile(PAGES_PATH, "utf-8")) as PageDoc[]
  } catch { return [] }
}

export const { GET, POST, OPTIONS } = createEditorApiHandler({
  getPages: loadPages,
  publishSecret: process.env.PUBLISH_TOKEN?.trim() || undefined,
  onPublish: createJsonFilePublishHandler(PAGES_PATH),
})
`
}

function pageTsx(siteId: string): string {
  return `import { createSitePage } from "@ai-site-editor/site-sdk/page"
import { resolve } from "node:path"
import { readFile } from "node:fs/promises"
import { readFileSync, existsSync } from "node:fs"
import type { PageDoc } from "@ai-site-editor/shared"

// Import custom blocks manifest — registers schemas + renderers (file created by block-coder)
import "../../blocks/register"

const PAGES_PATH = resolve(process.cwd(), "content/pages.json")
const CONFIG_PATH = resolve(process.cwd(), "content/site-config.json")

async function loadPages(): Promise<PageDoc[]> {
  try {
    const raw = await readFile(PAGES_PATH, "utf-8")
    return JSON.parse(raw) as PageDoc[]
  } catch { return [] }
}

async function loadSiteConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf-8"))
  } catch { return {} }
}

// Load footer at module init (sync) so it can be passed to createSitePage
const _siteConfig = existsSync(CONFIG_PATH)
  ? (() => { try { return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) } catch { return {} } })()
  : {}

const { Page, generateStaticParams } = createSitePage({
  siteId: ${JSON.stringify(siteId)},
  getPage: async (slug) => {
    const pages = await loadPages()
    return pages.find((p) => p.slug === slug) ?? null
  },
  getSlugs: async () => {
    const pages = await loadPages()
    return pages.map((p) => p.slug)
  },
  getSiteConfig: loadSiteConfig,
  footer: _siteConfig.footer ?? undefined,
})

export default Page
export { generateStaticParams }
`
}

function blocksRegisterTs(): string {
  return `// Custom blocks — auto-updated by block-coder subagent
// Each custom block adds: import schema (side-effect), import renderer, registerCustomRenderer()
import { registerCustomRenderer } from "@ai-site-editor/blocks"

// Block imports will be added here by the block-coder:
// import "./pricing-table/schema"
// import { PricingTable } from "./pricing-table/renderer"
// registerCustomRenderer("PricingTable", PricingTable)
`
}

function samplePagesJson(): string {
  return `[\n  {\n    "id": "home",\n    "slug": "/",\n    "title": "Home",\n    "blocks": [],\n    "updatedAt": "${new Date().toISOString()}"\n  }\n]\n`
}

function defaultLogoSvg(siteName: string): string {
  const initials = siteInitials(siteName)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 38 38" width="38" height="38">
  <rect width="38" height="38" rx="8" fill="var(--brand, #2563eb)"/>
  <text x="19" y="20" text-anchor="middle" dominant-baseline="central" font-family="system-ui, sans-serif" font-weight="700" font-size="16" fill="var(--brand-fg, #fff)">${initials}</text>
</svg>`
}

function faviconSvg(siteName: string): string {
  const initials = siteInitials(siteName)
  // Favicon uses hardcoded colors (no CSS vars) for browser tab compatibility
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="6" fill="#2563eb"/>
  <text x="16" y="17" text-anchor="middle" dominant-baseline="central" font-family="system-ui, sans-serif" font-weight="700" font-size="14" fill="#fff">${initials}</text>
</svg>`
}

function siteInitials(siteName: string): string {
  return siteName.split(/\s+/).map(w => w[0]?.toUpperCase() ?? "").join("").slice(0, 2) || "S"
}
