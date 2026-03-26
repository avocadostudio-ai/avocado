/**
 * Build the system prompt for the agent from .md context files and runtime state.
 */

import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { getPage, getSessionDraft, orderSlugsHomeFirst } from "../state/session-state.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

function readContextFile(name: string): string {
  try {
    return readFileSync(resolve(__dirname, "context", name), "utf-8").trim()
  } catch {
    return ""
  }
}

const roleContext = readContextFile("role.md")
const editingGuidelines = readContextFile("editing-guidelines.md")

/**
 * Build the full system prompt for an agent session.
 */
export function buildAgentSystemPrompt(options?: {
  locale?: string
  sitePurpose?: string
}): string {
  const parts: string[] = [roleContext, editingGuidelines]

  if (options?.sitePurpose) {
    parts.push(`## Site Purpose\nThis website is: ${options.sitePurpose}`)
  }

  if (options?.locale && options.locale !== "en") {
    parts.push(`## Language\nRespond to the user in ${options.locale}. Tool inputs (block props, field names) stay in English. Only user-facing summaries and explanations should be in ${options.locale}.`)
  }

  return parts.filter(Boolean).join("\n\n---\n\n")
}

/**
 * Build a context message describing the current page state.
 * This goes in the user message, not the system prompt.
 */
export function buildContextMessage(session: string, options: {
  slug: string
  activeBlockId?: string
  activeEditablePath?: string
}): string {
  const page = getPage(session, options.slug)
  if (!page) return `[Page "${options.slug}" not found in session]`

  const draft = getSessionDraft(session)
  const slugs = orderSlugsHomeFirst(Array.from(draft.keys()))
  const parts: string[] = []

  // Site overview
  parts.push(`Site has ${slugs.length} page(s): ${slugs.join(", ")}`)

  // Current page
  parts.push(`Current page: "${page.title}" (${options.slug})`)
  parts.push(`Blocks (${page.blocks.length}):`)
  for (const block of page.blocks) {
    const propsPreview = Object.entries(block.props)
      .filter(([, v]) => typeof v === "string" && (v as string).length > 0 && (v as string).length < 100)
      .map(([k, v]) => `${k}: "${v}"`)
      .join(", ")
    parts.push(`  - ${block.type} (${block.id})${propsPreview ? `: ${propsPreview}` : ""}`)
  }

  // Selected block context
  if (options.activeBlockId) {
    const block = page.blocks.find((b) => b.id === options.activeBlockId)
    if (block) {
      parts.push(`\nSelected block: ${block.type} (${block.id})`)
      parts.push(`Full props: ${JSON.stringify(block.props, null, 2)}`)
      if (options.activeEditablePath) {
        parts.push(`Selected field: ${options.activeEditablePath}`)
      }
    }
  }

  return parts.join("\n")
}
