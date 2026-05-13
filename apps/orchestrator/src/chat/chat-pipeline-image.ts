import type { FastifyBaseLogger } from "fastify"
import {
  getAllBlockMeta,
  type EditPlan,
  type Operation,
  type PageDoc
} from "@avocadostudio-ai/shared"
import type { UnsplashImage } from "../variation-images.js"
import type { PendingImageGeneration } from "../state/session-state.js"
import { inferTranslationScopeFromMessage } from "./chat-pipeline-translation.js"
import {
  heroImageQueryFromContext,
  imageKeywordsFromQuery,
  generateVariationImageWithOpenAI,
  resolveUnsplashImage,
  resolveGdriveImage,
  isExplicitImageGenRequest,
  extractImagePromptFromMessage,
  estimatedImageGenMs,
  recordImageGenDuration
} from "../image/image-helpers.js"
import { isGdriveConfigured } from "../image/gdrive-client.js"
import { firstUrlFromText, looksLikeUserInstruction, preferredImageAltText } from "./chat-pipeline-ui.js"
import { isDemoModeEnabled, isDemoImageGenDisabled } from "../demo-mode.js"

/** Is demo mode active AND image gen disabled for demo? Memoized per call. */
function isDemoImageGenActive(): boolean {
  return isDemoModeEnabled() && isDemoImageGenDisabled()
}

export function blockHasImageUrlProp(
  block: PageDoc["blocks"][number] | null | undefined
): block is PageDoc["blocks"][number] {
  if (!block) return false
  const props = block.props as Record<string, unknown>
  return typeof props === "object" && props !== null && Object.prototype.hasOwnProperty.call(props, "imageUrl")
}

export function parsePath(path: string): Array<string | number> {
  const parts: Array<string | number> = []
  for (const match of path.matchAll(/([^[.\]]+)|\[(\d+)\]/g)) {
    if (match[1]) parts.push(match[1])
    if (match[2]) parts.push(Number(match[2]))
  }
  return parts
}

export function getValueAtPath(root: unknown, path: string): unknown {
  if (!path) return root
  let current: unknown = root
  for (const part of parsePath(path)) {
    if (typeof part === "number") {
      if (!Array.isArray(current)) return undefined
      current = current[part]
      continue
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

export function setValueAtPath(root: Record<string, unknown>, path: string, value: unknown) {
  const parts = parsePath(path)
  if (parts.length === 0) return
  let current: unknown = root
  for (let idx = 0; idx < parts.length - 1; idx += 1) {
    const part = parts[idx]
    const next = parts[idx + 1]
    if (typeof part === "number") {
      if (!Array.isArray(current)) return
      if (current[part] === undefined || current[part] === null) {
        current[part] = typeof next === "number" ? [] : {}
      }
      current = current[part]
      continue
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) return
    const holder = current as Record<string, unknown>
    if (!(part in holder) || holder[part] === undefined || holder[part] === null) {
      holder[part] = typeof next === "number" ? [] : {}
    }
    current = holder[part]
  }
  const leaf = parts[parts.length - 1]
  if (typeof leaf === "number") {
    if (!Array.isArray(current)) return
    current[leaf] = value
    return
  }
  if (!current || typeof current !== "object" || Array.isArray(current)) return
  ;(current as Record<string, unknown>)[leaf] = value
}

export function deleteValueAtPath(root: Record<string, unknown>, path: string) {
  const parts = parsePath(path)
  if (parts.length === 0) return
  let current: unknown = root
  for (let idx = 0; idx < parts.length - 1; idx += 1) {
    const part = parts[idx]
    if (typeof part === "number") {
      if (!Array.isArray(current)) return
      current = current[part]
      continue
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) return
    current = (current as Record<string, unknown>)[part]
  }
  const leaf = parts[parts.length - 1]
  if (typeof leaf === "number") {
    if (!Array.isArray(current)) return
    delete current[leaf]
    return
  }
  if (!current || typeof current !== "object" || Array.isArray(current)) return
  delete (current as Record<string, unknown>)[leaf]
}

export function extractIndexedQueries(message: string) {
  const out = new Map<number, string>()
  for (const m of message.matchAll(/\b(?:card|item|feature|tile)\s*(\d+)\s*[:=]\s*"([^"]+)"/gi)) {
    const idx = Number(m[1]) - 1
    const value = m[2]?.trim()
    if (Number.isFinite(idx) && idx >= 0 && value) out.set(idx, value)
  }
  return out
}

export function extractReferencedItemIndices(message: string) {
  const numeric = new Set<number>()
  let includesLast = false

  for (const m of message.matchAll(/\b(?:card|item|feature|tile)\s*(\d+)(?:st|nd|rd|th)?\b/gi)) {
    const idx = Number(m[1]) - 1
    if (Number.isFinite(idx) && idx >= 0) numeric.add(idx)
  }
  for (const m of message.matchAll(/\b(\d+)(?:st|nd|rd|th)\s+(?:card|item|feature|tile)\b/gi)) {
    const idx = Number(m[1]) - 1
    if (Number.isFinite(idx) && idx >= 0) numeric.add(idx)
  }
  for (const m of message.matchAll(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)\s+(?:card|item|feature|tile)\b/gi)) {
    const value = String(m[1] ?? "").toLowerCase()
    if (value === "last") {
      includesLast = true
      continue
    }
    const idx =
      value === "first" ? 0 :
      value === "second" ? 1 :
      value === "third" ? 2 :
      value === "fourth" ? 3 :
      value === "fifth" ? 4 :
      value === "sixth" ? 5 :
      value === "seventh" ? 6 :
      value === "eighth" ? 7 :
      value === "ninth" ? 8 :
      value === "tenth" ? 9 :
      -1
    if (idx >= 0) numeric.add(idx)
  }

  return { numeric, includesLast, hasConstraint: numeric.size > 0 || includesLast }
}

/**
 * Check whether a block type's schema supports imageUrl at a given path.
 * E.g. "imageUrl" → true for Hero, "features[0].imageUrl" → false for FeatureGrid.
 */
export function blockSupportsImageAtPath(blockType: string, imagePath: string): boolean {
  const meta = getAllBlockMeta()[blockType]
  if (!meta) return true // unknown block type → optimistic

  // Top-level imageUrl (e.g. Hero)
  if (imagePath === "imageUrl") {
    return "imageUrl" in meta.fields
  }

  // Nested: e.g. "features[0].imageUrl" or "items[2].imageUrl"
  const listMatch = imagePath.match(/^([a-zA-Z_]+)\[\d+\]\.imageUrl$/)
  if (listMatch) {
    const listName = listMatch[1]
    const listMeta = meta.listFields?.[listName]
    if (!listMeta) return false
    return "imageUrl" in listMeta.itemFields
  }

  // Deeper nesting we can't check — be optimistic
  return true
}

export function detectImagePaths(value: unknown, basePath = "", acc = new Set<string>()) {
  if (Array.isArray(value)) {
    value.forEach((entry, idx) => detectImagePaths(entry, `${basePath}[${idx}]`, acc))
    return acc
  }
  if (!value || typeof value !== "object") return acc
  const obj = value as Record<string, unknown>
  for (const [key, child] of Object.entries(obj)) {
    const nextPath = basePath ? `${basePath}.${key}` : key
    if (key === "imageUrl") acc.add(nextPath)
    detectImagePaths(child, nextPath, acc)
  }
  return acc
}

function isRemoteHttpUrl(value: unknown) {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim())
}

