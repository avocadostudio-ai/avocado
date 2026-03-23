import { z } from "zod"
import {
  allowedBlockTypes,
  blockSchemas,
  getAllBlockMeta,
  getPropDisplayName,
  type BlockType,
  type EditPlan,
  type PageDoc
} from "@ai-site-editor/shared"
import {
  type ChatRequestBody,
  stripSiteContextEnvelope
} from "./intent-detection.js"

export function editablePropsFromBlock(block: PageDoc["blocks"][number]) {
  if (!block || !block.props || typeof block.props !== "object") return []
  return Object.keys(block.props as Record<string, unknown>)
}

export function promptFromPropKey(propKey: string) {
  const labels: Record<string, string> = {
    heading: "Edit heading",
    subheading: "Edit subheading",
    ctaText: "Edit CTA",
    ctaHref: "Update link",
    imageUrl: "Replace image",
    imageAlt: "Write alt",
    secondaryCtaText: "Add CTA",
    secondaryCtaHref: "Update link",
    body: "Edit body",
    title: "Edit title",
    description: "Edit description",
    features: "Edit features",
    items: "Edit items",
    cards: "Edit cards"
  }
  return labels[propKey] ?? `Edit ${propKey}`
}

export function userFacingPropNames(blockType: BlockType, keys: string[]) {
  return keys.map((key) => getPropDisplayName(blockType, key))
}

export const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"]

export function humanizeArrayPath(root: string): string {
  const match = root.match(/^([a-zA-Z_]+)\[(\d+)\]$/)
  if (!match) return root
  const [, listName, indexStr] = match
  const index = Number(indexStr)
  const ordinal = ORDINALS[index] ?? `#${index + 1}`
  const singular: Record<string, string> = {
    cards: "card",
    features: "feature",
    items: "item",
    stats: "stat",
    columns: "column"
  }
  const noun = singular[listName] ?? listName.replace(/s$/, "")
  return `the ${ordinal} ${noun}`
}

export function childSuggestions(args: { selected: PageDoc["blocks"][number]; editablePath: string }) {
  const { selected, editablePath } = args
  const path = editablePath.trim()
  if (!path) return []
  const root = path.split(".")[0] ?? path
  const human = humanizeArrayPath(root)

  if (selected.type === "CardGrid" && root.startsWith("cards[")) {
    return [
      `Edit ${human}'s title`,
      `Edit ${human}'s description`,
      `Edit ${human}'s CTA`,
      `Update ${human}'s link`
    ]
  }

  if (selected.type === "FeatureGrid" && root.startsWith("features[")) {
    return [`Edit ${human}'s title`, `Edit ${human}'s description`]
  }

  if (selected.type === "Testimonials" && root.startsWith("items[")) {
    return [`Edit ${human}'s quote`, `Edit ${human}'s author`]
  }

  if (selected.type === "FAQAccordion" && root.startsWith("items[")) {
    return [`Edit ${human}'s question`, `Edit ${human}'s answer`]
  }

  return [`Edit ${human}`]
}

export function clarificationSuggestions(args: { body: ChatRequestBody; current: PageDoc; selected?: PageDoc["blocks"][number] | null }) {
  const { selected, current } = args
  if (selected) {
    const keys = editablePropsFromBlock(selected)
    if (keys.length > 0) return keys.slice(0, 4).map(promptFromPropKey)
    return [
      `Edit ${selected.type}`,
      `Move ${selected.type}`
    ]
  }
  const suggestions: string[] = []
  const existingTypes = new Set(current.blocks.map((b) => b.type))
  const first = current.blocks[0]
  if (first) suggestions.push(`Edit ${first.type}`)
  if (!existingTypes.has("Testimonials")) suggestions.push("Add Testimonials")
  else if (!existingTypes.has("FAQAccordion")) suggestions.push("Add FAQ")
  else if (!existingTypes.has("CardGrid")) suggestions.push("Add CardGrid")
  if (existingTypes.has("FAQAccordion")) suggestions.push("Move FAQ")
  else if (existingTypes.has("CTA")) suggestions.push("Edit CTA")
  if (suggestions.length === 0) suggestions.push("Edit heading", "Add Testimonials")
  return suggestions.slice(0, 4)
}

