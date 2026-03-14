import type { PageDoc } from "@ai-site-editor/shared"
import { patchObject } from "./plan-normalizer.js"

export function extractAudienceTarget(message: string) {
  return extractAudienceTargets(message)[0]
}

function cleanAudienceCandidate(raw: string) {
  const cleaned = raw
    .replace(/\b(?:an?|the|only|just)\b/g, " ")
    .replace(/\b(?:audience|audiences|segment|segments)\b/g, " ")
    .replace(/[.?!:;"'`()[\]{}]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
  if (cleaned.length <= 1) return undefined
  const rejectWords = new Set([
    "a while",
    "now",
    "later",
    "free",
    "this",
    "these",
    "that",
    "those",
    "me",
    "you",
    "testing",
    "demo",
    "it",
    "here",
    "there",
    "sure",
    "fun",
    "good",
    "better",
    "best",
    "while"
  ])
  if (rejectWords.has(cleaned.toLowerCase())) return undefined
  const stopwords = new Set(["a", "an", "the", "is", "it", "to", "of", "in", "on", "for", "and", "or", "so", "if"])
  const words = cleaned.toLowerCase().split(/\s+/)
  if (words.every((w) => stopwords.has(w))) return undefined
  return cleaned
}

function splitAudienceList(raw: string) {
  return raw
    .split(/\s*(?:,|&|\band\b|\bor\b|\/)\s*/i)
    .map((part) => cleanAudienceCandidate(part))
    .filter((part): part is string => Boolean(part))
}

export function extractAudienceTargets(message: string) {
  const lower = message.toLowerCase()
  const patternMatches = [
    lower.match(/\bfor\s+([a-z0-9 ,&/-]{2,80}?)\s+(?:audience|users?|customers?|buyers?|founders?|teams?|developers?|marketers?|parents?|students?)\b/),
    lower.match(/\bfor\s+([a-z0-9 ,&/-]{2,160})$/),
    lower.match(/\btarget(?:ing)?\s+([a-z0-9 ,&/-]{2,80})\b/),
    lower.match(/\bpages?\s+for\s+([a-z0-9 ,&/-]{2,160})(?:$|[.!?])/),
    lower.match(/\bfor\s+([a-z0-9 ,&/-]{2,160})\s+pages?\b/),
    lower.match(/\b(?:create|generate|build|make|draft)\s+(?:only\s+)?([a-z0-9 ,&/-]{2,160})\s+pages?\b/)
  ]
  const raw = patternMatches.find(Boolean)?.[1]
  if (!raw) return []
  const candidates = splitAudienceList(raw)
  return [...new Set(candidates)]
}

export function titleCaseWords(text: string) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word.length > 2 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ")
}

export function addAudienceSuffix(value: string, audience: string) {
  const normalized = value.trim()
  if (!normalized) return normalized
  const audienceRe = new RegExp(`\\b${audience.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
  if (audienceRe.test(normalized)) return normalized
  return `${normalized} for ${audience}`
}

export function audiencePatchForBlock(block: PageDoc["blocks"][number], audience: string) {
  const props = block.props as Record<string, unknown>
  if (block.type === "Hero") {
    const heading = typeof props.heading === "string" ? props.heading : ""
    const subheading = typeof props.subheading === "string" ? props.subheading : ""
    const nextHeading = addAudienceSuffix(heading, audience)
    const nextSubheading = addAudienceSuffix(subheading, audience)
    const patch: Record<string, unknown> = {}
    if (nextHeading && nextHeading !== heading) patch.heading = nextHeading
    if (nextSubheading && nextSubheading !== subheading) patch.subheading = nextSubheading
    return patch
  }
  if (block.type === "RichText") {
    const body = typeof props.body === "string" ? props.body : ""
    const nextBody = body.toLowerCase().includes(audience.toLowerCase()) ? body : `For ${audience}: ${body}`
    return nextBody !== body ? { body: nextBody } : {}
  }
  if (block.type === "CTA") {
    const title = typeof props.title === "string" ? props.title : ""
    const nextTitle = addAudienceSuffix(title, audience)
    return nextTitle !== title ? { title: nextTitle } : {}
  }
  if (block.type === "FeatureGrid" || block.type === "Testimonials" || block.type === "FAQAccordion" || block.type === "CardGrid" || block.type === "Card") {
    const title = typeof props.title === "string" ? props.title : ""
    const nextTitle = addAudienceSuffix(title, audience)
    return nextTitle !== title ? { title: nextTitle } : {}
  }
  return {}
}

export function coercePatchForBlock(block: PageDoc["blocks"][number], rawPatch: unknown) {
  if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) return {}
  const source =
    "props" in (rawPatch as Record<string, unknown>) &&
    (rawPatch as { props?: unknown }).props &&
    typeof (rawPatch as { props?: unknown }).props === "object" &&
    !Array.isArray((rawPatch as { props?: unknown }).props)
      ? ((rawPatch as { props: Record<string, unknown> }).props as Record<string, unknown>)
      : (rawPatch as Record<string, unknown>)

  const allowed = Object.keys(block.props as Record<string, unknown>)
  const normalizedToAllowed = new Map<string, string>()
  for (const key of allowed) normalizedToAllowed.set(key.toLowerCase(), key)

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (allowed.includes(key)) {
      out[key] = value
      continue
    }
    const mapped = normalizedToAllowed.get(key.toLowerCase())
    if (mapped) out[mapped] = value
  }

  if (block.type === "RichText" && typeof out.body === "string") {
    out.body = out.body
      .replace(/\r\n?/g, "\n")
      .replace(/([.!?])([A-Z])/g, "$1 $2")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  }

  return out
}


export function parseIndexedPath(path: string) {
  const match = /^([a-zA-Z0-9_]+)\[(\d+)\](?:\.(.+))?$/.exec(path.trim())
  if (!match) return null
  return {
    listKey: match[1],
    index: Number(match[2]),
    leaf: match[3]
  }
}

export function inferSimpleFieldPatchFromMessage(message: string) {
  const normalized = message
    .replace(/\u201c|\u201d/g, '"')
    .replace(/\u2018|\u2019/g, "'")
  const m = normalized
    .match(/\b(?:change|set|update|edit|replace)\b[\s\w]*?\b(heading|subheading|title|description|image(?:\s*url)?|photo|picture|cta\s*text|button\s*text|cta|link|href|quote|author|question|answer|q|a)\b[\s\w]*?\b(?:to|as|with)\b\s+['"]?([^'"\n]+)['"]?/i)
  if (!m) return null
  const rawField = m[1].toLowerCase().replace(/\s+/g, "")
  const value = m[2]?.trim()
  if (!value) return null
  const map: Record<string, string> = {
    heading: "heading",
    subheading: "subheading",
    title: "title",
    description: "description",
    image: "imageUrl",
    imageurl: "imageUrl",
    photo: "imageUrl",
    picture: "imageUrl",
    ctatext: "ctaText",
    buttontext: "ctaText",
    cta: "ctaText",
    link: "ctaHref",
    href: "ctaHref",
    quote: "quote",
    author: "author",
    question: "q",
    answer: "a",
    q: "q",
    a: "a"
  }
  const key = map[rawField]
  if (!key) return null
  return { [key]: value } as Record<string, unknown>
}

export function isRewriteRequest(message: string) {
  const lower = message.toLowerCase()
  return (
    /\brewrit\w*\b/.test(lower) ||
    /\breword\w*\b/.test(lower) ||
    /\brephras\w*\b/.test(lower) ||
    /\bpolish\w*\b/.test(lower) ||
    /\brefin\w*\b/.test(lower) ||
    /\brefresh\w*\b/.test(lower) ||
    /\btighten\w*\b/.test(lower) ||
    /\bclarif\w*\b/.test(lower) ||
    /\bclean\s*up\b/.test(lower) ||
    /\bfreshen\s*up\b/.test(lower) ||
    /\bredo\b.*\b(copy|text|wording|messaging)\b/.test(lower) ||
    /\bimprove\b/.test(lower) ||
    /\bsimplif\w*\b/.test(lower) ||
    /\bmake\b.*\b(shorter|clearer|crisper|concise)\b/.test(lower) ||
    /\bshorten\w*\b/.test(lower)
  )
}

export function isTranslationRequest(message: string) {
  const lower = message.toLowerCase()
  return /\btranslate|translation|localiz|in\s+[a-z]+\b/.test(lower)
}

export function shouldKeepRichTextTitleOnTranslate(args: {
  target: PageDoc["blocks"][number]
  activeEditablePath?: string
  message: string
  fullPatch: Record<string, unknown>
}) {
  const { target, activeEditablePath, message, fullPatch } = args
  if (target.type !== "RichText") return false
  if (activeEditablePath !== "body") return false
  if (!isTranslationRequest(message)) return false
  return Object.prototype.hasOwnProperty.call(fullPatch, "title")
}

export function inferFieldHintFromMessage(message: string, allowedKeys: string[]) {
  const lower = message.toLowerCase()
  const keyMap: Array<{ test: RegExp; key: string }> = [
    { test: /\btitle\b|\bheading\b/, key: "title" },
    { test: /\bdescription\b|\bbody\b|\bcopy\b/, key: "description" },
    { test: /\bcta\s*text\b|\bbutton\s*text\b/, key: "ctaText" },
    { test: /\bcta\s*link\b|\bhref\b|\blink\b|\burl\b/, key: "ctaHref" },
    { test: /\bquote\b/, key: "quote" },
    { test: /\bauthor\b/, key: "author" },
    { test: /\bquestion\b|\bfaq\s*q\b/, key: "q" },
    { test: /\banswer\b|\bfaq\s*a\b/, key: "a" }
  ]

  for (const entry of keyMap) {
    if (entry.test.test(lower) && allowedKeys.includes(entry.key)) return entry.key
  }
  return allowedKeys[0]
}

export function rewriteFromExisting(existing: string, message: string) {
  let next = existing
    .replace(/\bamazing\b/gi, "great")
    .replace(/\bincredible\b/gi, "powerful")
    .replace(/\breally\b/gi, "")
    .replace(/\bvery\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim()

  if (/short|shorter|concise|brief/i.test(message)) {
    const sentence = next.split(/[.!?]/)[0]?.trim()
    if (sentence) next = sentence.endsWith(".") ? sentence : `${sentence}.`
  }

  if (next === existing) {
    next = existing.endsWith(".") ? `${existing.slice(0, -1)} today.` : `${existing} today.`
  }
  return next
}

export function coercePatchForEditablePath(block: PageDoc["blocks"][number], editablePath: string | undefined, rawPatch: unknown, message: string) {
  if (!editablePath) return null
  const directKey = editablePath.trim()
  const blockProps = block.props as Record<string, unknown>
  if (directKey && Object.prototype.hasOwnProperty.call(blockProps, directKey)) {
    const source = patchObject(rawPatch) ?? inferSimpleFieldPatchFromMessage(message)
    let value: unknown

    if (source) {
      if (Object.prototype.hasOwnProperty.call(source, directKey)) value = source[directKey]
      else {
        const mapped = Object.keys(source).find((key) => key.toLowerCase() === directKey.toLowerCase())
        if (mapped) value = source[mapped]
      }
    }

    if (value === undefined) {
      const quoted = quotedText(message)
      if (quoted) value = quoted
    }
    if (value === undefined && isRewriteRequest(message)) {
      const existing = blockProps[directKey]
      if (typeof existing === "string" && existing.trim().length > 0) value = rewriteFromExisting(existing, message)
    }
    if (value === undefined && /(?:imageurl|href|url|ogimage)/i.test(directKey)) {
      const match = message.match(/https?:\/\/[^\s<>"')]+/i)
      if (match?.[0]) value = match[0].trim()
    }
    if (value === undefined) return null

    return {
      patch: { [directKey]: value } as Record<string, unknown>,
      changedKeys: [directKey],
      rootKey: directKey
    }
  }

  const parsed = parseIndexedPath(editablePath)
  if (!parsed) return null

  const list = (block.props as Record<string, unknown>)[parsed.listKey]
  if (!Array.isArray(list) || parsed.index < 0 || parsed.index >= list.length) return null
  const rowRaw = list[parsed.index]
  if (!rowRaw || typeof rowRaw !== "object" || Array.isArray(rowRaw)) return null
  const row = rowRaw as Record<string, unknown>

  const source = patchObject(rawPatch) ?? inferSimpleFieldPatchFromMessage(message)

  const allowedItemKeys = Object.keys(row)
  const normalizedToAllowed = new Map<string, string>()
  for (const key of allowedItemKeys) normalizedToAllowed.set(key.toLowerCase(), key)

  const itemPatch: Record<string, unknown> = {}
  if (source) {
    for (const [key, value] of Object.entries(source)) {
      const normalized = key.trim()
      const fromPathPrefix = `${parsed.listKey}[${parsed.index}].`
      const childKey = normalized.startsWith(fromPathPrefix) ? normalized.slice(fromPathPrefix.length) : normalized
      const mapped = normalizedToAllowed.get(childKey.toLowerCase())
      if (mapped) itemPatch[mapped] = value
    }
  }

  if (Object.keys(itemPatch).length === 0 && isRewriteRequest(message)) {
    const preferredKey =
      (parsed.leaf && normalizedToAllowed.get(parsed.leaf.toLowerCase())) ?? inferFieldHintFromMessage(message, allowedItemKeys)
    if (preferredKey) {
      const existing = row[preferredKey]
      if (typeof existing === "string" && existing.trim().length > 0) {
        itemPatch[preferredKey] = rewriteFromExisting(existing, message)
      }
    }
  }
  if (Object.keys(itemPatch).length === 0) return null

  const nextList = list.map((entry, idx) => {
    if (idx !== parsed.index || !entry || typeof entry !== "object" || Array.isArray(entry)) return entry
    return { ...(entry as Record<string, unknown>), ...itemPatch }
  })
  return {
    patch: { [parsed.listKey]: nextList } as Record<string, unknown>,
    changedKeys: Object.keys(itemPatch),
    rootKey: parsed.listKey
  }
}

export function quotedText(message: string) {
  return /"([^"]+)"/.exec(message)?.[1]?.trim()
    ?? /'([^']+)'/.exec(message)?.[1]?.trim()
}

export function buildListAppendPatch(block: PageDoc["blocks"][number], message: string) {
  const lower = message.toLowerCase()
  const allQuoted = [...message.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]!.trim()).filter(Boolean)
  const quoted = allQuoted[0] ?? null

  if (block.type === "FAQAccordion") {
    const existing = Array.isArray(block.props.items) ? (block.props.items as Array<Record<string, unknown>>) : []
    const q = quoted ?? (lower.includes("question") ? "New question" : "How does this work?")
    const a = allQuoted[1] ?? "Add answer here."
    const next = [...existing, { q, a }]
    return { items: next }
  }

  if (block.type === "Testimonials") {
    const existing = Array.isArray(block.props.items) ? (block.props.items as Array<Record<string, unknown>>) : []
    const quote = quoted ?? "Great experience."
    const next = [...existing, { quote, author: "Customer" }]
    return { items: next }
  }

  if (block.type === "FeatureGrid") {
    const existing = Array.isArray(block.props.features) ? (block.props.features as Array<Record<string, unknown>>) : []
    const title = quoted ?? "New feature"
    const next = [...existing, { title, description: "Describe this feature." }]
    return { features: next }
  }

  if (block.type === "CardGrid") {
    const existing = Array.isArray(block.props.cards) ? (block.props.cards as Array<Record<string, unknown>>) : []
    const title = quoted ?? "New card"
    const next = [...existing, { title, description: "Add card description.", ctaText: "Learn more", ctaHref: "/" }]
    return { cards: next }
  }

  return null
}