function patchContainsResolvedImageUrl(patch: Record<string, unknown>) {
  const imagePaths = detectImagePaths(patch)
  for (const path of imagePaths) {
    if (isRemoteHttpUrl(getValueAtPath(patch, path))) return true
  }
  return false
}

export function imageQueryFromItem(item: Record<string, unknown>, sectionContext?: string) {
  // Skip imageAlt when it looks like a user instruction ("add white feta…",
  // "change the image…") — those phrases pollute the search query.
  const cleanAlt = typeof item.imageAlt === "string" && !looksLikeUserInstruction(item.imageAlt)
    ? item.imageAlt
    : undefined
  const candidate = [
    cleanAlt,
    item.title,
    item.heading,
    item.name,
    item.description,
    item.subheading,
    item.quote,
    item.label,
    item.q
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
  const terms = imageKeywordsFromQuery(candidate, 4)
  if (terms.length > 0) {
    // Enrich short queries with section context for more specific results
    if (terms.length <= 2 && sectionContext) {
      const contextTerms = imageKeywordsFromQuery(sectionContext, 2)
      const unique = contextTerms.filter((t) => !terms.includes(t))
      return [...terms, ...unique.slice(0, 1)].join(" ")
    }
    return terms.join(" ")
  }
  return ""
}

export function shouldPopulateAllChildImages(message: string) {
  const lower = message.toLowerCase()
  return /\b(images?|photos?|pictures?)\b/.test(lower) && /\b(all|each|every)\b/.test(lower) && /\b(cards?|items?|features?|tiles?|children)\b/.test(lower)
}

export function findImageTargets(args: {
  message: string
  currentPage: PageDoc
  targetBlock: PageDoc["blocks"][number]
  patchCandidate: Record<string, unknown>
}) {
  const mergedProps = {
    ...((args.targetBlock.props as Record<string, unknown>) ?? {}),
    ...args.patchCandidate
  }
  const explicitByIndex = extractIndexedQueries(args.message)
  const constrainedIndices = extractReferencedItemIndices(args.message)
  const defaultQuery = heroImageQueryFromContext({
    message: args.message,
    currentPage: args.currentPage,
    targetBlock: args.targetBlock,
    patchCandidate: args.patchCandidate
  })

  const imagePaths = detectImagePaths(mergedProps)
  if (shouldPopulateAllChildImages(args.message)) {
    for (const [key, value] of Object.entries(mergedProps)) {
      if (!Array.isArray(value)) continue
      value.forEach((entry, idx) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return
        imagePaths.add(`${key}[${idx}].imageUrl`)
      })
    }
  }

  // Build section-level context for enriching item queries
  const blockProps = (args.targetBlock.props as Record<string, unknown>) ?? {}
  const sectionContext = [blockProps.heading, blockProps.subheading, blockProps.title, blockProps.sectionTitle]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .join(" ")

  const targets: Array<{ path: string; altPath: string; query: string }> = []
  for (const path of imagePaths) {
    const itemMatch = path.match(/^(.*\[(\d+)\])\.imageUrl$/)
    const index = itemMatch?.[2] ? Number(itemMatch[2]) : undefined
    const itemPath = itemMatch?.[1]
    if (constrainedIndices.hasConstraint && itemPath && index !== undefined) {
      let allowed = constrainedIndices.numeric.has(index)
      if (!allowed && constrainedIndices.includesLast) {
        const listPath = itemPath.replace(/\[\d+\]$/, "")
        const listValue = getValueAtPath(mergedProps, listPath)
        if (Array.isArray(listValue) && index === listValue.length - 1) allowed = true
      }
      if (!allowed) continue
    }
    const indexed = index !== undefined ? explicitByIndex.get(index) : undefined
    let query = indexed ?? ""
    if (!query && itemPath) {
      const item = getValueAtPath(mergedProps, itemPath)
      if (item && typeof item === "object" && !Array.isArray(item)) query = imageQueryFromItem(item as Record<string, unknown>, sectionContext)
    }
    if (!query) query = defaultQuery
    targets.push({ path, altPath: path.replace(/imageUrl$/, "imageAlt"), query })
  }
  return targets
}