export function postEditSuggestions(args: { plan: EditPlan; current: PageDoc; body: ChatRequestBody }): string[] {
  const { plan, current } = args
  if (plan.ops.some((op) => op.op === "remove_page")) return []
  const suggestions: string[] = []
  const existingTypes = new Set(current.blocks.map((b) => b.type))
  const pushUniqueSuggestion = (value: string) => {
    if (suggestions.includes(value)) return
    suggestions.push(value)
  }

  // Detect if this was primarily an image update
  const isImageUpdate = plan.change_log.some((entry) =>
    /\b(image|images|unsplash|photo)\b/i.test(entry)
  )

  for (const op of plan.ops) {
    if (op.op === "update_props") {
      const block = current.blocks.find((b) => b.id === op.blockId)
      if (block) {
        if (isImageUpdate) {
          // After image updates, suggest content edits relevant to the block
          const blockType = block.type
          if (blockType === "CardGrid" || blockType === "Card") {
            pushUniqueSuggestion("Edit cards")
            pushUniqueSuggestion("Update links")
          } else if (blockType === "FeatureGrid") {
            pushUniqueSuggestion("Edit features")
          } else if (blockType === "Hero") {
            pushUniqueSuggestion("Edit heading")
            pushUniqueSuggestion("Edit CTA")
          } else {
            pushUniqueSuggestion(`Edit ${blockType}`)
          }
        } else {
          const patchKeys = Object.keys(op.patch as Record<string, unknown>)
          const otherKeys = editablePropsFromBlock(block).filter((k) => !patchKeys.includes(k))
          for (const key of otherKeys.slice(0, 2)) {
            pushUniqueSuggestion(promptFromPropKey(key))
          }
        }
      }
    } else if (op.op === "create_page") {
      pushUniqueSuggestion("Generate image")
    } else if (op.op === "add_block") {
      pushUniqueSuggestion(`Edit ${op.block.type}`)
    } else if (op.op === "remove_block") {
      if (!existingTypes.has("CTA")) pushUniqueSuggestion("Add CTA")
    }
  }

  // Keep one or two forward-looking section suggestions even after non-structural edits.
  if (!existingTypes.has("Testimonials") && suggestions.length < 4) pushUniqueSuggestion("Add Testimonials")
  if (!existingTypes.has("FAQAccordion") && suggestions.length < 4) pushUniqueSuggestion("Add FAQ")
  if (!existingTypes.has("Stats") && suggestions.length < 4) pushUniqueSuggestion("Add Stats")

  return suggestions.slice(0, 4)
}

