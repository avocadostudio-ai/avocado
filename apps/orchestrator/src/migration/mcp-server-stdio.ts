#!/usr/bin/env npx tsx
/**
 * Standalone MCP stdio server for site migration tools.
 * Spawned by the Claude CLI via --mcp-config.
 *
 * Usage: MIGRATION_SESSION=dev npx tsx apps/orchestrator/src/migration/mcp-server-stdio.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import {
  scrapeFullPage,
  buildPageSpecs,
  extractDesignTokens,
  mapToThemeVariables,
  downloadImage,
  discoverSitePages,
} from "@ai-site-editor/migration-sdk"
import { getAllBlockMeta } from "@ai-site-editor/shared"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { getCachedScrape, setCachedScrape } from "./scrape-cache.js"
import { saveScreenshot, saveScrapeDebug } from "./migration-tools.js"
import { getDraftModeSecret } from "../agent/sites-agent-shared.js"
import {
  sanitizeSiteId, monorepoRoot, findAvailablePort, patchGlobalsCssVars,
  normalizePageBlocks, scaffoldSiteProject, analyzeCodebase, cloneRepo, detectSitePort,
  startAndWaitForDevServer,
  pageTsx, hybridPageTsx, editorApiRoute, blocksRegisterTsx, defaultsTs, samplePagesJson,
  defaultLogoSvg, faviconSvg,
} from "../agent/sites-agent-shared.js"

const session = process.env.MIGRATION_SESSION ?? "dev"

const server = new McpServer({ name: "sites-agent", version: "1.0.0" })

// ── discover_site_structure ──
server.tool("discover_site_structure", "Discover pages on a website via sitemap.xml, robots.txt, and link crawling", {
  url: z.string().describe("Site URL to discover"),
}, async ({ url }) => {
  const result = await discoverSitePages(url)
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }
})

// ── generate_page_specs ──
server.tool("generate_page_specs", "Scrape a URL and generate section specs with computed CSS styles, content, and design notes", {
  url: z.string().describe("URL to analyze"),
}, async ({ url }) => {
  let scrape = getCachedScrape(url)
  if (!scrape) {
    scrape = await scrapeFullPage(url)
    setCachedScrape(url, scrape)
  }
  const specs = buildPageSpecs(scrape)
  const tokens = extractDesignTokens(scrape.content.css, scrape.resolvedCssVars)
  const theme = mapToThemeVariables(tokens)
  if (scrape.computedFonts) {
    if (scrape.computedFonts.heading) theme["--font-heading"] = scrape.computedFonts.heading + ", sans-serif"
    if (scrape.computedFonts.body) theme["--font-body"] = scrape.computedFonts.body + ", sans-serif"
  }

  // Save debug artifacts
  if (scrape.screenshot) saveScreenshot("desktop", scrape.screenshot.base64, url).catch(() => {})
  if (scrape.mobileScreenshot) saveScreenshot("mobile", scrape.mobileScreenshot.base64, url).catch(() => {})
  saveScrapeDebug(url, { url, specs, designTokens: tokens, themeVariables: theme, nav: scrape.nav, embeds: scrape.embeds, computedFonts: scrape.computedFonts }).catch(() => {})

  return { content: [{ type: "text" as const, text: JSON.stringify({ pageTitle: scrape.content.title, sectionCount: specs.length, specs, designTokens: tokens, themeVariables: theme, nav: scrape.nav, embeds: scrape.embeds }, null, 2) }] }
})

// ── scrape_url ──
server.tool("scrape_url", "Scrape a web page with Playwright, returns sections, design tokens, and screenshot", {
  url: z.string().describe("URL to scrape"),
}, async ({ url }) => {
  let result = getCachedScrape(url)
  if (!result) {
    result = await scrapeFullPage(url)
    setCachedScrape(url, result)
  }
  const tokens = extractDesignTokens(result.content.css, result.resolvedCssVars)
  const themeVars = mapToThemeVariables(tokens)
  const textData = JSON.stringify({ title: result.content.title, navigation: result.nav, sectionCount: result.sections.length, designTokens: tokens, themeVariables: themeVars })
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [{ type: "text", text: textData }]
  if (result.screenshot) content.push({ type: "image", data: result.screenshot.base64, mimeType: "image/jpeg" })
  if (result.mobileScreenshot) content.push({ type: "image", data: result.mobileScreenshot.base64, mimeType: "image/jpeg" })
  return { content }
})

// ── extract_design_tokens ──
server.tool("extract_design_tokens", "Extract design tokens (colors, fonts, border radii) from CSS text. Maps them to theme variables.", {
  css: z.string().describe("Raw CSS text to analyze"),
}, async ({ css }) => {
  try {
    const tokens = extractDesignTokens(css)
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
})

// ── download_remote_images ──
server.tool("download_remote_images", "Download multiple images to a site's public/images/ directory", {
  siteId: z.string().describe("Site ID"),
  images: z.array(z.object({ url: z.string(), alt: z.string().optional() })).describe("Images to download"),
}, async ({ siteId, images }) => {
  const outputDir = join(monorepoRoot(), "apps", siteId, "public", "images")
  await mkdir(outputDir, { recursive: true })
  const results: Array<{ url: string; localUrl: string; error?: string }> = []
  for (let i = 0; i < images.length; i += 4) {
    const batch = images.slice(i, i + 4)
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
  return { content: [{ type: "text" as const, text: JSON.stringify({ results, succeeded: results.filter(r => !r.error).length }) }] }
})

// ── download_remote_image (singular — matches SDK tool name) ──
server.tool("download_remote_image", "Download a single remote image to the site's public/images/ directory", {
  url: z.string().describe("Image URL to download"),
  siteId: z.string().describe("Site ID"),
  alt: z.string().optional().describe("Alt text"),
}, async ({ url, siteId, alt }) => {
  try {
    const outputDir = join(monorepoRoot(), "apps", siteId, "public", "images")
    await mkdir(outputDir, { recursive: true })
    const result = await downloadImage(url, alt, outputDir)
    const localUrl = `/images/${result.fileName}`
    return { content: [{ type: "text" as const, text: JSON.stringify({ localUrl, fileName: result.fileName }) }] }
  } catch {
    return { content: [{ type: "text" as const, text: JSON.stringify({ localUrl: url, error: "Download failed, using original URL" }) }] }
  }
})

// ── create_site ──
server.tool("create_site", "Scaffold a Next.js site project in the monorepo", {
  name: z.string().describe("Site name"),
  siteId: z.string().optional().describe("Kebab-case ID"),
  purpose: z.string().optional().describe("Site purpose"),
}, async ({ name, siteId: rawId, purpose }) => {
  const siteId = rawId ?? sanitizeSiteId(name)
  const root = monorepoRoot()
  const projectDir = join(root, "apps", siteId)

  try {
    // If project already exists, clean it and reuse
    if (existsSync(projectDir)) {
      let port = 0
      try {
        const pkg = JSON.parse(await readFile(join(projectDir, "package.json"), "utf-8"))
        const m = pkg.scripts?.dev?.match(/-p\s*(\d+)/)
        if (m) port = Number(m[1])
      } catch { /* use default */ }

      // Validate existing port is free; fall back to auto-assign
      if (port) {
        const { createServer } = await import("node:net")
        const free = await new Promise<boolean>((res) => {
          const s = createServer()
          s.once("error", () => res(false))
          s.once("listening", () => { s.close(() => res(true)) })
          s.listen(port, "127.0.0.1")
        })
        if (!free) port = 0
      }
      if (!port) port = await findAvailablePort(root)

      const { rm } = await import("node:fs/promises")
      for (const dir of ["content", "blocks", "public/images", ".next"]) {
        const target = join(projectDir, dir)
        if (existsSync(target)) await rm(target, { recursive: true, force: true })
      }
      await mkdir(join(projectDir, "content"), { recursive: true })
      await mkdir(join(projectDir, "blocks"), { recursive: true })
      await mkdir(join(projectDir, "public/images"), { recursive: true })
      await writeFile(join(projectDir, "blocks/register.tsx"),
        `import { registerCustomRenderer } from "@ai-site-editor/blocks"\n`, "utf-8")
      // Update package.json with validated port
      const existingPkg = JSON.parse(await readFile(join(projectDir, "package.json"), "utf-8"))
      if (existingPkg.scripts?.dev) {
        existingPkg.scripts.dev = existingPkg.scripts.dev.replace(/-p\s*\d+/, `-p ${port}`)
        await writeFile(join(projectDir, "package.json"), JSON.stringify(existingPkg, null, 2), "utf-8")
      }

      return { content: [{ type: "text" as const, text: JSON.stringify({ status: "reused", siteId, port, projectPath: projectDir }) }] }
    }

    // New project — use shared scaffolding
    const result = await scaffoldSiteProject({ siteId, name, purpose })

    // Start dev server and wait for readiness
    const { serverReady } = await startAndWaitForDevServer({
      siteId, port: result.port, cwd: root, useFilter: true,
    })

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: "site_created",
          siteId: result.siteId,
          port: result.port,
          projectPath: result.projectDir,
          devServerStarted: serverReady,
        }),
      }],
    }
  } catch (e: unknown) {
    return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
  }
})

