import OpenAI from "openai"
import type { PageDoc } from "@ai-site-editor/shared"

// ---------------------------------------------------------------------------
// Heuristic: does this message look like a multi-step request?
// ---------------------------------------------------------------------------

const MULTI_STEP_SIGNALS: RegExp[] = [
  // Plural "pages" + creation verb
  /\b(?:create|generate|build|make|draft|add)\b[^.\n]{0,80}\bpages\b/,
  // "for each" / "for every" / "for all" + action
  /\bfor\s+(?:each|every|all)\b/,
  // Count + "pages"/"blocks" + conjunction
  /\b(?:\d+|two|three|four|five|six|seven|eight|nine|ten)\s+(?:new\s+)?pages\b/,
  // Multiple distinct actions separated by "and"/"then"
  /\b(?:create|add|build)\b.{5,80}\b(?:and|then)\b.{5,80}\b(?:update|link|change|set|connect)\b/,
  // "page for each card/item/feature"
  /\bpages?\s+for\s+(?:each|every)\b/,
]

export function isMultiStepCandidate(message: string): boolean {
  const m = message.toLowerCase().replace(/\s+/g, " ").trim()
  return MULTI_STEP_SIGNALS.some((re) => re.test(m))
}

// ---------------------------------------------------------------------------
// LLM-based decomposition into sequential steps
// ---------------------------------------------------------------------------

export type DecomposeResult = {
  steps: string[]
  labels: string[]
}

export async function decomposeRequest(args: {
  message: string
  currentPage: PageDoc
  slug: string
  model: string
  siteContextBlock?: string | null
  client?: { chat: { completions: { create: (a: unknown) => any } } }
}): Promise<DecomposeResult> {
  const { message, currentPage, slug, model, siteContextBlock } = args

  const blocksSummary = currentPage.blocks
    .map((b) => {
      const props = b.props as Record<string, unknown>
      const title = typeof props.title === "string" ? props.title
        : typeof props.heading === "string" ? props.heading : ""
      return `- ${b.type} (id: ${b.id})${title ? `: "${title}"` : ""}`
    })
    .join("\n")

  const systemPrompt = `You break complex website editing requests into sequential steps.

Each step must be a complete, self-contained instruction that can be executed independently by a website editor AI. Include specific details (page names, slugs, content references) so each step is unambiguous.

Return JSON: { "steps": string[], "labels": string[] }
- steps: full instruction text for each step
- labels: 3-6 word button labels for UI (e.g. "Create /about page")
- If the request is already simple (single page edit, single block change), return exactly 1 step.
- When creating multiple pages, each page creation should be its own step.
- When updating existing content to reference new pages (e.g. linking CTAs), put that in a final step.
- Include page context (card titles, block content) in each step so it can execute standalone.

Current page: ${slug}
Page title: "${currentPage.title}"
Blocks:
${blocksSummary}
${siteContextBlock ? `\nSite context:\n${siteContextBlock}` : ""}`

  const client = args.client ?? (new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) as unknown as { chat: { completions: { create: (a: unknown) => any } } })

  const response = await (client.chat.completions.create as (a: unknown) => Promise<{ choices: Array<{ message: { content: string } }> }>)({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: message }
    ],
    temperature: 0,
    response_format: { type: "json_object" }
  })

  const raw = response.choices?.[0]?.message?.content ?? "{}"
  try {
    const parsed = JSON.parse(raw) as { steps?: unknown; labels?: unknown }
    const steps = Array.isArray(parsed.steps) ? parsed.steps.filter((s): s is string => typeof s === "string") : []
    const labels = Array.isArray(parsed.labels) ? parsed.labels.filter((s): s is string => typeof s === "string") : []

    if (steps.length === 0) return { steps: [message], labels: [message.slice(0, 40)] }

    // Ensure labels array matches steps length
    while (labels.length < steps.length) {
      labels.push(`Step ${labels.length + 1}`)
    }

    return { steps, labels: labels.slice(0, steps.length) }
  } catch {
    return { steps: [message], labels: [message.slice(0, 40)] }
  }
}