export function rewriteAddBlockToChildImageUpdate(args: { plan: EditPlan; message: string; currentPage: PageDoc; slug: string }): EditPlan {
  if (args.plan.intent !== "edit_plan") return args.plan
  const lower = args.message.toLowerCase()
  const referencesContainerChildren =
    /\b(in|inside|within)\b/.test(lower) ||
    /\b(?:to|for)\s+(?:all|each|every)\s+\w+/.test(lower) ||
    /\b(?:all|each|every)\s+\w+/.test(lower)
  const shouldRewrite =
    /\b(images?|photos?|pictures?)\b/.test(lower) &&
    /\b(all|each|every)\b/.test(lower) &&
    referencesContainerChildren &&
    !/\b(new|another)\b/.test(lower)
  if (!shouldRewrite) return args.plan

  const rewrittenOps: Operation[] = []
  let changed = false
  const hasObjectArrayProp = (block: PageDoc["blocks"][number]) =>
    Object.values((block.props ?? {}) as Record<string, unknown>).some((value) =>
      Array.isArray(value) && value.some((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    )
  for (const op of args.plan.ops) {
    // Handle update_props on container blocks — expand to include per-item images
    if (op.op === "update_props") {
      const existing = args.currentPage.blocks.find((block) => block.id === op.blockId)
      if (existing && hasObjectArrayProp(existing)) {
        const existingProps = (existing.props ?? {}) as Record<string, unknown>
        const patch: Record<string, unknown> = { ...((op.patch ?? {}) as Record<string, unknown>) }
        let expanded = false
        for (const [key, value] of Object.entries(existingProps)) {
          if (!Array.isArray(value)) continue
          const nextItems = value.map((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry
            const item = entry as Record<string, unknown>
            const titleLike =
              typeof item.title === "string" ? item.title :
              typeof item.heading === "string" ? item.heading :
              typeof item.name === "string" ? item.name :
              "Card image"
            return {
              ...item,
              imageUrl: typeof item.imageUrl === "string" && item.imageUrl.trim().length > 0 ? item.imageUrl : "pending",
              imageAlt: typeof item.imageAlt === "string" && item.imageAlt.trim().length > 0 && !looksLikeUserInstruction(item.imageAlt) ? item.imageAlt : `Image for ${titleLike}`
            }
          })
          patch[key] = nextItems
          expanded = true
        }
        if (expanded) {
          rewrittenOps.push({ op: "update_props", pageSlug: op.pageSlug, blockId: op.blockId, patch })
          changed = true
          continue
        }
      }
      rewrittenOps.push(op)
      continue
    }

    if (op.op !== "add_block") {
      rewrittenOps.push(op)
      continue
    }
    let existing =
      op.block.type === "Card"
        ? args.currentPage.blocks.find((block) => block.type === "CardGrid") ??
          args.currentPage.blocks.find((block) => block.type === "Card")
        : args.currentPage.blocks.find((block) => block.type === op.block.type)
    if (!existing || !hasObjectArrayProp(existing)) {
      existing =
        args.currentPage.blocks.find((block) => hasObjectArrayProp(block)) ??
        existing
    }
    if (!existing) {
      rewrittenOps.push(op)
      continue
    }
    const existingProps = (existing.props ?? {}) as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(existingProps)) {
      if (!Array.isArray(value)) continue
      const nextItems = value.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry
        const item = entry as Record<string, unknown>
        const titleLike =
          typeof item.title === "string" ? item.title :
          typeof item.heading === "string" ? item.heading :
          typeof item.name === "string" ? item.name :
          "Card image"
        return {
          ...item,
          imageUrl: typeof item.imageUrl === "string" && item.imageUrl.trim().length > 0 ? item.imageUrl : "pending",
          imageAlt: typeof item.imageAlt === "string" && item.imageAlt.trim().length > 0 ? item.imageAlt : `Image for ${titleLike}`
        }
      })
      patch[key] = nextItems
    }
    if (Object.keys(patch).length === 0) {
      rewrittenOps.push(op)
      continue
    }
    rewrittenOps.push({
      op: "update_props",
      pageSlug: args.slug,
      blockId: existing.id,
      patch
    })
    changed = true
  }

  if (!changed) return args.plan
  return {
    ...args.plan,
    summary_for_user: "Will update images in the existing section.",
    change_log: ["Will update child images in the existing component instead of adding a duplicate section."],
    ops: rewrittenOps
  }
}

