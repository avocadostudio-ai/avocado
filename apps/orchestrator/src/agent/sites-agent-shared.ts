/**
 * Shared utilities for site-agent tools — used by both the Agent SDK MCP server
 * and the standalone stdio MCP server (CLI mode).
 *
 * Contains: prop validation/correction, CSS patching, port allocation, site ID sanitization.
 */

import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve, join, dirname } from "node:path"
import { getAllBlockMeta, defaultPropsForType, validateBlockProps, type BlockType } from "@avocadostudio-ai/shared"

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

/**
 * Resolve the DRAFT_MODE_SECRET to write into a scaffolded site's `.env.local`.
 * Reads from the orchestrator's own environment so the scaffolded site lines up
 * with the editor's build-time `VITE_SITE_DRAFT_SECRET`. Falls back to a known
 * dev placeholder if the orchestrator wasn't started with one — that placeholder
 * is intentionally weak so production deployments fail closed if env config is
 * forgotten.
 */
export function getDraftModeSecret(): string {
  return process.env.DRAFT_MODE_SECRET ?? "top-secret"
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

// ── Theme presets ──

export interface ThemePreset {
  name: string
  description: string
  googleFontsUrl?: string
  overrides: Record<string, string>
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    name: "ocean",
    description: "Clean and professional — tech, SaaS, corporate. Cool blue tones with crisp white.",
    googleFontsUrl: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap",
    overrides: {
      "--bg-0": "#ffffff", "--bg-100": "#f0f4f8", "--section-bg": "#f0f4f8",
      "--heading": "#0f172a", "--body": "#334155", "--body-secondary": "#64748b", "--caption": "#94a3b8",
      "--brand": "#2563eb", "--brand-hover": "#1d4ed8", "--brand-subtle": "#dbeafe", "--brand-fg": "#ffffff",
      "--surface": "#ffffff", "--border": "#e2e8f0", "--card-bg": "#f8fafc", "--card-shadow": "0 1px 3px rgba(0,0,0,0.08)",
      "--footer-bg": "#0f172a", "--footer-text": "#94a3b8", "--footer-heading": "#f1f5f9", "--footer-link": "#64748b", "--footer-link-hover": "#e2e8f0", "--footer-border": "#1e293b",
      "--font-heading": "'Inter', sans-serif", "--font-body": "'Inter', sans-serif",
      "--radius-btn": "8px", "--radius-card": "12px", "--radius-feature": "12px",
    },
  },
  {
    name: "forest",
    description: "Warm and grounded — nature, wellness, eco, organic. Earthy greens with warm neutrals.",
    googleFontsUrl: "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap",
    overrides: {
      "--bg-0": "#fafaf8", "--bg-100": "#f2f0eb", "--section-bg": "#f2f0eb",
      "--heading": "#1a2e1a", "--body": "#3d4a3d", "--body-secondary": "#6b7b6b", "--caption": "#8a9a8a",
      "--brand": "#16a34a", "--brand-hover": "#15803d", "--brand-subtle": "#dcfce7", "--brand-fg": "#ffffff",
      "--surface": "#ffffff", "--border": "#d4d8cd", "--card-bg": "#f7f7f3", "--card-shadow": "0 1px 3px rgba(0,0,0,0.06)",
      "--footer-bg": "#1a2e1a", "--footer-text": "#a3b8a3", "--footer-heading": "#e8f0e8", "--footer-link": "#7a9a7a", "--footer-link-hover": "#d4e8d4", "--footer-border": "#2d4a2d",
      "--font-heading": "'DM Sans', sans-serif", "--font-body": "'DM Sans', sans-serif",
      "--radius-btn": "8px", "--radius-card": "10px", "--radius-feature": "10px",
    },
  },
  {
    name: "luxury",
    description: "Refined and elegant — real estate, hospitality, high-end brands. Warm gold on cream with serif headings.",
    googleFontsUrl: "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=Jost:wght@300;400;500;600&display=swap",
    overrides: {
      "--bg-0": "#faf8f5", "--bg-100": "#f2ede6", "--section-bg": "#f2ede6",
      "--heading": "#2c1810", "--body": "#4a3728", "--body-secondary": "#7a6a5a", "--caption": "#9a8a7a",
      "--brand": "#b8860b", "--brand-hover": "#9a7209", "--brand-subtle": "#fdf3e0", "--brand-fg": "#ffffff",
      "--surface": "#ffffff", "--border": "#e8ddd0", "--card-bg": "#faf7f2", "--card-shadow": "0 2px 8px rgba(44,24,16,0.06)",
      "--footer-bg": "#2c1810", "--footer-text": "#b8a898", "--footer-heading": "#f0e8e0", "--footer-link": "#9a8a7a", "--footer-link-hover": "#e0d0c0", "--footer-border": "#4a3728",
      "--font-heading": "'Cormorant Garamond', serif", "--font-body": "'Jost', sans-serif",
      "--radius-btn": "4px", "--radius-card": "6px", "--radius-feature": "6px",
    },
  },
  {
    name: "coral",
    description: "Vibrant and warm — creative agencies, food, lifestyle, events. Energetic coral with clean whites.",
    googleFontsUrl: "https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap",
    overrides: {
      "--bg-0": "#ffffff", "--bg-100": "#fef7f4", "--section-bg": "#fef7f4",
      "--heading": "#1a1a1a", "--body": "#3a3a3a", "--body-secondary": "#6b6b6b", "--caption": "#8a8a8a",
      "--brand": "#e76f51", "--brand-hover": "#d4603f", "--brand-subtle": "#fde8e0", "--brand-fg": "#ffffff",
      "--surface": "#ffffff", "--border": "#f0e0d8", "--card-bg": "#fefaf8", "--card-shadow": "0 1px 4px rgba(0,0,0,0.06)",
      "--footer-bg": "#1a1a1a", "--footer-text": "#b0b0b0", "--footer-heading": "#f0f0f0", "--footer-link": "#8a8a8a", "--footer-link-hover": "#e0e0e0", "--footer-border": "#333333",
      "--font-heading": "'Outfit', sans-serif", "--font-body": "'Outfit', sans-serif",
      "--radius-btn": "10px", "--radius-card": "14px", "--radius-feature": "14px",
    },
  },
  {
    name: "midnight",
    description: "Dark and premium — fintech, gaming, developer tools, SaaS dashboards. Deep navy with muted blue accents.",
    googleFontsUrl: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap",
    overrides: {
      "--bg-0": "#0f172a", "--bg-100": "#1e293b", "--section-bg": "#1e293b",
      "--heading": "#f1f5f9", "--body": "#cbd5e1", "--body-secondary": "#94a3b8", "--caption": "#64748b",
      "--brand": "#38bdf8", "--brand-hover": "#7dd3fc", "--brand-subtle": "#0c4a6e", "--brand-fg": "#0f172a",
      "--surface": "#1e293b", "--border": "#334155", "--card-bg": "#1e293b", "--card-shadow": "0 1px 4px rgba(0,0,0,0.3)",
      "--footer-bg": "#020617", "--footer-text": "#64748b", "--footer-heading": "#e2e8f0", "--footer-link": "#475569", "--footer-link-hover": "#94a3b8", "--footer-border": "#1e293b",
      "--font-heading": "'Space Grotesk', sans-serif", "--font-body": "'Space Grotesk', sans-serif",
      "--radius-btn": "8px", "--radius-card": "12px", "--radius-feature": "12px",
    },
  },
  {
    name: "rose",
    description: "Soft and feminine — beauty, health, fashion, wellness. Rose accents on blush backgrounds with elegant serif headings.",
    googleFontsUrl: "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600;700&family=Lato:wght@300;400;700&display=swap",
    overrides: {
      "--bg-0": "#fffbfc", "--bg-100": "#fdf2f4", "--section-bg": "#fdf2f4",
      "--heading": "#1a1a2e", "--body": "#3a3a4a", "--body-secondary": "#6b6b7b", "--caption": "#8a8a9a",
      "--brand": "#e11d48", "--brand-hover": "#be123c", "--brand-subtle": "#ffe4e6", "--brand-fg": "#ffffff",
      "--surface": "#ffffff", "--border": "#f0d4da", "--card-bg": "#fef8f9", "--card-shadow": "0 1px 4px rgba(225,29,72,0.06)",
      "--footer-bg": "#1a1a2e", "--footer-text": "#b0a0b0", "--footer-heading": "#f0e8f0", "--footer-link": "#8a7a8a", "--footer-link-hover": "#e0d0e0", "--footer-border": "#2d2d4a",
      "--font-heading": "'Playfair Display', serif", "--font-body": "'Lato', sans-serif",
      "--radius-btn": "6px", "--radius-card": "10px", "--radius-feature": "10px",
    },
  },
  {
    name: "slate",
    description: "Minimal and editorial — portfolios, magazines, studios, photography. Monochrome with strong typography.",
    googleFontsUrl: "https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@400;700&family=Source+Sans+3:wght@400;500;600;700&display=swap",
    overrides: {
      "--bg-0": "#ffffff", "--bg-100": "#f5f5f5", "--section-bg": "#f5f5f5",
      "--heading": "#111111", "--body": "#333333", "--body-secondary": "#666666", "--caption": "#999999",
      "--brand": "#111111", "--brand-hover": "#333333", "--brand-subtle": "#f0f0f0", "--brand-fg": "#ffffff",
      "--surface": "#ffffff", "--border": "#e0e0e0", "--card-bg": "#fafafa", "--card-shadow": "0 1px 2px rgba(0,0,0,0.05)",
      "--footer-bg": "#111111", "--footer-text": "#999999", "--footer-heading": "#f0f0f0", "--footer-link": "#777777", "--footer-link-hover": "#cccccc", "--footer-border": "#333333",
      "--font-heading": "'Libre Baskerville', serif", "--font-body": "'Source Sans 3', sans-serif",
      "--radius-btn": "2px", "--radius-card": "4px", "--radius-feature": "4px",
    },
  },
  {
    name: "sunset",
    description: "Bold and energetic — startups, sports, fitness, youth brands. Vibrant orange with punchy sans-serif.",
    googleFontsUrl: "https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800;900&display=swap",
    overrides: {
      "--bg-0": "#ffffff", "--bg-100": "#fff8f3", "--section-bg": "#fff8f3",
      "--heading": "#1a1a1a", "--body": "#333333", "--body-secondary": "#666666", "--caption": "#888888",
      "--brand": "#ea580c", "--brand-hover": "#c2410c", "--brand-subtle": "#ffedd5", "--brand-fg": "#ffffff",
      "--surface": "#ffffff", "--border": "#f0ddd0", "--card-bg": "#fffbf7", "--card-shadow": "0 1px 4px rgba(234,88,12,0.08)",
      "--footer-bg": "#1a1a1a", "--footer-text": "#aaaaaa", "--footer-heading": "#f0f0f0", "--footer-link": "#888888", "--footer-link-hover": "#dddddd", "--footer-border": "#333333",
      "--font-heading": "'Montserrat', sans-serif", "--font-body": "'Montserrat', sans-serif",
      "--radius-btn": "8px", "--radius-card": "12px", "--radius-feature": "12px",
    },
  },
]