// ── bootstrap_pages ──
server.tool("bootstrap_pages", `Create pages with blocks for a site. Built-in block types: ${Object.keys(getAllBlockMeta()).join(", ")}. Custom block types registered in blocks/register.ts are also supported — use the exact component name as the block type.`, {
  siteId: z.string().describe("Site ID"),
  pages: z.array(z.object({
    slug: z.string(),
    title: z.string(),
    blocks: z.array(z.object({ type: z.string(), props: z.record(z.string(), z.unknown()) })),
    meta: z.object({
      title: z.string().optional(),
      description: z.string().optional(),
    }).optional(),
  })),
  themeOverrides: z.record(z.string(), z.string()).optional().describe("CSS variable overrides"),
  navLabels: z.record(z.string(), z.string()).optional().describe("Custom nav labels per slug"),
  navGroups: z.record(z.string(), z.array(z.string())).optional().describe("Nav dropdown groups"),
  siteLogo: z.string().optional().describe("Logo URL"),
  siteName: z.string().optional().describe("Site name for header"),
}, async ({ siteId, pages, themeOverrides, navLabels, navGroups, siteLogo, siteName }) => {
  try {
    if (!pages.some(p => p.slug === "/" || p.slug === "")) {
      pages.unshift({ slug: "/", title: "Home", blocks: [] })
    }

    const root = monorepoRoot()
    const pagesJsonPath = join(root, "apps", siteId, "content", "pages.json")
    await mkdir(dirname(pagesJsonPath), { recursive: true })

    const footerRef: { value: { type: string; props: Record<string, unknown> } | null } = { value: null }

    // Normalize slugs and validate blocks using shared logic
    const pageDocs = pages.map(page => {
      const slug = page.slug === "/" ? "/" : `/${page.slug.replace(/^\/+/, "").replace(/\/+$/, "")}`
      const { contentBlocks, footerBlock } = normalizePageBlocks(page.blocks)
      if (footerBlock && !footerRef.value) footerRef.value = footerBlock

      return {
        id: `p_${slug === "/" ? "home" : slug.replace(/^\//, "").replace(/\//g, "_")}`,
        slug,
        title: page.title,
        blocks: contentBlocks,
        ...(page.meta ? { meta: page.meta } : {}),
        updatedAt: new Date().toISOString(),
      }
    })

    await writeFile(pagesJsonPath, JSON.stringify(pageDocs, null, 2) + "\n", "utf-8")

    // Persist site config (nav, logo, footer)
    const configPath = join(root, "apps", siteId, "content", "site-config.json")
    const config: Record<string, unknown> = {}
    if (siteName) config.name = siteName
    if (siteLogo) config.logo = siteLogo
    if (navLabels) config.navLabels = navLabels
    if (navGroups) config.navGroups = navGroups
    if (footerRef.value) config.footer = { id: "chrome_footer", type: footerRef.value.type, props: footerRef.value.props }
    if (Object.keys(config).length > 0) {
      await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8")
    }

    // Apply theme overrides to globals.css
    if (themeOverrides && Object.keys(themeOverrides).length > 0) {
      await patchGlobalsCssVars(join(root, "apps", siteId, "app", "globals.css"), themeOverrides)
    }

    // Sync with orchestrator draft state
    const orchestratorUrl = process.env.ORCHESTRATOR_URL ?? "http://localhost:4200"
    try {
      await fetch(`${orchestratorUrl}/draft/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session, siteId, pages: pageDocs, overwrite: true }),
      })
    } catch { /* orchestrator may not be running */ }

    const totalBlocks = pageDocs.reduce((s, p) => s + p.blocks.length, 0)
    return { content: [{ type: "text" as const, text: JSON.stringify({ status: "applied", pagesCreated: pageDocs.length, totalBlocks }) }] }
  } catch (e: unknown) {
    return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
  }
})

// ── apply_theme ──
server.tool("apply_theme", "Apply CSS custom property overrides to a site's theme", {
  siteId: z.string().describe("Site ID"),
  variables: z.record(z.string(), z.string()).describe("CSS variable overrides, e.g. { '--brand': '#2563eb' }"),
}, async ({ siteId, variables }) => {
  try {
    await patchGlobalsCssVars(join(monorepoRoot(), "apps", siteId, "app", "globals.css"), variables)
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ status: "applied", variableCount: Object.keys(variables).length }),
      }],
    }
  } catch (e: unknown) {
    return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
  }
})

// ── clone_repo ──
server.tool("clone_repo", "Clone a GitHub repository to a local directory. Uses `gh repo clone` for auth, falls back to `git clone`. Returns the local path for use with analyze_codebase.", {
  url: z.string().describe("GitHub repo URL (e.g. 'https://github.com/user/repo') or shorthand ('user/repo')"),
  targetDir: z.string().optional().describe("Target directory name inside apps/. Defaults to repo name."),
}, async ({ url, targetDir }) => {
  try {
    const result = await cloneRepo(url, targetDir)
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }
  } catch (e: unknown) {
    return { content: [{ type: "text" as const, text: `Error cloning repo: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
  }
})

// ── integrate_site (composite) ──
server.tool("integrate_site", "Add AI Site Editor SDK integration to an existing Next.js project in ONE step. Creates all integration files, adds block styles import to layout, installs deps, and starts the dev server.", {
  siteId: z.string().describe("Site ID (kebab-case, matches directory name in apps/)"),
  name: z.string().describe("Human-readable site name"),
  purpose: z.string().optional().describe("What the site is about"),
  layoutPath: z.string().optional().describe("Relative path to layout file"),
  useSrcDir: z.boolean().optional().describe("Whether the project uses src/app/"),
}, async ({ siteId, name, purpose, layoutPath, useSrcDir }) => {
  try {
    const root = monorepoRoot()
    const projectDir = join(root, "apps", siteId)

    if (!existsSync(join(projectDir, "package.json"))) {
      return { content: [{ type: "text" as const, text: `Error: apps/${siteId}/package.json not found.` }], isError: true }
    }

    const appDir = useSrcDir ? "src/app" : "app"
    const filesCreated: string[] = []

    // Read package.json and auto-detect name
    const pkgPath = join(projectDir, "package.json")
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8"))

    const genericNames = new Set(["sample site", "my site", "site", "test site", "new site", "untitled", ""])
    let siteName = name
    if (!siteName || genericNames.has(siteName.toLowerCase())) {
      const lf = layoutPath ? join(projectDir, layoutPath) : join(projectDir, appDir, "layout.tsx")
      if (existsSync(lf)) {
        const src = await readFile(lf, "utf-8")
        const m = src.match(/title:\s*(?:\{\s*default:\s*)?["']([^"']+)["']/)
        if (m?.[1]) siteName = m[1]
      }
      if (!siteName || genericNames.has(siteName.toLowerCase())) {
        siteName = (pkg.name ?? siteId).replace(/^@[^/]+\//, "").replace(/[-_]/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()).trim() || "My Site"
      }
    }

    // Add workspace deps
    const deps = pkg.dependencies ?? {}
    let depsAdded = false
    for (const dep of ["@ai-site-editor/site-sdk", "@ai-site-editor/blocks", "@ai-site-editor/shared"]) {
      if (!deps[dep]) { deps[dep] = "workspace:*"; depsAdded = true }
    }
    if (depsAdded) {
      pkg.dependencies = deps
      await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8")
      filesCreated.push("package.json (deps added)")
    }

    // Create or wrap catch-all page route for editor-managed pages
    const catchAllDir = join(projectDir, appDir, "[[...slug]]")
    const catchAllPage = join(catchAllDir, "page.tsx")
    const originalPage = join(catchAllDir, "_original-page.tsx")
    const editorPage = join(catchAllDir, "_editor-page.tsx")
    const blocksPrefix = useSrcDir ? "../../../" : "../../"

    let isHybrid = false
    if (!existsSync(catchAllDir)) {
      // Case A: No catch-all — create standard editor catch-all
      await mkdir(catchAllDir, { recursive: true })
      await writeFile(catchAllPage, pageTsx(siteId).replace('import "../../blocks/register"', `import "${blocksPrefix}blocks/register"`), "utf-8")
      filesCreated.push(`${appDir}/[[...slug]]/page.tsx`)
    } else if (existsSync(catchAllPage) && !existsSync(originalPage)) {
      // Case B: Existing catch-all, not yet wrapped — create hybrid
      isHybrid = true
      const { rename } = await import("node:fs/promises")
      await rename(catchAllPage, originalPage)
      const editorContent = pageTsx(siteId, { chrome: false }).replace('import "../../blocks/register"', `import "${blocksPrefix}blocks/register"`)
      await writeFile(editorPage, editorContent, "utf-8")
      await writeFile(catchAllPage, hybridPageTsx(siteId), "utf-8")
      filesCreated.push(`${appDir}/[[...slug]]/_original-page.tsx (preserved)`)
      filesCreated.push(`${appDir}/[[...slug]]/_editor-page.tsx`)
      filesCreated.push(`${appDir}/[[...slug]]/page.tsx (hybrid wrapper)`)
    } else if (existsSync(originalPage)) {
      isHybrid = true
    }

    // Create editor API route
    const apiDir = join(projectDir, appDir, "api/editor/[...path]")
    const apiBlocksPrefix = useSrcDir ? "../../../../../" : "../../../../"
    if (!existsSync(apiDir)) {
      await mkdir(apiDir, { recursive: true })
      await writeFile(join(apiDir, "route.ts"), editorApiRoute().replace('import "../../../../blocks/register"', `import "${apiBlocksPrefix}blocks/register"`), "utf-8")
      filesCreated.push(`${appDir}/api/editor/[...path]/route.ts`)
    }

    // Create content dir (empty for hybrid — existing pages fall through to original)
    const contentDir = join(projectDir, "content")
    if (!existsSync(join(contentDir, "pages.json"))) {
      await mkdir(contentDir, { recursive: true })
      await writeFile(join(contentDir, "pages.json"), isHybrid ? "[]\n" : samplePagesJson(), "utf-8")
      filesCreated.push("content/pages.json")
    }

    // Create blocks register
    const blocksDir = join(projectDir, "blocks")
    if (!existsSync(join(blocksDir, "register.ts")) && !existsSync(join(blocksDir, "register.tsx"))) {
      await mkdir(blocksDir, { recursive: true })
      await writeFile(join(blocksDir, "register.tsx"), blocksRegisterTsx(), "utf-8")
      filesCreated.push("blocks/register.tsx")
    }

    // Create lib/defaults.ts
    const libDir = join(projectDir, "lib")
    if (!existsSync(join(libDir, "defaults.ts"))) {
      await mkdir(libDir, { recursive: true })
      await writeFile(join(libDir, "defaults.ts"), defaultsTs(siteId, siteName), "utf-8")
      filesCreated.push("lib/defaults.ts")
    }

    // Create/merge .env.local
    const envPath = join(projectDir, ".env.local")
    const envVars: Record<string, string> = {
      ORCHESTRATOR_URL: "http://localhost:4200",
      DRAFT_MODE_SECRET: getDraftModeSecret(),
      NEXT_PUBLIC_DEFAULT_SITE_ID: siteId,
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

    // Add block styles import + EditorOverlay to layout
    const layoutFile = layoutPath ? join(projectDir, layoutPath) : join(projectDir, appDir, "layout.tsx")
    if (existsSync(layoutFile)) {
      let layoutContent = await readFile(layoutFile, "utf-8")
      let layoutModified = false

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

      if (!layoutContent.includes("EditorOverlay")) {
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
        layoutContent = layoutContent.replace(
          "</body>",
          `        <EditorOverlay slug="/" editorOrigin={process.env.NEXT_PUBLIC_EDITOR_ORIGIN ?? "http://localhost:4100"} />\n      </body>`
        )
        layoutModified = true
      }

      if (layoutModified) {
        await writeFile(layoutFile, layoutContent, "utf-8")
        filesCreated.push(layoutPath ?? `${appDir}/layout.tsx (styles + editor overlay added)`)
      }
    }

    // Default assets
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

    // Install deps
    if (depsAdded) {
      const { execFile } = await import("node:child_process")
      const { promisify } = await import("node:util")
      await promisify(execFile)("pnpm", ["install", "--no-frozen-lockfile"], { cwd: root, timeout: 60_000 })
    }

    // Detect port for reference (dev server started separately via launch_site)
    const port = await detectSitePort(projectDir)

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ status: "integrated", siteId, port, name: siteName, filesCreated }),
      }],
    }
  } catch (e: unknown) {
    return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
  }
})

