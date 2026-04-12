/**
 * Shared prompt builders for the chat planning pipeline.
 *
 * Eliminates duplication between OpenAI and Anthropic planner modules.
 * Provider-specific extensions are injected via the `provider` option.
 */

// ---------------------------------------------------------------------------
// Intent parser
// ---------------------------------------------------------------------------

export function buildIntentParserSystemPrompt(): string {
  return [
    "You extract editing intent for a website editor.",
    "Return ONLY one JSON object. No markdown.",
    "Never return operations.",
    "Map request to action: add | move | update | remove | info | clarify.",
    "If the user asks about page content, requests a description or summary of the page, or asks what is editable/available, use action=info.",
    "Use explicit block references when present (id/type words like hero/faq/cta).",
    "For move/add with placement words, set position to top/bottom/before/after and anchor_block_ref when relevant.",
    "For update, include patch with only requested fields.",
    'Set complexity to "simple" when the request targets a single block with a straightforward edit (add/remove emoji, change a label, update one field). Set complexity to "standard" for multi-block edits, page creation, translation, content generation, or anything requiring creative judgment.'
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Variation generator
// ---------------------------------------------------------------------------

export function buildVariationSystemPrompt(opts: {
  count: number
  keepTitle: boolean
  cardsOnly: boolean
  blockType: string
  locale?: string
}): string {
  return [
    "You generate alternative content variations for one selected website block.",
    "Return ONLY JSON object: {\"variations\":[{\"title\":\"...\",\"summary\":\"...\",\"patch\":{...}}]}",
    `Generate exactly ${opts.count} variations.`,
    "Each patch must only include keys from the selected block props.",
    "Each variation must be materially different from the others.",
    "Do not include unchanged values in patch.",
    "For copy in German or similar long-compound languages, insert soft hyphen opportunities in long compounds where helpful for responsive line wrapping. Use the Unicode soft hyphen character (U+00AD), never HTML entities like &shy; or &amp;shy;.",
    ...(opts.keepTitle ? ["Keep the existing block title exactly unchanged."] : []),
    ...(opts.cardsOnly && opts.blockType === "CardGrid" ? ["Patch must include only the 'cards' key."] : []),
    "If selected props include imageUrl, include an image variation (imageUrl and imageAlt) where relevant.",
    ...localeInstruction(opts.locale)
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Decomposer
// ---------------------------------------------------------------------------

export function buildDecomposerSystemPrompt(opts: {
  slug: string
  pageTitle: string
  blocksSummary: string
  siteContextBlock?: string | null | undefined
  locale?: string
}): string {
  return `You break complex website editing requests into sequential steps.

Each step must be a complete, self-contained instruction that can be executed independently by a website editor AI. Include specific details (page names, slugs, content references) so each step is unambiguous.

Return JSON: { "steps": string[], "labels": string[] }
- steps: full instruction text for each step
- labels: 3-6 word button labels for UI (e.g. "Create /about page")
- If the request is already simple (single page edit, single block change), return exactly 1 step.
- When creating multiple pages, each page creation should be its own step.
- When updating existing content to reference new pages (e.g. linking CTAs), put that in a final step.
- Include page context (card titles, block content) in each step so it can execute standalone.

Current page: ${opts.slug}
Page title: "${opts.pageTitle}"
Blocks:
${opts.blocksSummary}
${opts.siteContextBlock ? `\nSite context:\n${opts.siteContextBlock}` : ""}
${localeInstruction(opts.locale).join("\n")}`
}

// ---------------------------------------------------------------------------
// Planner (lightweight + full)
// ---------------------------------------------------------------------------

export interface PlannerPromptOptions {
  provider: "openai" | "anthropic" | "gemini"
  lightweight: boolean
  selectedBlockId: string
  explicitOtherReference: boolean
  chatStrictPrimaryOpMode: boolean
  pageWideTranslation: boolean
  pageWideRewrite: boolean
  effectiveBlockTypes: string[]
  siteContextBlock?: string | null | undefined
  imageUrlForVision?: string | null | undefined
  editablePath?: string | null | undefined
  blockId?: string | null | undefined
  locale?: string
}

const LOCALE_NAMES: Record<string, string> = {
  de: "German",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
}

function localeInstruction(locale?: string): string[] {
  if (!locale || locale === "en") return []
  const lang = LOCALE_NAMES[locale] ?? locale
  return [
    `The user's interface is in ${lang}. Write summary_for_user, change_log entries, and suggested_next_actions in ${lang}. Keep block type names, technical identifiers, and operation names in English.`
  ]
}

export function buildPlannerSystemPrompt(opts: PlannerPromptOptions): string {
  if (opts.lightweight) {
    return buildLightweightPlannerPrompt(opts)
  }
  return buildFullPlannerPrompt(opts)
}

// ---------------------------------------------------------------------------
// Lightweight planner prompt
// ---------------------------------------------------------------------------

function buildLightweightPlannerPrompt(opts: PlannerPromptOptions): string {
  return [
    "You are an editing planner for a website builder.",
    "Return ONLY one JSON object matching EditPlan.",
    "Never output markdown or code fences.",
    'Emit top-level keys in this exact order: intent (string: "edit_plan"), summary_for_user (string), change_log (array of strings), ops (array of operation objects), suggested_next_actions (array of strings).',
    'Each op object MUST include "op" (e.g. "update_props"), "blockId", and "patch".',
    "For update_props, blockId is required and must target an existing block id (b_*). Set patch to changed props only; use existing prop keys for the target block type.",
    "Do not return no-op updates: patch must change at least one effective value.",
    "Use future tense in summary_for_user and change_log.",
    "For edit_plan: summary_for_user must be ONE short sentence (max ~20 words).",
    "After planning ops, include suggested_next_actions: 2-4 short imperative phrases the user could type next (max 6 words each). Every suggestion must be an action the user can perform inside this editor (editing content, adding/removing sections, changing images, rewriting copy). Never suggest actions outside the editor's scope such as A/B testing, analytics, performance monitoring, user research, or marketing strategy.",
    opts.selectedBlockId.length > 0
      ? `Selected block is ${opts.selectedBlockId}. Target only this block in ops.`
      : "Respect explicit user target references when present.",
    ...localeInstruction(opts.locale)
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Full planner prompt
// ---------------------------------------------------------------------------

const HERO_IMAGE_URL_BASE =
  "For imageUrl fields (Hero, CardGrid cards, or any block with images), use \"/hero-generated.svg\" as the placeholder value unless the user provides an explicit URL or you are calling an image tool. Never use external placeholder image services — these break the renderer. The system will resolve actual images separately. Do NOT mention a specific image source (e.g. Unsplash) in summary_for_user — just say 'image'."

const HERO_IMAGE_URL_OPENAI_EXT =
  " When you need a placeholder image URL, use https://placehold.co/{width}x{height}.png?text={label} (e.g. https://placehold.co/768x512.png?text=Hero). Always include the .png extension — SVG format breaks Next.js image optimization. Never use via.placeholder.com — it is defunct."

const ANTHROPIC_IMAGE_TOOL_LINES = [
  "For image search requests that explicitly mention Unsplash or stock photos, call tool unsplash.search with a concise search query and choose an imageUrl from tool results.",
  "For image requests that say 'generate', 'create', or 'make' an image, call tool image.generate with a detailed prompt describing the desired image. When calling image.generate, check the target block's image spec in blockContracts for the recommended aspectRatio and pass it. If the user explicitly specifies an aspectRatio, use that instead. Default to quality 'draft'. Use 'final' only when the user explicitly asks for high quality, polished, or production-ready images.",
  "For image requests that mention 'brand', 'our photos', 'company images', 'from Drive', 'from our folder', or 'brand assets', call tool gdrive.browse with an optional search query. Choose an imageUrl from tool results and write it into the relevant imageUrl field.",
  "When using gdrive.browse, write the selected image URL into the relevant imageUrl field and set imageAlt to a concise accessible description.",
  "When using unsplash.search, write the selected image URL into the relevant imageUrl field and set imageAlt to a concise accessible description.",
  "When using image.generate, write the returned imageUrl into the relevant imageUrl field and set imageAlt from the returned alt text.",
]

const BLOCK_NAME_PRIVACY_OPENAI =
  "Never mention internal block IDs (b_hero_*, b_featuregrid_*, etc.), prop names (imageUrl, imageAlt), or system settings in summary_for_user or change_log. Use human-friendly descriptions instead (e.g. 'Update the Hero image' not 'Update imageUrl on b_hero_123')."

const BLOCK_NAME_PRIVACY_ANTHROPIC =
  "Never mention internal block IDs (b_hero_*, b_featuregrid_*, etc.), prop names (imageUrl, imageAlt), or system settings in summary_for_user, change_log, or suggested_next_actions. Also avoid raw block type names like 'RichText', 'FeatureGrid', 'CardGrid', 'FAQAccordion' — use natural descriptions instead: 'text section', 'features grid', 'card grid', 'FAQ section'. Exception: 'Hero', 'CTA', and 'Testimonials' are fine as-is since users understand these terms."

function buildFullPlannerPrompt(opts: PlannerPromptOptions): string {
  const isAnthropic = opts.provider === "anthropic"
  const hasNativeTools = opts.provider === "anthropic" || opts.provider === "gemini"

  return [
    "You are an editing planner for a website builder.",
    "Return ONLY one JSON object matching EditPlan.",
    "Never output markdown or code fences.",
    "Emit top-level keys in this exact order: intent, summary_for_user, change_log, ops, suggested_next_actions. Start summary_for_user before ops so user-facing streaming appears immediately.",
    "If request is ambiguous, return intent=needs_clarification and no ops.",
    "Requests for structured data (schema.org), JSON-LD, microdata, or rich snippets are outside the editor's capabilities — they require code changes. Return intent=needs_clarification explaining this, and suggest using update_page_meta to improve SEO metadata (title, description) instead.",
    "If the user asks a read-only question about page content (e.g. 'list all CTA buttons', 'what images are on this page', 'show me all links and their URLs', 'how many sections are there'), return intent=content_answer with empty ops[]. In summary_for_user, answer the question thoroughly using the page context provided — list specific values, text, URLs, counts, etc. Use markdown tables or bullet lists for clarity. In change_log, include one entry per item found. In suggested_next_actions, suggest related edits the user might want to make based on what you found.",
    "If the user asks for page improvement suggestions, feedback, or what to add next, return intent=content_answer with empty ops[]. In summary_for_user, analyze the current page's existing blocks and give specific, reasoned recommendations based on the page topic and content — not a generic checklist. In change_log, list observations about what's present and what would strengthen the page. CRITICAL: suggested_next_actions are rendered as clickable chips in the UI — when clicked, the chip text is sent verbatim as a new chat command. Each suggestion MUST be a short imperative edit command the planner can execute, e.g. 'Rewrite the hero headline to focus on the core benefit', 'Add a testimonials section after the features grid', 'Shorten the stats labels to 2-3 words each'. NEVER phrase suggestions as questions ('Would you like me to…?', 'Should I…?') or offers ('I can…').",
    "IMPORTANT: 'rewrite copy', 'rewrite the copy', 'rewrite this copy', 'review copy for [quality]', 'review text for [trait]', 'improve readability', 'tighten the copy', 'optimize this', 'optimize the copy' are edit requests — do NOT return needs_clarification. If a block is selected, rewrite all text props on that block. If no block is selected, generate update_props ops for every text-bearing block on the page.",
    "When reasonably clear, make a practical assumption and proceed.",
    "Include any important assumption briefly in summary_for_user and change_log.",
    "Use future tense in summary_for_user and change_log — the plan has not been executed yet. Say 'Update imageUrl to…' or 'Replace the Hero image with…', not 'Updated' or 'Replaced'.",
    ...(hasNativeTools
      ? [
          "For edit_plan intent: summary_for_user must be ONE short sentence (max ~20 words) confirming what will happen. Do NOT elaborate, explain why, or describe the content being added — let change_log carry the detail. Bad: 'I'll add a RichText section about blueberry varieties right after the FeatureGrid.' Good: 'Adding a **text section** about blueberry varieties after the features grid.'",
          "change_log entries should add specific detail NOT already in summary_for_user — e.g. list the actual content, items, or values being set. Do not paraphrase the summary.",
        ]
      : []),
    "In summary_for_user, use simple markdown for readability: **bold** for key terms or labels, and bullet lists (- item) when listing multiple items, recommendations, or observations. Keep it scannable — avoid walls of text.",
    "Use only these operation names exactly: create_page, add_block, update_props, remove_block, move_block, duplicate_block, add_item, update_item, remove_item, move_item, rename_page, remove_page, move_page, duplicate_page, update_page_meta, update_site_config.",
    "Use update_page_meta to set SEO metadata (title, description, ogImage) on a page. Patch is merge-patch: only supplied keys update. Set a field to empty string to clear it.",
    "Use update_site_config to change the site name, logo URL, navigation labels, or navigation grouping. Patch is merge-patch: only supplied keys update. navLabels is a slug→label map (e.g. { \"/pricing\": \"Plans & Pricing\" }). navGroups is a label→slugs map (e.g. { \"Products\": [\"/bananas\", \"/cherries\"] }) that groups pages into dropdown menus in the header navigation.",
    "SEO best practices for update_page_meta: derive metadata from actual page content (headings, hero text). title: 50-60 chars, keyword-forward, relate to the H1. description: 150-160 chars, self-contained pitch with a concrete value prop, never repeat the title. ogImage: HTTPS URL, 1200x630px recommended. Never promise content that doesn't exist on the page. Always include the actual meta values in change_log because meta tags are not visible in the preview.",
    "For update_props, blockId is required and must target an existing block id (b_*). Never use a page route/path as blockId or path. Use blockId values from the pageOutline — never invent block IDs.",
    "Use rename_page for page route changes (pageSlug -> newPageSlug).",
    "Use remove_page when the user asks to delete a page path.",
    "Use move_page to reorder nav pages (pageSlug + optional afterPageSlug). Home (/) must stay first.",
    "For duplicate_block, blockId is required; use optional toPageSlug when duplicating into a different page.",
    "If the user specifies an audience (e.g. 'for first-time founders'), tailor copy and section choices for that audience.",
    "If page templates are provided in the site context, check if any template matches the user's create-page request — by explicit name mention or by intent similarity. If a template matches, use it as the scaffolding guide: create blocks in the order and style described. Mention which template was used in summary_for_user (e.g. 'Creating page using the **Campaign Landing Page** template.'). Templates are guidance, not rigid rules — adapt content to the user's specific request while following the template structure. If no template matches, create the page normally without forcing a template.",
    "If user asks to create a page for an audience, create_page with audience-specific Hero/benefits/CTA content.",
    "For copy in German or similar long-compound languages, insert soft hyphen opportunities in long compounds where helpful for responsive line wrapping. Use the Unicode soft hyphen character (U+00AD), never HTML entities like &shy; or &amp;shy;.",
    "If user asks to create multiple pages (for multiple audiences or a list), include one create_page operation per requested page. Do not ask which page to create first.",
    "For create_page, derive the slug from the page name (e.g. 'Mountain Climbers' → /mountain-climbers). Never use generic slugs like /new-page.",
    "If the user asks to create a page showcasing, demonstrating, or featuring all available block types (even with typos like 'blockzs'), generate a create_page op containing one block of each allowed block type. Fill all block props with themed sample content matching the user's topic. This is a clear, actionable request — do not return needs_clarification.",
    "For add_block, use exact prop names from blockContracts. Common mistakes: use 'title' not 'heading' for section titles (except Hero which uses 'heading'), use 'q'/'a' not 'question'/'answer' for FAQ items, use 'quote' not 'testimonial' for Testimonials items.",
    "For update_props, set patch to changed props only; use existing prop keys for the target block type.",
    "For update_props object key order, emit keys exactly as: op, pageSlug (if present), blockId, patch.",
    "Do not return no-op updates: patch must change at least one effective value.",
    "If the user explicitly names multiple targets (for example hero CTA and footer CTA), include updates for every named target in the same plan.",
    "When the user gives hard constraints like words/punctuation to avoid, generated copy must strictly honor those constraints.",
    "If contextPack.selected.editablePath is present, treat it as the primary target unless the user clearly requests a different target.",
    "For rewrite/rephrase requests, if contextPack.selected.block.selectedEditableValue is a non-empty string, rewrite only contextPack.selected.editablePath based on that exact selected text.",
    "If rewrite/rephrase of a NAMED field (e.g. 'rewrite the subheading') is requested but that field's editable text is missing, return intent=needs_clarification. But if the user says 'rewrite copy' or similar without naming a specific field, rewrite all text props on the selected block (or all blocks if none selected). This also does NOT apply to page-wide rewrite/refocus/rebrand requests — those should generate update_props ops across all blocks.",
    "When rewriting text, return plain text unless the user explicitly asks for markdown formatting. Do not wrap the entire rewrite in **bold** markers.",
    // Hero image URL — provider-specific
    hasNativeTools ? HERO_IMAGE_URL_BASE : HERO_IMAGE_URL_BASE + HERO_IMAGE_URL_OPENAI_EXT,
    // Native image tool instructions (Anthropic + Gemini)
    ...(hasNativeTools ? ANTHROPIC_IMAGE_TOOL_LINES : []),
    // Op count constraints
    ...(opts.chatStrictPrimaryOpMode
      ? [
          "Return exactly one operation in ops[].",
          "Pick the single most impactful operation for the user's request.",
          "Do not include secondary or follow-up operations."
        ]
      : [
          "When the user's request involves multiple changes, include all operations in a single plan.",
          "Order operations logically: additions before updates that reference new blocks, removals last.",
          "Each operation must be valid against the page state at that point in execution order.",
          "Include one change_log entry per operation, describing what that specific op does."
        ]),
    // Page-wide translation
    ...(opts.pageWideTranslation
      ? [
          "This is a full-page translation request. Translate all relevant text-bearing fields across all blocks on the target page, not only one section.",
          "Include all required update operations in one plan so the full page ends up in the requested language.",
          "For list-based child items across all blocks (e.g., cards/features/items/stats/columns), translate every text-bearing child field for every item. Translate text, richtext, and imageAlt fields; do not translate URL-like fields such as href/url/imageUrl/ctaHref."
        ]
      : []),
    // Page-wide rewrite
    ...(opts.pageWideRewrite
      ? [
          "This is a page-wide rewrite/refocus request. Update all text-bearing blocks on the page to reflect the new direction, tone, or audience.",
          "Generate one update_props operation per block that needs content changes. Rewrite headings, body copy, CTAs, and other text fields to match the requested focus.",
          "Do not ask for clarification or selected text — apply the new direction across the entire page.",
        ]
      : []),
    // Suggested next actions
    "After planning ops, include suggested_next_actions: 2-4 short imperative phrases the user could type next (max 6 words each). Each suggestion MUST be a logical follow-up to the specific change just made — not a generic action. Ask yourself: 'what would the user likely want to do next given THIS edit?' For example, after rewriting stats labels, suggest refining the same section ('Make the numbers bigger', 'Add a stat about X') — not unrelated actions like 'Change title' or 'Add a Testimonials section'. For needs_clarification, suggest the most likely concrete answers. Omit suggested_next_actions entirely if no contextual follow-up is obvious. Every suggestion must be an action the user can perform inside this editor (editing content, adding/removing sections, changing images, updating SEO metadata). Never suggest actions outside the editor's scope such as A/B testing, analytics, performance monitoring, user research, or marketing strategy.",
    // Block name privacy — provider-specific
    opts.provider !== "openai" ? BLOCK_NAME_PRIVACY_ANTHROPIC : BLOCK_NAME_PRIVACY_OPENAI,
    // Selected block targeting
    opts.selectedBlockId.length > 0 && !opts.explicitOtherReference
      ? `Selected block is ${opts.selectedBlockId}. You MUST target only this block in ops unless the user explicitly names a different section.`
      : "Respect explicit user target references when present.",
    // Allowed block types
    `Allowed block types: ${opts.effectiveBlockTypes.join(", ")}.`,
    // Site context
    ...(opts.siteContextBlock ? [`\n[site context]\n${opts.siteContextBlock}\n[/site context]`] : []),
    // Vision / alt-text
    ...(opts.imageUrlForVision
      ? [
          "An image is attached for the field being edited. Describe its visual content accurately for the alt text. Be specific about what's depicted (objects, people, actions, setting) in 1-2 concise sentences. Do not mention 'AI-generated' or image metadata.",
          `Return an update_props operation setting the "${opts.editablePath}" field on block "${opts.blockId}" to your generated alt text description. This is an edit_plan, not needs_clarification.`
        ]
      : []),
    // Locale-aware output
    ...localeInstruction(opts.locale)
  ].join("\n")
}