/**
 * Format theme presets as a catalog for the system prompt.
 * Shows name, description, and the full CSS variable overrides so the LLM
 * can copy them into themeOverrides.
 */
export function buildThemePresetsCatalog(): string {
  const lines: string[] = ["### Theme Presets\nPick the preset that best matches the site's purpose and tone. Pass its `overrides` as `themeOverrides` in `bootstrap_pages`. You may tweak individual values (e.g. swap brand color) while keeping the rest of the palette.\n"]
  for (const preset of THEME_PRESETS) {
    const overridesJson = JSON.stringify(preset.overrides, null, 2)
    lines.push(`#### ${preset.name}\n${preset.description}\n\`\`\`json\n${overridesJson}\n\`\`\``)
    if (preset.googleFontsUrl) {
      lines.push(`Google Fonts: \`${preset.googleFontsUrl}\`\n`)
    }
  }
  lines.push(`\n**Custom tweaks are encouraged.** If the user says "nature site but teal", start from \`forest\` and swap \`--brand\` to teal. Always keep hover/subtle/fg consistent with the brand hue.`)
  return lines.join("\n")
}

// ── Sites agent model tiers ──

/** Model tiers for the sites agent pipeline. */
export const SITES_AGENT_MODELS = {
  /** Haiku — triage, intent detection, simple Q&A ($0.001/call).
   *  Full model ID for direct Anthropic API calls (not Agent SDK). */
  fast: process.env.SITES_AGENT_MODEL_FAST ?? "claude-haiku-4-5-20251001",
  /** Sonnet — main agent, subagents, standard migrations.
   *  Agent SDK enum value (SDK resolves to latest Sonnet). */
  balanced: "sonnet" as const,
  /** Opus — complex migrations, multi-page sites, custom block design.
   *  Agent SDK enum value (SDK resolves to latest Opus). */
  powerful: "opus" as const,
}