// ---------------------------------------------------------------------------
// Progress-tracked image generation wrapper
// ---------------------------------------------------------------------------

const IMAGE_PROGRESS_STAGES = [
  { at: 0.00, pct:  0, label: "Understanding prompt\u2026" },
  { at: 0.10, pct: 15, label: "Composing scene\u2026" },
  { at: 0.30, pct: 40, label: "Rendering image\u2026" },
  { at: 0.65, pct: 75, label: "Finalizing details\u2026" },
  { at: 0.90, pct: 95, label: "Almost there\u2026" },
]

function startImageProgressTimer(onImageProgress?: (event: { percent: number; stage: string }) => void): () => void {
  if (!onImageProgress) return () => {}
  const estimated = estimatedImageGenMs()
  const startedAt = Date.now()
  let currentStageIdx = 0
  onImageProgress({ percent: 0, stage: IMAGE_PROGRESS_STAGES[0].label })
  const timer = setInterval(() => {
    const elapsed = Date.now() - startedAt
    const progress = Math.min(elapsed / estimated, 1)
    while (currentStageIdx < IMAGE_PROGRESS_STAGES.length - 1 && progress >= IMAGE_PROGRESS_STAGES[currentStageIdx + 1].at) {
      currentStageIdx++
    }
    const cur = IMAGE_PROGRESS_STAGES[currentStageIdx]
    const next = IMAGE_PROGRESS_STAGES[currentStageIdx + 1] ?? { at: 1, pct: 95 }
    const stageProgress = (progress - cur.at) / (next.at - cur.at)
    const pct = Math.min(Math.round(cur.pct + stageProgress * (next.pct - cur.pct)), 95)
    onImageProgress({ percent: pct, stage: cur.label })
  }, 500)
  return () => {
    clearInterval(timer)
    onImageProgress({ percent: 100, stage: "Done" })
  }
}

// ---------------------------------------------------------------------------
// Unsplash hero image rewrite
// ---------------------------------------------------------------------------

