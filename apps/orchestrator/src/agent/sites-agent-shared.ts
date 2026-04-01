/**
 * Shared utilities for site-agent tools — used by both the Agent SDK MCP server
 * and the standalone stdio MCP server (CLI mode).
 *
 * Contains: prop validation/correction, CSS patching, port allocation, site ID sanitization.
 */

import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve, join, dirname } from "node:path"
import { getAllBlockMeta, defaultPropsForType, validateBlockProps, type BlockType } from "@ai-site-editor/shared"

// ── Utility helpers ──

export function sanitizeSiteId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "my-site"
}

export function monorepoRoot(): string {
  return resolve(dirname(new URL(import.meta.url).pathname), "../../../../")
}

export async function findAvailablePort(root: string): Promise<number> {
  const appsDir = join(root, "apps")
  const usedPorts = new Set<number>([3000, 4100, 4200])
  try {
    for (const dir of [appsDir, join(root, "examples")]) {
      if (!existsSync(dir)) continue
      const entries = await readdir(dir)
      for (const entry of entries) {
        const pkgPath = join(dir, entry, "package.json")
        if (!existsSync(pkgPath)) continue
        try {
          const pkg = JSON.parse(await readFile(pkgPath, "utf-8"))
          const devScript = pkg.scripts?.dev ?? ""
          const portMatches = devScript.matchAll(/(?:-p\s*|--port\s+)(\d+)/g)
          for (const m of portMatches) usedPorts.add(Number(m[1]))
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }

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

export async function patchGlobalsCssVars(cssPath: string, vars: Record<string, string>): Promise<void> {
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

const PROP_RENAME_RULES: Record<string, Record<string, string>> = {
  FAQAccordion: { question: "q", answer: "a" },
  FeatureGrid: { items: "features" },
  Stats: { items: "stats" },
  CardGrid: { items: "cards" },
  CTA: { heading: "title", buttonText: "ctaText", buttonHref: "ctaHref" },
  Testimonials: { testimonials: "items" },
  Footer: { heading: "title" },
}

function fixFooterLinks(props: Record<string, unknown>): Record<string, unknown> {
  const columns = props.columns
  if (!Array.isArray(columns)) return props
  return {
    ...props,
    columns: columns.map((col: unknown) => {
      if (!col || typeof col !== "object") return col
      const c = col as Record<string, unknown>
      const links = c.links
      if (typeof links === "string") return c
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

export function validateAndCorrectProps(
  blockType: string,
  props: Record<string, unknown>,
): { props: Record<string, unknown>; corrected: boolean; error?: string } {
  const first = validateBlockProps(blockType, props)
  if (first.success) return { props, corrected: false }

  let corrected = { ...props }
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

  const errorMsg = first.success === false && "error" in first
    ? (first.error as { issues?: Array<{ path: unknown[]; message: string }> }).issues?.map(
        (i: { path: unknown[]; message: string }) => `${i.path.join(".")}: ${i.message}`
      ).join("; ") ?? "validation failed"
    : "validation failed"
  return { props, corrected: false, error: errorMsg }
}

/**
 * Normalize and validate blocks for a page — applies prop correction, strips chrome blocks,
 * extracts footer. Shared between SDK and stdio bootstrap_pages implementations.
 */
export function normalizePageBlocks(
  blocks: Array<{ type: string; props: Record<string, unknown> }>,
): {
  contentBlocks: Array<{ id: string; type: string; props: Record<string, unknown> }>
  footerBlock: { type: string; props: Record<string, unknown> } | null
  strippedCount: number
} {
  let strippedCount = 0
  let footerBlock: { type: string; props: Record<string, unknown> } | null = null

  const contentBlocks = blocks
    .filter(b => {
      if (b.type === "SiteHeader") { strippedCount++; return false }
      if (b.type === "Footer") {
        if (!footerBlock) footerBlock = { type: b.type, props: b.props }
        strippedCount++
        return false
      }
      return true
    })
    .map((b, i) => {
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

  return { contentBlocks, footerBlock, strippedCount }
}

// ── Site scaffolding templates ──

export function packageJson(siteId: string, name: string, port: number): string {
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

export function nextConfigTs(): string {
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

export function tsconfigJson(): string {
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

export function postcssConfig(): string {
  return `export default {\n  plugins: {\n    "@tailwindcss/postcss": {}\n  }\n}\n`
}

export function layoutTsx(siteName: string): string {
  return `import "./globals.css"
import type { Metadata } from "next"
import type { ReactNode } from "react"

export const metadata: Metadata = {
  title: { default: ${JSON.stringify("__SITE_NAME__")}, template: \`%s · __SITE_NAME__\` },
  description: ${JSON.stringify("__SITE_NAME__")},
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
`.replaceAll("__SITE_NAME__", siteName)
}

export function globalsCss(): string {
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

/* Dark mode */
@media (prefers-color-scheme: dark) {
  :root:not(.light) {
    --bg-0: #0f172a; --bg-100: #1e293b; --bg-1: #0f172a; --section-bg: var(--bg-100);
    --text-100: #f1f5f9; --text-200: #cbd5e1; --heading: #f1f5f9; --body: #cbd5e1; --body-secondary: #94a3b8; --text-300: #94a3b8; --caption: #94a3b8;
    --brand: #3b82f6; --brand-hover: #60a5fa; --brand-subtle: #1e3a5f; --brand-fg: #ffffff;
    --surface: #1e293b; --surface-border: #334155; --border: #334155; --card-bg: #1e293b; --card-shadow: 0 1px 3px rgba(0,0,0,0.3); --hero-bg: var(--bg-0); --cta-bg: var(--bg-100); --placeholder-img: #334155;
    --footer-bg: #020617; --footer-text: #94a3b8; --footer-heading: #e2e8f0; --footer-link: #64748b; --footer-link-hover: #cbd5e1; --footer-border: #1e293b;
  }
}
.dark {
  --bg-0: #0f172a; --bg-100: #1e293b; --bg-1: #0f172a; --section-bg: var(--bg-100);
  --text-100: #f1f5f9; --text-200: #cbd5e1; --heading: #f1f5f9; --body: #cbd5e1; --body-secondary: #94a3b8; --text-300: #94a3b8; --caption: #94a3b8;
  --brand: #3b82f6; --brand-hover: #60a5fa; --brand-subtle: #1e3a5f; --brand-fg: #ffffff;
  --surface: #1e293b; --surface-border: #334155; --border: #334155; --card-bg: #1e293b; --card-shadow: 0 1px 3px rgba(0,0,0,0.3); --hero-bg: var(--bg-0); --cta-bg: var(--bg-100); --placeholder-img: #334155;
  --footer-bg: #020617; --footer-text: #94a3b8; --footer-heading: #e2e8f0; --footer-link: #64748b; --footer-link-hover: #cbd5e1; --footer-border: #1e293b;
}
`
}

export function defaultsTs(siteId: string, siteName: string): string {
  return `export const DEFAULT_SITE_ID = process.env.NEXT_PUBLIC_DEFAULT_SITE_ID?.trim() || ${JSON.stringify(siteId)}
export const DEFAULT_SESSION = process.env.DRAFT_DEFAULT_SESSION?.trim() || "dev"
export const DEFAULT_SITE_NAME = process.env.NEXT_PUBLIC_SITE_NAME?.trim() || ${JSON.stringify(siteName)}
`
}

export function editorApiRoute(): string {
  return `import { createEditorApiHandler } from "@ai-site-editor/site-sdk/routes"
import { createJsonFilePublishHandler } from "@ai-site-editor/site-sdk/publish-handlers/json-file"
import { resolve } from "node:path"
import { readFile } from "node:fs/promises"
import type { PageDoc } from "@ai-site-editor/shared"

import "../../../../blocks/register"

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

export function pageTsx(siteId: string): string {
  return `import { createSitePage } from "@ai-site-editor/site-sdk/page"
import { resolve } from "node:path"
import { readFile } from "node:fs/promises"
import { readFileSync, existsSync } from "node:fs"
import type { PageDoc } from "@ai-site-editor/shared"

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

export function blocksRegisterTs(): string {
  return `// Custom blocks — auto-updated by block-coder subagent
import { registerCustomRenderer } from "@ai-site-editor/blocks"
`
}

export function samplePagesJson(): string {
  return `[\n  {\n    "id": "home",\n    "slug": "/",\n    "title": "Home",\n    "blocks": [],\n    "updatedAt": "${new Date().toISOString()}"\n  }\n]\n`
}

export function defaultLogoSvg(siteName: string): string {
  const initials = siteInitials(siteName)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 38 38" width="38" height="38">
  <rect width="38" height="38" rx="8" fill="var(--brand, #2563eb)"/>
  <text x="19" y="20" text-anchor="middle" dominant-baseline="central" font-family="system-ui, sans-serif" font-weight="700" font-size="16" fill="var(--brand-fg, #fff)">${initials}</text>
</svg>`
}

export function faviconSvg(siteName: string): string {
  const initials = siteInitials(siteName)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="6" fill="#2563eb"/>
  <text x="16" y="17" text-anchor="middle" dominant-baseline="central" font-family="system-ui, sans-serif" font-weight="700" font-size="14" fill="#fff">${initials}</text>
</svg>`
}

function siteInitials(siteName: string): string {
  return siteName.split(/\s+/).map(w => w[0]?.toUpperCase() ?? "").join("").slice(0, 2) || "S"
}

/**
 * Scaffold a complete Next.js site project. Used by both SDK and CLI create_site tools.
 * Returns the site config and port. Does NOT start the dev server (caller handles that).
 */
export async function scaffoldSiteProject(options: {
  siteId: string
  name: string
  purpose?: string
  tone?: string
  port?: number
}): Promise<{ siteId: string; port: number; projectDir: string }> {
  const { siteId, name, purpose, tone } = options
  const root = monorepoRoot()
  const projectDir = join(root, "apps", siteId)

  if (existsSync(projectDir)) {
    throw new Error(`Directory apps/${siteId} already exists`)
  }

  const port = options.port || await findAvailablePort(root)

  await mkdir(projectDir, { recursive: true })
  await writeFile(join(projectDir, "package.json"), packageJson(siteId, name, port), "utf-8")
  await writeFile(join(projectDir, "next.config.ts"), nextConfigTs(), "utf-8")
  await writeFile(join(projectDir, "tsconfig.json"), tsconfigJson(), "utf-8")
  await writeFile(join(projectDir, "postcss.config.mjs"), postcssConfig(), "utf-8")
  await mkdir(join(projectDir, "app"), { recursive: true })
  await writeFile(join(projectDir, "app/layout.tsx"), layoutTsx(name), "utf-8")
  await writeFile(join(projectDir, "app/globals.css"), globalsCss(), "utf-8")
  await mkdir(join(projectDir, "app/api/editor/[...path]"), { recursive: true })
  await writeFile(join(projectDir, "app/api/editor/[...path]/route.ts"), editorApiRoute(), "utf-8")
  await mkdir(join(projectDir, "app/[[...slug]]"), { recursive: true })
  await writeFile(join(projectDir, "app/[[...slug]]/page.tsx"), pageTsx(siteId), "utf-8")
  await mkdir(join(projectDir, "content"), { recursive: true })
  await writeFile(join(projectDir, "content/pages.json"), samplePagesJson(), "utf-8")
  await mkdir(join(projectDir, "lib"), { recursive: true })
  await writeFile(join(projectDir, "lib/defaults.ts"), defaultsTs(siteId, name), "utf-8")
  await mkdir(join(projectDir, "public"), { recursive: true })
  await writeFile(join(projectDir, "public/.gitkeep"), "", "utf-8")
  await mkdir(join(projectDir, "blocks"), { recursive: true })
  await writeFile(join(projectDir, "blocks/register.ts"), blocksRegisterTs(), "utf-8")
  await writeFile(join(projectDir, "public/logo.svg"), defaultLogoSvg(name), "utf-8")
  await writeFile(join(projectDir, "public/favicon.svg"), faviconSvg(name), "utf-8")

  const envContent = `ORCHESTRATOR_URL=http://localhost:4200\nDRAFT_MODE_SECRET=top-secret\nNEXT_PUBLIC_DEFAULT_SITE_ID=${siteId}\nNEXT_PUBLIC_SITE_NAME=${name}\nNEXT_PUBLIC_EDITOR_ORIGIN=http://localhost:4100\n`
  await writeFile(join(projectDir, ".env.local"), envContent, "utf-8")

  // Run pnpm install
  if (!existsSync(join(projectDir, "node_modules"))) {
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    await promisify(execFile)("pnpm", ["install", "--no-frozen-lockfile"], { cwd: root, timeout: 60_000 })
  }

  return { siteId, port, projectDir }
}

// ── Codebase analysis ──

export type CodebaseAnalysis = {
  framework: "nextjs-app-router" | "nextjs-pages-router" | "other"
  nextVersion: string | null
  packageManager: "pnpm" | "npm" | "yarn"
  hasTypeScript: boolean
  hasTailwind: boolean
  stylingApproach: string
  existingRoutes: string[]
  existingCms: string | null
  hasEditorIntegration: boolean
  layoutPath: string | null
  globalCssPath: string | null
  isMonorepoChild: boolean
  dependencies: Record<string, string>
}

/**
 * Analyze an existing site project to determine its structure, framework,
 * CMS, and what's needed to integrate with the AI Site Editor.
 */
export async function analyzeCodebase(projectPath: string): Promise<CodebaseAnalysis> {
  const result: CodebaseAnalysis = {
    framework: "other",
    nextVersion: null,
    packageManager: "npm",
    hasTypeScript: false,
    hasTailwind: false,
    stylingApproach: "css",
    existingRoutes: [],
    existingCms: null,
    hasEditorIntegration: false,
    layoutPath: null,
    globalCssPath: null,
    isMonorepoChild: false,
    dependencies: {},
  }

  // Read package.json
  const pkgPath = join(projectPath, "package.json")
  let pkg: Record<string, unknown> = {}
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf-8"))
  } catch {
    return result // not a valid project
  }

  const allDeps: Record<string, string> = {
    ...(pkg.dependencies as Record<string, string> ?? {}),
    ...(pkg.devDependencies as Record<string, string> ?? {}),
  }
  result.dependencies = allDeps

  // Detect Next.js version
  if (allDeps.next) {
    result.nextVersion = allDeps.next
    // Detect app router vs pages router
    if (existsSync(join(projectPath, "app"))) {
      result.framework = "nextjs-app-router"
    } else if (existsSync(join(projectPath, "pages")) || existsSync(join(projectPath, "src/pages"))) {
      result.framework = "nextjs-pages-router"
    } else {
      result.framework = "nextjs-app-router" // assume app router for new Next.js
    }
  }

  // Package manager detection
  if (existsSync(join(projectPath, "pnpm-lock.yaml"))) result.packageManager = "pnpm"
  else if (existsSync(join(projectPath, "yarn.lock"))) result.packageManager = "yarn"
  else result.packageManager = "npm"

  // Check if inside monorepo
  const parentPkgPath = resolve(projectPath, "../../package.json")
  try {
    const parentPkg = JSON.parse(await readFile(parentPkgPath, "utf-8"))
    if (parentPkg.workspaces || existsSync(resolve(projectPath, "../../pnpm-workspace.yaml"))) {
      result.isMonorepoChild = true
    }
  } catch { /* standalone project */ }

  // TypeScript
  result.hasTypeScript = existsSync(join(projectPath, "tsconfig.json"))

  // Styling
  if (allDeps.tailwindcss || existsSync(join(projectPath, "tailwind.config.js")) || existsSync(join(projectPath, "tailwind.config.ts"))) {
    result.hasTailwind = true
    result.stylingApproach = "tailwind"
  } else if (allDeps["styled-components"]) {
    result.stylingApproach = "styled-components"
  } else if (allDeps["@emotion/react"] || allDeps["@emotion/styled"]) {
    result.stylingApproach = "emotion"
  }

  // CMS detection
  if (allDeps.contentful || allDeps["@contentful/rich-text-react-renderer"]) result.existingCms = "contentful"
  else if (allDeps["@sanity/client"] || allDeps["next-sanity"]) result.existingCms = "sanity"
  else if (allDeps.strapi || allDeps["@strapi/strapi"]) result.existingCms = "strapi"
  else if (allDeps["@wordpress/api-fetch"] || allDeps.wpapi) result.existingCms = "wordpress"
  else if (allDeps["@prismic/client"] || allDeps["@prismicio/react"]) result.existingCms = "prismic"

  // Editor integration already present?
  result.hasEditorIntegration = !!allDeps["@ai-site-editor/site-sdk"]

  // Find layout and CSS files
  for (const candidate of ["app/layout.tsx", "app/layout.jsx", "app/layout.js", "src/app/layout.tsx"]) {
    if (existsSync(join(projectPath, candidate))) {
      result.layoutPath = candidate
      break
    }
  }
  for (const candidate of ["app/globals.css", "app/global.css", "styles/globals.css", "src/app/globals.css"]) {
    if (existsSync(join(projectPath, candidate))) {
      result.globalCssPath = candidate
      break
    }
  }

  // Discover existing routes (app router)
  if (result.framework === "nextjs-app-router") {
    const appDir = existsSync(join(projectPath, "src/app")) ? join(projectPath, "src/app") : join(projectPath, "app")
    result.existingRoutes = await discoverAppRoutes(appDir, appDir)
  }

  return result
}

/** Recursively discover routes in a Next.js app directory. */
async function discoverAppRoutes(baseDir: string, dir: string): Promise<string[]> {
  const routes: string[] = []
  try {
    const entries = await readdir(dir)
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules" || entry === "api") continue
      const entryPath = join(dir, entry)
      const s = await stat(entryPath).catch(() => null)
      if (!s?.isDirectory()) {
        // Check if this is a page file
        if (/^page\.(tsx?|jsx?)$/.test(entry)) {
          const rel = dir.slice(baseDir.length) || "/"
          const slug = rel
            .replace(/\\/g, "/")
            .replace(/\/\([^)]+\)/g, "") // strip route groups like (marketing)
          routes.push(slug || "/")
        }
        continue
      }
      routes.push(...await discoverAppRoutes(baseDir, entryPath))
    }
  } catch { /* dir doesn't exist */ }
  return routes
}

// ── Clone repo ──

export type CloneResult = {
  status: "cloned" | "updated" | "exists"
  localPath: string
  branch: string
  commitCount?: number
  repoName: string
  message?: string
}

/**
 * Clone a GitHub repo into apps/{dirName}, or pull if it already exists.
 */
export async function cloneRepo(url: string, targetDir?: string): Promise<CloneResult> {
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const exec = promisify(execFile)

  const repoName = url.replace(/\.git$/, "").split("/").pop() ?? "cloned-site"
  const dirName = targetDir ?? repoName
  const root = monorepoRoot()
  const localPath = join(root, "apps", dirName)

  if (existsSync(localPath)) {
    try {
      const { stdout } = await exec("git", ["pull", "--ff-only"], { cwd: localPath, timeout: 30_000 })
      const branch = (await exec("git", ["branch", "--show-current"], { cwd: localPath })).stdout.trim()
      return { status: "updated", localPath, branch, repoName: dirName, message: stdout.trim() }
    } catch {
      return { status: "exists", localPath, branch: "unknown", repoName: dirName, message: "Directory exists, pull failed — using as-is" }
    }
  }

  // Try gh CLI first (handles auth for private repos), then git clone
  let cloneError: string | null = null
  try {
    await exec("gh", ["repo", "clone", url, localPath], { timeout: 120_000 })
  } catch {
    try {
      await exec("git", ["clone", "--depth", "1", url, localPath], { timeout: 120_000 })
    } catch (gitErr) {
      cloneError = gitErr instanceof Error ? gitErr.message : String(gitErr)
    }
  }

  if (cloneError) throw new Error(`Failed to clone: ${cloneError}`)

  const branch = (await exec("git", ["branch", "--show-current"], { cwd: localPath }).catch(() => ({ stdout: "unknown" }))).stdout.trim()
  const commitCount = Number((await exec("git", ["rev-list", "--count", "HEAD"], { cwd: localPath }).catch(() => ({ stdout: "0" }))).stdout.trim())

  return { status: "cloned", localPath, branch, commitCount, repoName: dirName }
}

// ── Site registration helpers ──

/**
 * Detect the dev server port from an existing site's package.json.
 */
export async function detectSitePort(projectDir: string): Promise<number> {
  try {
    const pkg = JSON.parse(await readFile(join(projectDir, "package.json"), "utf-8"))
    const portMatch = pkg.scripts?.dev?.match(/-p\s*(\d+)/)
    if (portMatch) return Number(portMatch[1])
  } catch { /* no package.json */ }
  // Allocate a new port
  return findAvailablePort(monorepoRoot())
}