export type TriageResult = {
  intent: "create" | "migrate" | "integrate" | "question"
  url?: string
  siteName?: string
  scope?: string
  answer?: string
}

/**
 * Fast triage using Haiku — classifies intent, extracts params, answers simple questions.
 * ~200ms, ~$0.001 per call.
 */
export async function triageWithHaiku(message: string, apiKey: string): Promise<TriageResult> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk")
  const client = new Anthropic({ apiKey })

  const response = await client.messages.create({
    model: SITES_AGENT_MODELS.fast,
    max_tokens: 256,
    messages: [{ role: "user", content: message }],
    system: `You are a triage router for a site creation agent. Classify the user's message and extract parameters.

Reply with ONLY a JSON object (no markdown, no explanation):
{
  "intent": "create" | "migrate" | "integrate" | "question",
  "url": "extracted URL if any",
  "siteName": "extracted site name if any",
  "scope": "e.g. 'homepage only', 'all pages', specific pages",
  "answer": "direct answer if intent is 'question'"
}

Intent definitions:
- "create": user wants to build a new site from scratch
- "migrate": user wants to recreate/copy an existing website from a URL
- "integrate": user wants to add the editor SDK to an existing Next.js project (mentions GitHub, repo, existing project, codebase)
- "question": user is asking a question about capabilities, block types, how things work — answer it directly in "answer" field

Available block types: Hero, FeatureGrid, CardGrid, CTA, FAQAccordion, Stats, RichText, Testimonials, TwoColumn, Table, Gallery, Quote, Banner, Tabs, Carousel, Video, Embed, Card. Custom blocks can also be created during migration.

If intent is "migrate" but no URL is provided, or "integrate" but no repo/project is mentioned, set intent to "question" and ask for the missing info in "answer".

Keep your "answer" short and well-formatted using markdown:
- Use **bold** for emphasis
- Use bullet points or numbered lists (not inline "1) ... 2) ...")
- Max 2-3 sentences
- Be specific about what you need (e.g. "Please share the URL of the website you'd like to migrate.")
- Do NOT be overly enthusiastic or verbose

Extract URLs, site names, and scope constraints from the message. If not present, omit the field.`,
  })

  const text = response.content[0]?.type === "text" ? response.content[0].text : "{}"
  try {
    // Strip markdown code fences if present
    const clean = text.replace(/^```json?\s*|\s*```$/g, "").trim()
    const parsed = JSON.parse(clean) as TriageResult
    console.log(`[sites-agent] Triage: intent=${parsed.intent} url=${parsed.url ?? "-"} site=${parsed.siteName ?? "-"} scope=${parsed.scope ?? "-"}`)
    return parsed
  } catch {
    console.log(`[sites-agent] Triage parse failed, defaulting to migrate: ${text.slice(0, 100)}`)
    return { intent: "migrate" }
  }
}