export async function withUnsplashHeroImage(args: {
  plan: EditPlan
  message: string
  slug: string
  currentPage: PageDoc
  preferredImageOps?: PendingImageGeneration[]
  activeBlockId?: string
  activeEditablePath?: string
  chatRequestId?: string
  gdriveFolderId?: string
  log: FastifyBaseLogger
  onStatusUpdate?: (message: string) => void
  onImageProgress?: (event: { percent: number; stage: string }) => void
}): Promise<EditPlan> {
  const lowerMessage = args.message.toLowerCase()
  if (args.plan.intent !== "edit_plan") return args.plan

  const explicitUnsplashRequest = lowerMessage.includes("unsplash")
  const explicitImageGen = isExplicitImageGenRequest(args.message)
  const userImagePrompt = extractImagePromptFromMessage(args.message)
  args.log.info(
    {
      event: "hero_image_rewrite_start",
      chatRequestId: args.chatRequestId,
      slug: args.slug,
      explicitUnsplashRequest,
      explicitImageGen,
      hasUserImagePrompt: Boolean(userImagePrompt),
      message: args.message
    },
    "Evaluating hero image rewrite"
  )

  const plan = rewriteAddBlockToChildImageUpdate({
    plan: structuredClone(args.plan),
    message: args.message,
    currentPage: args.currentPage,
    slug: args.slug
  })
  let changed = false
  let placeholderSkipped = false
  let resolvedImageCount = 0
  let skippedImageCount = 0
  const globalUsedImageUrls = new Set<string>()
  let sourceQuery: string | undefined
  let imageSource: "ai-generated" | "gdrive" | "unsplash" | "placeholder" = "placeholder"
  const preferredQueries = new Map<string, string>()
  for (const item of args.preferredImageOps ?? []) {
    const query = typeof item.query === "string" ? item.query.trim() : ""
    if (!query) continue
    const key = `${item.pageSlug}::${item.blockId}::${item.path ?? "imageUrl"}`
    preferredQueries.set(key, query)
  }

  for (const op of plan.ops) {
    if (op.op !== "update_props" || op.pageSlug !== args.slug) continue
    const target = args.currentPage.blocks.find((block) => block.id === op.blockId)
    if (!target) continue

    const rawPatch = op.patch as Record<string, unknown>
    const patchCandidate =
      rawPatch && typeof rawPatch.props === "object" && rawPatch.props !== null && !Array.isArray(rawPatch.props)
        ? (rawPatch.props as Record<string, unknown>)
        : rawPatch

    const touchesImage =
      detectImagePaths(patchCandidate).size > 0 ||
      args.activeEditablePath === "imageUrl" ||
      /\b(images?|photos?|pictures?)\b/.test(lowerMessage)
    const userProvidedExplicitUrl = Boolean(firstUrlFromText(args.message))
    const targets = findImageTargets({
      message: args.message,
      currentPage: args.currentPage,
      targetBlock: target,
      patchCandidate
    })
    // Filter out targets whose block schema doesn't support imageUrl at that path
    const supportedTargets = targets.filter((t) => blockSupportsImageAtPath(target.type, t.path))
    const unresolvedTargets = supportedTargets.filter((t) => !isRemoteHttpUrl(getValueAtPath(patchCandidate, t.path)))
    const hasAnyImageTarget = supportedTargets.length > 0
    const hasImageUrlInPatch = detectImagePaths(patchCandidate).size > 0
    const shouldReplace =
      !userProvidedExplicitUrl && touchesImage && hasAnyImageTarget && unresolvedTargets.length > 0 && (explicitUnsplashRequest || hasImageUrlInPatch || explicitImageGen)
    if (!touchesImage || !shouldReplace || unresolvedTargets.length === 0) continue

    const targetProps = target.props as Record<string, unknown>
    const heading = typeof targetProps.heading === "string" ? targetProps.heading : ""
    const subheading = typeof targetProps.subheading === "string" ? targetProps.subheading : ""
    const title = typeof targetProps.title === "string" ? targetProps.title : ""
    const body = typeof targetProps.body === "string" ? targetProps.body : ""
    const sectionContext = [heading, subheading, title, body].filter(Boolean).join(" — ")

    for (const targetImage of unresolvedTargets) {
      const preferredKey = `${op.pageSlug}::${op.blockId}::${targetImage.path}`
      const imageQuery = preferredQueries.get(preferredKey) ?? targetImage.query
      const currentImageUrl = typeof getValueAtPath(targetProps, targetImage.path) === "string"
        ? String(getValueAtPath(targetProps, targetImage.path))
        : ""

      let resolved: UnsplashImage | null = null
      if (!explicitUnsplashRequest && process.env.OPENAI_API_KEY) {
        args.onStatusUpdate?.("Generating image\u2026")
        let generatedPrompt: string
        let generatedAlt: string
        if (userImagePrompt) {
          generatedAlt = userImagePrompt.slice(0, 200)
          generatedPrompt = [
            "Use case: website section image",
            `Page: ${args.currentPage.title} (${args.slug})`,
            `Section: ${target.type} — ${sectionContext}`,
            userImagePrompt,
            "Constraints: no text, no logos, no watermark"
          ].join("\n")
        } else {
          generatedAlt = `AI-generated ${target.type} image featuring ${imageQuery}`
          generatedPrompt = [
            "Use case: website section image update",
            `Page: ${args.currentPage.title} (${args.slug})`,
            `Section: ${target.type} — ${sectionContext}`,
            `Primary subject: ${imageQuery}`,
            "Style: photorealistic editorial product photography",
            "Composition: clean landscape frame with clear focal subject",
            "Lighting: natural and vibrant",
            "Constraints: no text, no logos, no watermark"
          ].join("\n")
        }
        const stopProgress = startImageProgressTimer(args.onImageProgress)
        const genStart = Date.now()
        resolved = await generateVariationImageWithOpenAI({ prompt: generatedPrompt, altText: generatedAlt, log: args.log })
        recordImageGenDuration(Date.now() - genStart)
        stopProgress()
        if (resolved) imageSource = "ai-generated"
      }
      if (!resolved && (isGdriveConfigured() || args.gdriveFolderId)) {
        args.onStatusUpdate?.("Searching brand images…")
        resolved = await resolveGdriveImage(imageQuery, { chatRequestId: args.chatRequestId, logger: args.log, folderId: args.gdriveFolderId })
        if (resolved) imageSource = "gdrive"
      }
      if (!resolved) {
        args.onStatusUpdate?.("Finding a suitable image...")
        if (currentImageUrl) globalUsedImageUrls.add(currentImageUrl)
        const usedImageUrls = globalUsedImageUrls.size > 0 ? globalUsedImageUrls : undefined
        resolved = await resolveUnsplashImage(
          imageQuery,
          { subjectKeywords: imageKeywordsFromQuery(imageQuery, 4), usedImageUrls },
          { chatRequestId: args.chatRequestId, logger: args.log }
        )
        if (resolved) imageSource = resolved.url.includes("unsplash") ? "unsplash" : "placeholder"
      }

      if (!resolved || (imageSource === "placeholder" && !explicitUnsplashRequest && !explicitImageGen && !userImagePrompt)) {
        deleteValueAtPath(patchCandidate, targetImage.path)
        deleteValueAtPath(patchCandidate, targetImage.altPath)
        args.log.warn(
          { event: "image_rewrite_skip_placeholder", chatRequestId: args.chatRequestId, query: imageQuery, path: targetImage.path },
          "Skipping placeholder image — no relevant image source available"
        )
        placeholderSkipped = true
        skippedImageCount++
        continue
      }

      setValueAtPath(patchCandidate, targetImage.path, resolved.url)
      const existingAlt = getValueAtPath(patchCandidate, targetImage.altPath)
      const nextAlt = preferredImageAltText({
        query: imageQuery,
        resolvedAlt: resolved.alt,
        existingAlt: typeof existingAlt === "string" ? existingAlt : undefined
      })
      if (nextAlt.trim().length > 0) setValueAtPath(patchCandidate, targetImage.altPath, nextAlt)
      sourceQuery = resolved.query
      args.log.info(
        {
          event: "image_rewrite_applied",
          chatRequestId: args.chatRequestId,
          slug: args.slug,
          blockId: op.blockId,
          query: imageQuery,
          explicitUnsplashRequest,
          path: targetImage.path,
          nextImageUrl: resolved.url,
          nextImageAlt: getValueAtPath(patchCandidate, targetImage.altPath)
        },
        "Applied image rewrite"
      )
      changed = true
      resolvedImageCount++
      globalUsedImageUrls.add(resolved.url)
    }
    op.patch = patchCandidate
  }

  // For create_page ops, keep the default placeholder image and let the user
  // decide whether to generate an AI hero image via a suggestion pill.
  // (Previously this auto-generated an AI image which was slow and often unwanted.)

  const planAlreadyHasResolvedImage = plan.ops.some((op) => {
    if (op.op !== "update_props") return false
    const patch = op.patch as Record<string, unknown>
    const patchCandidate =
      patch && typeof patch.props === "object" && patch.props !== null && !Array.isArray(patch.props)
        ? (patch.props as Record<string, unknown>)
        : patch
    return patchContainsResolvedImageUrl(patchCandidate)
  })

  if (!changed && !planAlreadyHasResolvedImage && (explicitUnsplashRequest || explicitImageGen) && /\b(images?|photos?|pictures?|hero)\b/.test(lowerMessage)) {
    const selectedBlock =
      args.activeBlockId && args.currentPage.blocks.find((block) => block.id === args.activeBlockId)
        ? args.currentPage.blocks.find((block) => block.id === args.activeBlockId)
        : null
    const fallbackHero =
      blockHasImageUrlProp(selectedBlock)
        ? selectedBlock
        : args.currentPage.blocks.find((block) => blockHasImageUrlProp(block)) ?? null

    if (fallbackHero) {
      const query = heroImageQueryFromContext({
        message: args.message,
        currentPage: args.currentPage,
        targetBlock: fallbackHero
      })

      let resolved: UnsplashImage | null = null
      if (!explicitUnsplashRequest && process.env.OPENAI_API_KEY && (explicitImageGen || userImagePrompt)) {
        args.onStatusUpdate?.("Generating image\u2026")
        const targetProps = fallbackHero.props as Record<string, unknown>
        const heading = typeof targetProps.heading === "string" ? targetProps.heading : ""
        const subheading = typeof targetProps.subheading === "string" ? targetProps.subheading : ""
        const sectionContext = [heading, subheading].filter(Boolean).join(" — ")

        let generatedPrompt: string
        let generatedAlt: string
        if (userImagePrompt) {
          generatedAlt = userImagePrompt.slice(0, 200)
          generatedPrompt = [
            "Use case: website section image",
            `Page: ${args.currentPage.title} (${args.slug})`,
            `Section: ${fallbackHero.type} — ${sectionContext}`,
            userImagePrompt,
            "Constraints: no text, no logos, no watermark"
          ].join("\n")
        } else {
          generatedAlt = `AI-generated ${fallbackHero.type} image featuring ${query}`
          generatedPrompt = [
            "Use case: website section image update",
            `Page: ${args.currentPage.title} (${args.slug})`,
            `Section: ${fallbackHero.type} — ${sectionContext}`,
            `Primary subject: ${query}`,
            "Style: photorealistic editorial product photography",
            "Composition: clean landscape frame with clear focal subject",
            "Lighting: natural and vibrant",
            "Constraints: no text, no logos, no watermark"
          ].join("\n")
        }
        const stopProgress = startImageProgressTimer(args.onImageProgress)
        const genStart = Date.now()
        resolved = await generateVariationImageWithOpenAI({ prompt: generatedPrompt, altText: generatedAlt, log: args.log })
        recordImageGenDuration(Date.now() - genStart)
        stopProgress()
        if (resolved) imageSource = "ai-generated"
      }
      if (!resolved && (isGdriveConfigured() || args.gdriveFolderId)) {
        args.onStatusUpdate?.("Searching brand images…")
        resolved = await resolveGdriveImage(query, { chatRequestId: args.chatRequestId, logger: args.log, folderId: args.gdriveFolderId })
        if (resolved) imageSource = "gdrive"
      }
      if (!resolved) {
        args.onStatusUpdate?.("Finding a suitable image...")
        const fbProps = fallbackHero.props as Record<string, unknown>
        const fbCurrentUrl = typeof fbProps.imageUrl === "string" ? fbProps.imageUrl : ""
        const fbUsedUrls = fbCurrentUrl ? new Set([fbCurrentUrl]) : undefined
        resolved = await resolveUnsplashImage(
          query,
          { subjectKeywords: imageKeywordsFromQuery(query, 4), usedImageUrls: fbUsedUrls },
          { chatRequestId: args.chatRequestId, logger: args.log }
        )
        if (resolved) imageSource = resolved.url.includes("unsplash") ? "unsplash" : "placeholder"
      }
      // Don't push a new op just to insert a random placeholder
      if (!resolved || imageSource === "placeholder") {
        placeholderSkipped = true
      } else {
        plan.ops.push({
          op: "update_props",
          pageSlug: args.slug,
          blockId: fallbackHero.id,
          patch: { imageUrl: resolved.url, imageAlt: preferredImageAltText({ query, resolvedAlt: resolved.alt }) }
        })
      sourceQuery = resolved.query
      changed = true
      }
    }
  }

  // Remove update_props ops left with empty patches after image field stripping
  if (placeholderSkipped) {
    plan.ops = plan.ops.filter((op) => {
      if (op.op !== "update_props") return true
      const patch = op.patch as Record<string, unknown>
      const inner =
        patch && typeof patch.props === "object" && patch.props !== null && !Array.isArray(patch.props)
          ? (patch.props as Record<string, unknown>)
          : patch
      return Object.keys(inner).filter((k) => k !== "props").length > 0
    })
  }

  if (placeholderSkipped && !changed) {
    plan.change_log = [
      ...plan.change_log,
      "Could not find a matching image — configure UNSPLASH_ACCESS_KEY for relevant image search."
    ]
  }

  if (changed) {
    const countLabel = resolvedImageCount > 1 ? `${resolvedImageCount} matching images` : "a matching image"
    const sourceLabel =
      imageSource === "ai-generated"
        ? (resolvedImageCount > 1 ? `Generated ${resolvedImageCount} images with AI` : "Generated a new image with AI")
        : imageSource === "gdrive"
          ? `Found ${countLabel} from Google Drive`
          : imageSource === "unsplash"
            ? `Found ${countLabel} from Unsplash`
            : "Set Hero image from placeholder"
    plan.change_log = [...plan.change_log, `${sourceLabel}.`]
    if (skippedImageCount > 0) {
      plan.change_log = [...plan.change_log, `${skippedImageCount} image${skippedImageCount > 1 ? "s" : ""} could not be resolved.`]
    }
    // Rewrite summary to not mislead about the actual image source
    plan.summary_for_user = plan.summary_for_user
      .replace(/\bUnsplash\s+/gi, "")
      .replace(/\bfrom unsplash\b/gi, "")
      .replace(/\ban?\s+unsplash\b/gi, "a new")
  } else {
    args.log.info(
      {
        event: "image_rewrite_skipped",
        chatRequestId: args.chatRequestId,
        slug: args.slug,
        explicitUnsplashRequest,
        message: args.message
      },
      "Skipped image rewrite"
    )
  }

  return plan
}