// ── launch_site ──
server.tool("launch_site", "Start the dev server for an integrated site, wait for it to be ready, and register it in the editor. Call this AFTER integrate_site completes. Returns the confirmed preview URL once the server is responding.", {
  siteId: z.string().describe("Site ID (matches directory name in apps/)"),
  name: z.string().optional().describe("Human-readable site name"),
  purpose: z.string().optional().describe("What the site is about"),
}, async ({ siteId, name, purpose }) => {
  try {
    const root = monorepoRoot()
    const projectDir = join(root, "apps", siteId)

    if (!existsSync(join(projectDir, "package.json"))) {
      return { content: [{ type: "text" as const, text: `Error: apps/${siteId}/package.json not found.` }], isError: true }
    }

    let port = await detectSitePort(projectDir)

    // Check if port is in use — if so, find a free one and update package.json
    try {
      const { execSync } = await import("node:child_process")
      const pids = execSync(`lsof -ti:${port} 2>/dev/null`, { encoding: "utf-8" }).trim()
      if (pids) {
        port = await findAvailablePort(root)
        const pkg2 = JSON.parse(await readFile(join(projectDir, "package.json"), "utf-8"))
        if (pkg2.scripts?.dev) {
          pkg2.scripts.dev = pkg2.scripts.dev.replace(/-p\s*\d+/, `-p ${port}`)
          await writeFile(join(projectDir, "package.json"), JSON.stringify(pkg2, null, 2) + "\n", "utf-8")
        }
      }
    } catch {}

    // Sync with orchestrator
    const orchestratorUrl = process.env.ORCHESTRATOR_URL ?? "http://localhost:4200"
    try {
      await fetch(`${orchestratorUrl}/draft/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session, siteId, pages: [], overwrite: false }),
      })
    } catch {}

    // Start dev server and listen for "Ready" message
    const { spawn } = await import("node:child_process")
    const devProcess = spawn("pnpm", ["dev"], {
      cwd: projectDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, WATCHPACK_POLLING: "true", WATCHPACK_POLLING_INTERVAL: "1000", CHOKIDAR_USEPOLLING: "true", CHOKIDAR_INTERVAL: "1000" },
    })
    devProcess.unref()

    let serverReady = false
    const previewUrl = `http://localhost:${port}`
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { resolve() }, 60_000)
      const onData = (chunk: Buffer) => {
        const text = chunk.toString()
        if (text.includes("Ready") || text.includes(`localhost:${port}`)) {
          serverReady = true
          clearTimeout(timeout)
          devProcess.stdout?.removeAllListeners()
          devProcess.stderr?.removeAllListeners()
          resolve()
        }
      }
      devProcess.stdout?.on("data", onData)
      devProcess.stderr?.on("data", onData)
      devProcess.on("exit", () => { clearTimeout(timeout); resolve() })
    })

    const siteName = name ?? siteId
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ status: serverReady ? "running" : "timeout", siteId, port, previewUrl, name: siteName, serverReady }),
      }],
    }
  } catch (e: unknown) {
    return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
  }
})