// ── CSS variable persistence ──

export async function patchGlobalsCssVars(cssPath: string, vars: Record<string, string>): Promise<void> {
  if (!existsSync(cssPath)) return
  let css = await readFile(cssPath, "utf-8")

  // Remove generic dark-mode and .dark overrides — migrated sites have a single
  // authoritative palette extracted from the source; the template defaults would
  // stomp on it for users with prefers-color-scheme: dark.
  css = css.replace(/\/\*\s*Dark mode\s*\*\/\s*\n@media\s*\(prefers-color-scheme:\s*dark\)\s*\{[^}]*\{[^}]*\}\s*\}/g, "")
  css = css.replace(/\.dark\s*\{[^}]*\}/g, "")
  css = css.replace(/\n{3,}/g, "\n\n") // collapse leftover blank lines

  // Handle Google Fonts import — inject @import url(...) after @import "tailwindcss"
  const googleFontsUrl = vars["--google-fonts-import"]
  if (googleFontsUrl) {
    // Remove existing Google Fonts imports to avoid duplicates
    css = css.replace(/@import\s+url\(["']https:\/\/fonts\.googleapis\.com[^)]*\);\s*\n?/g, "")
    // Insert after the last @import line
    const lastImportIdx = css.lastIndexOf("@import")
    if (lastImportIdx >= 0) {
      const lineEnd = css.indexOf("\n", lastImportIdx)
      css = css.slice(0, lineEnd + 1) + `@import url("${googleFontsUrl}");\n` + css.slice(lineEnd + 1)
    } else {
      css = `@import url("${googleFontsUrl}");\n` + css
    }
  }

  for (const [prop, value] of Object.entries(vars)) {
    if (prop === "--google-fonts-import") continue // handled above
    const escaped = prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const varRegex = new RegExp(`(${escaped}):\\s*[^;]+;`, "g")
    if (varRegex.test(css)) {
      css = css.replace(new RegExp(`(${escaped}):\\s*[^;]+;`, "g"), `$1: ${value};`)
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

export function fixFooterLinks(props: Record<string, unknown>): Record<string, unknown> {
  // Case 1: flat "links" string without columns — wrap into a single column
  if (typeof props.links === "string" && !Array.isArray(props.columns)) {
    const { links, tagline, ...rest } = props
    return { ...rest, columns: [{ title: typeof tagline === "string" ? tagline : "Links", links }] }
  }
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
        if (!footerBlock) {
          let fp = fixFooterLinks(b.props)
          const v = validateAndCorrectProps(b.type, fp)
          if (v.corrected) fp = v.props
          footerBlock = { type: b.type, props: fp }
        }
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
      "@avocadostudio-ai/blocks": "workspace:*", "@avocadostudio-ai/shared": "workspace:*", "@ai-site-editor/site-sdk": "workspace:*",
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
    "@avocadostudio-ai/blocks",
    "@avocadostudio-ai/shared",
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
      config.watchOptions = { ...config.watchOptions, followSymlinks: true, poll: 1000 }
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
@import "@avocadostudio-ai/blocks/styles.css";

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
import type { PageDoc } from "@avocadostudio-ai/shared"

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

export function pageTsx(siteId: string, options?: { chrome?: boolean }): string {
  const chromeOpt = options?.chrome === false ? "\n  chrome: false," : ""
  return `import { createSitePage } from "@ai-site-editor/site-sdk/page"
import { resolve } from "node:path"
import { readFile } from "node:fs/promises"
import { readFileSync, existsSync } from "node:fs"
import type { PageDoc } from "@avocadostudio-ai/shared"

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
  footer: _siteConfig.footer ?? undefined,${chromeOpt}
})

export default Page
export { generateStaticParams }
`
}

export function hybridPageTsx(siteId: string): string {
  return `import { resolve } from "node:path"
import { readFile } from "node:fs/promises"
import type { Metadata } from "next"
import type { PageDoc } from "@avocadostudio-ai/shared"

import EditorPage, { generateStaticParams as editorStaticParams } from "./_editor-page"
import OriginalPage from "./_original-page"

// Re-export original generateStaticParams if available, or provide fallback
const origStaticParams = (OriginalPage as unknown as { generateStaticParams?: () => Promise<Array<{ slug?: string[] }>> }).generateStaticParams

const PAGES_PATH = resolve(process.cwd(), "content/pages.json")

let _editorSlugsPromise: Promise<Set<string>> | null = null
function loadEditorSlugs(): Promise<Set<string>> {
  if (!_editorSlugsPromise) {
    _editorSlugsPromise = (async () => {
      try {
        const raw = await readFile(PAGES_PATH, "utf-8")
        const pages = JSON.parse(raw) as PageDoc[]
        return new Set(pages.map((p) => p.slug))
      } catch { return new Set() }
    })()
  }
  return _editorSlugsPromise
}

function buildSlug(parts?: string[]): string {
  if (!parts || parts.length === 0) return "/"
  return "/" + parts.join("/")
}

async function isEditorManaged(slug: string): Promise<boolean> {
  // Check if this slug exists in editor content (pages.json)
  const editorSlugs = await loadEditorSlugs()
  if (editorSlugs.has(slug)) return true

  // In dev mode, also check orchestrator for draft pages
  if (process.env.NODE_ENV !== "production") {
    const orchestratorUrl = process.env.ORCHESTRATOR_URL ?? "http://localhost:4200"
    const siteId = process.env.NEXT_PUBLIC_DEFAULT_SITE_ID ?? ${JSON.stringify(siteId)}
    try {
      const res = await fetch(
        orchestratorUrl + "/draft/pages?session=" + encodeURIComponent(siteId + "::dev") + "&siteId=" + encodeURIComponent(siteId) + "&slug=" + encodeURIComponent(slug),
        { cache: "no-store", signal: AbortSignal.timeout(1000) }
      )
      if (res.ok) return true
    } catch { /* orchestrator not running or slug not found */ }
  }
  return false
}

type PageProps = { params: Promise<{ slug?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> }

export default async function HybridPage(props: PageProps) {
  const slug = buildSlug((await props.params).slug)
  const sp = await props.searchParams

  // When accessed from editor iframe, always use editor rendering
  // so blocks are selectable and editable. The editor passes these
  // params via the draft enable URL / postMessage bridge.
  const isEditorAccess = sp.__editor === "1" || !!sp.editorOrigin || !!sp.session
  if (isEditorAccess || await isEditorManaged(slug)) {
    return <EditorPage {...props} />
  }

  // Standalone/production: use original site rendering
  return <OriginalPage {...props} />
}

export async function generateStaticParams() {
  const editorParams = editorStaticParams ? await editorStaticParams() : []
  const originalParams = origStaticParams ? await origStaticParams() : []
  // Merge, deduplicating by slug
  const seen = new Set<string>()
  const merged = []
  for (const p of [...editorParams, ...originalParams]) {
    const key = (p.slug ?? []).join("/")
    if (!seen.has(key)) { seen.add(key); merged.push(p) }
  }
  return merged
}

export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const slug = buildSlug((await props.params).slug)
  if (await isEditorManaged(slug)) {
    // Editor pages get metadata from createSitePage
    const editorMeta = (EditorPage as unknown as { generateMetadata?: (props: PageProps) => Promise<Metadata> }).generateMetadata
    if (editorMeta) return editorMeta(props)
  }
  // Fall through to original page metadata
  const origMeta = (OriginalPage as unknown as { generateMetadata?: (props: PageProps) => Promise<Metadata> }).generateMetadata
  if (origMeta) return origMeta(props)
  return {}
}
`
}

export function blocksRegisterTsx(): string {
  return `// Custom block renderers — register site-specific components here.
// Use JSX syntax for adapters: <Comp block={...} /> (NOT function calls).
import { registerCustomRenderer } from "@avocadostudio-ai/blocks"
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
  await writeFile(join(projectDir, "blocks/register.tsx"), blocksRegisterTsx(), "utf-8")
  await writeFile(join(projectDir, "public/logo.svg"), defaultLogoSvg(name), "utf-8")
  await writeFile(join(projectDir, "public/favicon.svg"), faviconSvg(name), "utf-8")

  const envContent = `ORCHESTRATOR_URL=http://localhost:4200\nDRAFT_MODE_SECRET=${getDraftModeSecret()}\nNEXT_PUBLIC_DEFAULT_SITE_ID=${siteId}\nNEXT_PUBLIC_SITE_NAME=${name}\nNEXT_PUBLIC_EDITOR_ORIGIN=http://localhost:4100\n`
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

/**
 * Start a Next.js dev server and wait for it to report "Ready" (or timeout).
 * Replaces fire-and-forget spawn patterns that reported success before the server was up.
 */
export async function startAndWaitForDevServer(opts: {
  siteId: string
  port: number
  cwd: string
  useFilter?: boolean
  timeoutMs?: number
}): Promise<{ serverReady: boolean }> {
  const { spawn } = await import("node:child_process")
  const args = opts.useFilter
    ? ["--filter", `@ai-site-editor/${opts.siteId}`, "dev"]
    : ["dev"]

  // Kill any existing process on the port first
  try {
    const { execSync } = await import("node:child_process")
    const pids = execSync(`lsof -ti:${opts.port} 2>/dev/null`, { encoding: "utf-8" }).trim()
    if (pids) {
      for (const pid of pids.split("\n")) {
        try { process.kill(Number(pid), "SIGKILL") } catch { /* already dead */ }
      }
      console.log(`[sites-agent] Killed existing process(es) on port ${opts.port}`)
    }
  } catch { /* no process on port — fine */ }

  console.log(`[sites-agent] Starting dev server for ${opts.siteId} on port ${opts.port}...`)
  const devProcess = spawn("pnpm", args, {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: {
      ...process.env,
      // Reduce file-watcher FD usage: poll instead of native FSEvents.
      // Without this, each Next.js dev server opens thousands of FDs for
      // node_modules watchers, quickly hitting EMFILE when multiple sites run.
      WATCHPACK_POLLING: "true",
      WATCHPACK_POLLING_INTERVAL: "1000",
      CHOKIDAR_USEPOLLING: "true",
      CHOKIDAR_INTERVAL: "1000",
    },
  })
  devProcess.unref()

  let serverReady = false
  const timeoutMs = opts.timeoutMs ?? 60_000
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs)
    const onData = (chunk: Buffer) => {
      const text = chunk.toString()
      if (text.includes("Ready") || text.includes(`localhost:${opts.port}`)) {
        serverReady = true
        clearTimeout(timer)
        devProcess.stdout?.removeAllListeners()
        devProcess.stderr?.removeAllListeners()
        resolve()
      }
    }
    devProcess.stdout?.on("data", onData)
    devProcess.stderr?.on("data", onData)
    devProcess.on("exit", () => { clearTimeout(timer); resolve() })
  })
  console.log(`[sites-agent] Dev server ${serverReady ? "ready" : "timed out"} for ${opts.siteId} at http://localhost:${opts.port}`)
  return { serverReady }
}