export function shouldResolveCreatePageHeroImage(imageUrl: string) {
  const normalized = imageUrl.trim()
  if (!normalized) return true
  return !/^https?:\/\//i.test(normalized)
}

/**
 * Resolve a Hero image for a deferred create_page op.
 * Tries DALL-E first, then falls back to Unsplash.
 */
export async function resolveHeroImageForCreatePage(args: {
  query: string
  pageTitle: string
  pageSlug: string
  sectionContext: string
  chatRequestId?: string
  gdriveFolderId?: string
  log: FastifyBaseLogger
  onStatusUpdate?: (message: string) => void
  onImageProgress?: (event: { percent: number; stage: string }) => void
}): Promise<{ url: string; alt: string; source: "ai-generated" | "gdrive" | "unsplash" } | null> {
  if (process.env.OPENAI_API_KEY) {
    args.onStatusUpdate?.("Generating image\u2026")

    const generatedAlt = `AI-generated hero image featuring ${args.query}`
    const generatedPrompt = [
      "Use case: website hero image for a new page",
      `Page: ${args.pageTitle} (${args.pageSlug})`,
      `Section: Hero — ${args.sectionContext}`,
      `Primary subject: ${args.query}`,
      "Style: photorealistic editorial product photography",
      "Composition: clean landscape frame with clear focal subject",
      "Lighting: natural and vibrant",
      "Constraints: no text, no logos, no watermark"
    ].join("\n")

    const stopProgress = startImageProgressTimer(args.onImageProgress)
    const genStart = Date.now()
    const resolved = await generateVariationImageWithOpenAI({ prompt: generatedPrompt, altText: generatedAlt, log: args.log })
    recordImageGenDuration(Date.now() - genStart)
    stopProgress()

    if (resolved) {
      return { url: resolved.url, alt: resolved.alt, source: "ai-generated" }
    }
  }
  if (isGdriveConfigured() || args.gdriveFolderId) {
    args.onStatusUpdate?.("Searching brand images…")
    const gdriveResult = await resolveGdriveImage(args.query, { chatRequestId: args.chatRequestId, logger: args.log, folderId: args.gdriveFolderId })
    if (gdriveResult) {
      return { url: gdriveResult.url, alt: gdriveResult.alt, source: "gdrive" as const }
    }
  }
  args.onStatusUpdate?.("Finding image for new page...")
  const resolved = await resolveUnsplashImage(
    args.query,
    { subjectKeywords: imageKeywordsFromQuery(args.query, 4) },
    { chatRequestId: args.chatRequestId, logger: args.log }
  )
  if (resolved && resolved.url.includes("unsplash")) {
    return { url: resolved.url, alt: resolved.alt, source: "unsplash" }
  }
  return null
}