export function demoPlanFromMessage(message: string, slug: string, activeBlockId?: string, activeBlockType?: string): EditPlan {
  const lower = message.toLowerCase()
  const quoted = /"([^"]+)"/.exec(message)?.[1]

  // SEO metadata patterns — checked early so "seo title" isn't mistaken for hero heading
  const hasSeoKeyword = /\b(seo|meta\s*desc(?:ription)?|meta\s*title|metadata|og\s*image|open\s*graph)\b/.test(lower)
  if (hasSeoKeyword) {
    // Multi-field metadata: "add metadata with the title '...' and description '...'"
    const multiFieldMatch = lower.match(/\b(?:set|change|update|add)\b.*?\bmetadata\b/)
    if (multiFieldMatch) {
      const patch: Record<string, string> = {}
      const changeLog: string[] = []
      const titleMatch = message.match(/\btitle\s+['"]([^'"]+)['"]/i)
        ?? message.match(/\btitle\s+to\s+['"]([^'"]+)['"]/i)
      if (titleMatch) {
        patch.title = titleMatch[1]
        changeLog.push(`Title \u2192 "${titleMatch[1]}".`)
      }
      const descMatch = message.match(/\bdescription\s+['"]([^'"]+)['"]/i)
        ?? message.match(/\bdescription\s+to\s+['"]([^'"]+)['"]/i)
      if (descMatch) {
        patch.description = descMatch[1]
        changeLog.push(`Description \u2192 "${descMatch[1]}".`)
      }
      const ogMatch = message.match(/\b(?:og\s*image|open\s*graph\s*image)\s+['"]([^'"]+)['"]/i)
        ?? message.match(/\b(?:og\s*image|open\s*graph\s*image)\s+to\s+['"]([^'"]+)['"]/i)
      if (ogMatch) {
        patch.ogImage = ogMatch[1]
        changeLog.push(`OG image \u2192 "${ogMatch[1]}".`)
      }
      if (Object.keys(patch).length > 0) {
        const fields = changeLog.length === 1 ? changeLog[0].split(" \u2192")[0] : "page metadata"
        return {
          intent: "edit_plan",
          summary_for_user: `Updated ${fields}.`,
          change_log: changeLog,
          ops: [{ op: "update_page_meta", pageSlug: slug, patch }]
        }
      }
    }

    const seoGenerate = /\b(write|generate|create|add)\b.*\b(seo|meta)\b/.test(lower) && !quoted
    const seoSetMatch = lower.match(/\b(?:set|change|update|add)\b.*?\b(meta\s*desc(?:ription)?|seo\s*desc(?:ription)?)\b/)
      ?? lower.match(/\b(?:set|change|update|add)\b.*?\b(seo\s*title|meta\s*title)\b/)
      ?? lower.match(/\b(?:set|change|update|add)\b.*?\b(og\s*image|open\s*graph\s*image)\b/)

    if (seoSetMatch) {
      const fieldRaw = seoSetMatch[1].toLowerCase()
      const isTitle = /title/.test(fieldRaw)
      const isOgImage = /og|open\s*graph/.test(fieldRaw)

      const extractedQuoted = quoted
      const singleQuoted = /'([^']+)'/.exec(message)?.[1]
      const afterTo = message.match(/\bto\s+(.+)$/i)?.[1]?.trim()
      const value = extractedQuoted ?? singleQuoted ?? afterTo ?? ""

      if (!value) {
        return {
          intent: "needs_clarification",
          summary_for_user: `Please provide the value — e.g. set ${isTitle ? "SEO title" : isOgImage ? "OG image" : "meta description"} to "Your value here".`,
          change_log: [],
          ops: []
        }
      }

      const patch: Record<string, string> = {}
      const fieldLabel = isTitle ? "SEO title" : isOgImage ? "OG image" : "Meta description"
      if (isTitle) patch.title = value
      else if (isOgImage) patch.ogImage = value
      else patch.description = value

      return {
        intent: "edit_plan",
        summary_for_user: `Updated the ${fieldLabel}.`,
        change_log: [`${fieldLabel} \u2192 "${value}".`],
        ops: [{ op: "update_page_meta", pageSlug: slug, patch }]
      }
    }

    if (seoGenerate) {
      return {
        intent: "needs_clarification",
        summary_for_user: "Demo mode cannot generate SEO metadata automatically. Please provide the exact title or description you'd like to set, for example: set meta description to \"Your description here\".",
        change_log: [],
        ops: []
      }
    }
  }

  if (lower.includes("make this shorter") && activeBlockId && activeBlockType === "Hero") {
    return {
      intent: "edit_plan",
      summary_for_user: "Shortened the selected hero copy.",
      change_log: ["Updated hero heading and subheading to be more concise."],
      ops: [
        {
          op: "update_props",
          pageSlug: slug,
          blockId: activeBlockId,
          patch: {
            heading: "Edit your site in seconds",
            subheading: "Describe a change and preview it instantly."
          }
        }
      ]
    }
  }

  if ((lower.includes("title") || lower.includes("heading")) && activeBlockId && activeBlockType === "Hero") {
    const headingText =
      quoted ??
      message
        .replace(/change/i, "")
        .replace(/hero/i, "")
        .replace(/title/i, "")
        .replace(/heading/i, "")
        .replace(/\bto\b/i, "")
        .trim()

    if (headingText) {
      return {
        intent: "edit_plan",
        summary_for_user: "Updated the hero title.",
        change_log: [`Changed hero heading to "${headingText}".`],
        ops: [
          {
            op: "update_props",
            pageSlug: slug,
            blockId: activeBlockId,
            patch: { heading: headingText }
          }
        ]
      }
    }
  }

  if (lower.includes("rich text") || lower.includes("richtext") || lower.includes("text block") || lower.includes("prose")) {
    if (lower.includes("add") || lower.includes("insert") || lower.includes("create")) {
      return {
        intent: "edit_plan",
        summary_for_user: "Added a rich text section.",
        change_log: ["Inserted RichText block."],
        ops: [
          {
            op: "add_block",
            pageSlug: slug,
            block: {
              id: `b_richtext_${Date.now()}`,
              type: "RichText",
              props: {
                title: "",
                body: "Add your content here.\n\nUse a second paragraph to break up the text into readable sections."
              }
            }
          }
        ]
      }
    }
    if (activeBlockId && activeBlockType === "RichText" && quoted) {
      return {
        intent: "edit_plan",
        summary_for_user: "Updated the rich text body.",
        change_log: [`Set body to "${quoted}".`],
        ops: [{ op: "update_props", pageSlug: slug, blockId: activeBlockId, patch: { body: quoted } }]
      }
    }
  }

  if (lower.includes("add testimonials")) {
    return {
      intent: "edit_plan",
      summary_for_user: "Added a testimonials section below the hero.",
      change_log: ["Inserted Testimonials block after the hero section."],
      ops: [
        {
          op: "add_block",
          pageSlug: slug,
          afterBlockId: "b_hero_home",
          block: {
            id: `b_testimonials_${Date.now()}`,
            type: "Testimonials",
            props: {
              title: "Loved by small teams",
              items: [
                { quote: "We launched in a day.", author: "Ana, Founder" },
                { quote: "Edits are now effortless.", author: "Chris, Marketer" }
              ]
            }
          }
        }
      ]
    }
  }

  if (lower.includes("remove") && activeBlockId) {
    return {
      intent: "edit_plan",
      summary_for_user: "Removed the selected block.",
      change_log: ["Deleted selected section from the page."],
      ops: [{ op: "remove_block", pageSlug: slug, blockId: activeBlockId }]
    }
  }

  return {
    intent: "needs_clarification",
    summary_for_user: "I need one clarification: what section should I change and what exactly should be updated?",
    change_log: [],
    ops: []
  }
}