// ── register_site ──
server.tool("register_site", "Register an existing site project with the editor and start its dev server. Call this AFTER integrating the SDK. The site will appear in the editor's site list.", {
  siteId: z.string().describe("Site ID (kebab-case, matches directory name in apps/)"),
  name: z.string().describe("Human-readable site name"),
  purpose: z.string().optional().describe("What the site is about"),
  port: z.number().optional().describe("Dev server port (auto-detected if omitted)"),
}, async ({ siteId, name, purpose, port: explicitPort }) => {
  try {
    const root = monorepoRoot()
    const projectDir = join(root, "apps", siteId)

    if (!existsSync(join(projectDir, "package.json"))) {
      return { content: [{ type: "text" as const, text: `Error: apps/${siteId}/package.json not found.` }], isError: true }
    }

    const port = explicitPort ?? await detectSitePort(projectDir)

    // Install if needed
    if (!existsSync(join(projectDir, "node_modules"))) {
      const { execFile } = await import("node:child_process")
      const { promisify } = await import("node:util")
      await promisify(execFile)("pnpm", ["install", "--no-frozen-lockfile"], { cwd: root, timeout: 60_000 })
    }

    // Start dev server
    const { spawn } = await import("node:child_process")
    const devProcess = spawn("pnpm", ["--filter", `@ai-site-editor/${siteId}`, "dev"], {
      cwd: root,
      stdio: "ignore",
      detached: true,
      env: { ...process.env, WATCHPACK_POLLING: "true", WATCHPACK_POLLING_INTERVAL: "1000", CHOKIDAR_USEPOLLING: "true", CHOKIDAR_INTERVAL: "1000" },
    })
    devProcess.unref()

    // Sync with orchestrator draft state
    const orchestratorUrl = process.env.ORCHESTRATOR_URL ?? "http://localhost:4200"
    try {
      await fetch(`${orchestratorUrl}/draft/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session, siteId, pages: [], overwrite: false }),
      })
    } catch { /* orchestrator may not be running */ }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: "registered",
          siteId,
          port,
          name,
          previewUrl: `http://localhost:${port}`,
          devServerStarted: true,
        }),
      }],
    }
  } catch (e: unknown) {
    return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
  }
})

// ── analyze_codebase ──
server.tool("analyze_codebase", "Analyze an existing site project to detect framework, CMS, routes, styling, and readiness for AI Site Editor integration", {
  projectPath: z.string().describe("Absolute path to the project root directory"),
}, async ({ projectPath }) => {
  try {
    const analysis = await analyzeCodebase(projectPath)
    return { content: [{ type: "text" as const, text: JSON.stringify(analysis, null, 2) }] }
  } catch (e: unknown) {
    return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
  }
})

// Start stdio transport
const transport = new StdioServerTransport()
await server.connect(transport)