// ---------------------------------------------------------------------------
// Synchronous image-op detection (no API calls)
// ---------------------------------------------------------------------------

export function detectImageOps(args: {
  plan: EditPlan
  message: string
  slug: string
  currentPage: PageDoc
  activeBlockId?: string
  activeEditablePath?: string
}): PendingImageGeneration[] {
  // Demo mode: image generation is disabled entirely. A failed DALL-E call
  // or a 10s Unsplash lookup is the worst possible first-impression UX, so
  // we short-circuit here before any external API is touched.
  if (isDemoImageGenActive()) return []
  const lowerMessage = args.message.toLowerCase()
  if (args.plan.intent !== "edit_plan") return []
  // Translation requests don't need image resolution — skip to avoid forcing approval mode
  if (inferTranslationScopeFromMessage(args.message) !== "none") return []

  const explicitUnsplashRequest = lowerMessage.includes("unsplash")
  const explicitGdriveRequest = /\b(drive|brand\s+(?:assets?|images?|photos?)|our\s+(?:photos?|images?|folder)|company\s+(?:images?|photos?))\b/.test(lowerMessage)
  const explicitImageGen = isExplicitImageGenRequest(args.message)
  const results: PendingImageGeneration[] = []

  for (const op of args.plan.ops) {
    if (op.op !== "update_props" || op.pageSlug !== args.slug) continue
    const target = args.currentPage.blocks.find((block) => block.id === op.blockId)
    if (!target) continue

    const rawPatch = op.patch as Record<string, unknown>
    const patchCandidate =
      rawPatch && typeof rawPatch.props === "object" && rawPatch.props !== null && !Array.isArray(rawPatch.props)
        ? (rawPatch.props as Record<string, unknown>)
        : rawPatch

    const touchesImage =
      detectImagePaths(patchCandidate).size > 0 ||
      args.activeEditablePath === "imageUrl" ||
      /\b(images?|photos?|pictures?)\b/.test(lowerMessage)
    const userProvidedExplicitUrl = Boolean(firstUrlFromText(args.message))
    const targets = findImageTargets({
      message: args.message,
      currentPage: args.currentPage,
      targetBlock: target,
      patchCandidate
    })
    const hasImageUrlInPatch = detectImagePaths(patchCandidate).size > 0
    const shouldReplace =
      !userProvidedExplicitUrl &&
      touchesImage &&
      targets.length > 0 &&
      (explicitUnsplashRequest || hasImageUrlInPatch || explicitImageGen || explicitGdriveRequest)
    if (!touchesImage || !shouldReplace || targets.length === 0) continue

    const provider: PendingImageGeneration["provider"] =
      explicitGdriveRequest && isGdriveConfigured() ? "gdrive"
      : explicitUnsplashRequest ? "unsplash"
      : process.env.OPENAI_API_KEY ? "auto"
      : "unsplash"

    for (const targetImage of targets) {
      if (!blockSupportsImageAtPath(target.type, targetImage.path)) continue
      if (isRemoteHttpUrl(getValueAtPath(patchCandidate, targetImage.path))) continue
      results.push({
        blockId: op.blockId,
        pageSlug: op.pageSlug,
        path: targetImage.path,
        altPath: targetImage.altPath,
        query: targetImage.query,
        provider
      })
    }
  }

  // Fallback: explicit image request targeting a Hero block when no ops matched
  const planAlreadyHasResolvedImage = args.plan.ops.some((op) => {
    if (op.op !== "update_props") return false
    const patch = op.patch as Record<string, unknown>
    const patchCandidate =
      patch && typeof patch.props === "object" && patch.props !== null && !Array.isArray(patch.props)
        ? (patch.props as Record<string, unknown>)
        : patch
    return patchContainsResolvedImageUrl(patchCandidate)
  })

  if (results.length === 0 && !planAlreadyHasResolvedImage && (explicitUnsplashRequest || explicitImageGen) && /\b(images?|photos?|pictures?|hero)\b/.test(lowerMessage)) {
    const selectedBlock =
      args.activeBlockId && args.currentPage.blocks.find((block) => block.id === args.activeBlockId)
        ? args.currentPage.blocks.find((block) => block.id === args.activeBlockId)
        : null
    const fallbackHero =
      blockHasImageUrlProp(selectedBlock)
        ? selectedBlock
        : args.currentPage.blocks.find((block) => blockHasImageUrlProp(block)) ?? null

    if (fallbackHero) {
      const query = heroImageQueryFromContext({
        message: args.message,
        currentPage: args.currentPage,
        targetBlock: fallbackHero
      })
      const provider: PendingImageGeneration["provider"] =
        explicitGdriveRequest && isGdriveConfigured() ? "gdrive"
        : explicitUnsplashRequest ? "unsplash"
        : process.env.OPENAI_API_KEY ? "auto"
        : "unsplash"
      results.push({ blockId: fallbackHero.id, pageSlug: args.slug, query, provider })
    }
  }

  return results
}