export function titleCaseSentence(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return trimmed
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

export function pageMetaContractSummary() {
  return {
    op: "update_page_meta",
    fields: {
      title: "SEO/og title (falls back to page.title if absent). Max 60 chars; put primary keyword near front; avoid generic words like 'Home' or 'Welcome'; must be unique per page.",
      description: "Meta description for search engines and social sharing. 150-160 chars; front-load key info in first 110 chars (mobile truncation); include a CTA verb; use active voice; never use quotes; never repeat the title verbatim.",
      ogImage: "Open Graph image URL for social previews. Must be HTTPS; recommended dimensions 1200x630px."
    },
    notes: "Merge-patch semantics: only supplied keys are updated. Set a field to empty string to clear it. Always include the actual values you set in change_log so the user can see them (meta tags are not visible in the page preview)."
  }
}

/**
 * Per-block notes that supplement the auto-derived contract.
 * Only add entries here when the block needs guidance beyond what the registry
 * metadata can auto-generate (list-field shapes are derived automatically).
 */
const _blockNotes: Record<string, string> = {
  Hero: "Use heading for the main headline; never invent prop names. imagePosition controls layout and must be 'left' or 'right' (default 'right'). For imageUrl: use any placeholder value (the system resolves images separately); if the user provides an explicit URL, use that. Update imageAlt to describe the intended image. Do NOT mention a specific image source in summary_for_user. secondaryCtaText/secondaryCtaHref are optional: set them to add a ghost/outline secondary button beside the primary CTA; omit or set to empty string to hide it.",
  CTA: "Keep existing props unless the user asks to change them.",
  Card: "A standalone card with one CTA.",
  RichText: "body is a string; use \\n\\n to separate paragraphs. Supported inline syntax: **word** for bold, *word* for italic, [text](url) for links, '# Heading' lines become h3 headings. title is an optional section heading. Never invent prop names.",
  Stats: "stats must be a non-empty array of {value, label}. value is a short string like '10K+' or '99.9%'. title is an optional section heading.",
  TwoColumn: "Image + text side-by-side layout. imagePosition is 'left' or 'right' (default 'right'). body supports inline markdown (**bold**, *italic*, [link](url)). ctaText/ctaHref are optional: set both to show a CTA button. For imageUrl: use any placeholder value (the system resolves images separately).",
  Footer: "columns must be a non-empty array of {title, links}. links is a string with one 'Label|URL' per line (use \\n to separate). Example: 'Home|/\\nAbout|/about\\nBlog|/blog'."
}

type BlockContract = { allowedProps: string[]; required: string[]; optional?: string[]; notes: string }

/**
 * Derive block contracts from the registry so new blocks are automatically
 * included without maintaining a parallel hardcoded map.
 */
export function blockContractsSummary() {
  const allMeta = getAllBlockMeta()
  const result: Record<string, BlockContract> = {}

  for (const type of allowedBlockTypes) {
    const schema = blockSchemas[type]
    const meta = allMeta[type]
    if (!schema || !meta) continue

    // Derive allowed/required/optional from Zod schema shape
    const shape = schema.shape as Record<string, z.ZodTypeAny>
    const allProps = Object.keys(shape)
    const required: string[] = []
    const optional: string[] = []

    for (const key of allProps) {
      if (shape[key].isOptional() || shape[key] instanceof z.ZodDefault) {
        optional.push(key)
      } else {
        required.push(key)
      }
    }

    // Collect image spec hints for scalar fields
    const imageHints: string[] = []
    for (const [fieldKey, fieldMeta] of Object.entries(meta.fields)) {
      if (fieldMeta.imageSpec) {
        const s = fieldMeta.imageSpec
        imageHints.push(`${fieldKey}: recommended ${s.aspectRatio} ${s.width}\u00d7${s.height}`)
      }
    }

    // Append list-field item shapes to notes for array props
    let autoNotes = ""
    if (meta.listFields) {
      const parts: string[] = []
      for (const [listKey, listMeta] of Object.entries(meta.listFields)) {
        const itemKeys = Object.keys(listMeta.itemFields).join(", ")
        parts.push(`${listKey} must be a non-empty array of {${itemKeys}}`)
        // Collect image spec hints for list item fields
        for (const [itemKey, itemMeta] of Object.entries(listMeta.itemFields)) {
          if (itemMeta.imageSpec) {
            const s = itemMeta.imageSpec
            imageHints.push(`${listKey}[].${itemKey}: recommended ${s.aspectRatio} ${s.width}\u00d7${s.height}`)
          }
        }
      }
      if (parts.length > 0) autoNotes = parts.join(". ") + "."
    }
    const imageHintStr = imageHints.length > 0 ? imageHints.join(". ") + "." : ""

    let notes = _blockNotes[type] ?? (autoNotes || `${meta.description ?? type} Never invent prop names.`)
    if (imageHintStr) {
      notes += (notes ? " " : "") + imageHintStr
    }

    const entry: BlockContract = {
      allowedProps: allProps,
      required,
      notes
    }
    if (optional.length > 0) entry.optional = optional

    result[type] = entry
  }

  return result
}
