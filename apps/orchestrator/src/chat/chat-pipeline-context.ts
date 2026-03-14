import { isStandalonePageOperation } from "../nlp/intent-helpers.js"
import { plannerContextPack } from "../nlp/deterministic-planner.js"
import { inferTranslationScopeFromMessage, type TranslationScope } from "./chat-pipeline-translation.js"
import { isRewriteLikeMessage } from "./chat-pipeline-deterministic.js"

export function shouldPreferFastModelForMessage(message: string) {
  if (inferTranslationScopeFromMessage(message) !== "none") return false
  if (isStandalonePageOperation(message)) return false
  return isRewriteLikeMessage(message)
}

export function shouldUseLlmIntentRouter(message: string) {
  if (inferTranslationScopeFromMessage(message) !== "none") return false
  if (isStandalonePageOperation(message)) return false
  const normalized = message.trim()
  if (normalized.length === 0 || normalized.length > 260) return false
  return (
    isRewriteLikeMessage(normalized) ||
    /\b(replace|change|update|set|edit|remove|delete|move|reorder|add)\b/.test(normalized.toLowerCase())
  )
}

export function compactPlannerContextPack(args: {
  contextPack: ReturnType<typeof plannerContextPack>
  message: string
  translationScope: TranslationScope
}) {
  if (args.translationScope === "page") return args.contextPack
  const lower = args.message.toLowerCase()
  const keepsFullContext =
    /\b(create|generate|build|duplicate)\b.*\bpage\b/.test(lower) ||
    /\b(rename|remove|delete|move)\b.*\bpage\b/.test(lower) ||
    /\btranslate\b/.test(lower)
  if (keepsFullContext) return args.contextPack

  const selectedBlockId = String(args.contextPack.selected.blockId ?? "")
  const compactOutline = args.contextPack.pageOutline.map((entry) => {
    if (entry.id === selectedBlockId) return entry
    return {
      id: entry.id,
      type: entry.type,
      props: {},
      arrayProps: entry.arrayProps
    }
  })

  return {
    ...args.contextPack,
    pageOutline: compactOutline,
    recentSuccessfulEdits: args.contextPack.recentSuccessfulEdits.slice(-3)
  }
}

export function minimalPlannerContextPack(args: {
  contextPack: ReturnType<typeof plannerContextPack>
}) {
  const selectedBlockId = String(args.contextPack.selected.blockId ?? "")
  if (!selectedBlockId) return args.contextPack

  const neighborIds = new Set(
    [args.contextPack.neighbors.previous?.id, args.contextPack.neighbors.next?.id]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
  )

  const compactOutline = args.contextPack.pageOutline
    .filter((entry) => entry.id === selectedBlockId || neighborIds.has(entry.id))
    .map((entry) => {
      if (entry.id === selectedBlockId) return entry
      return {
        id: entry.id,
        type: entry.type,
        props: {},
        arrayProps: entry.arrayProps
      }
    })

  const routeSet = new Set<string>()
  routeSet.add(args.contextPack.route)
  for (const slug of args.contextPack.pageRoutes) {
    if (routeSet.size >= 6) break
    routeSet.add(slug)
  }

  return {
    ...args.contextPack,
    pageRoutes: Array.from(routeSet),
    pageOutline: compactOutline,
    recentSuccessfulEdits: args.contextPack.recentSuccessfulEdits.slice(-1),
    resolvedReferences: {
      target: null,
      anchor: null,
      mentionedBlocks: []
    }
  }
}

export function shouldUseMinimalPlannerContext(args: {
  message: string
  translationScope: TranslationScope
  activeBlockId?: string
  activeEditablePath?: string
}) {
  if (args.translationScope !== "none") return false
  if (!args.activeBlockId && !args.activeEditablePath) return false
  if (isStandalonePageOperation(args.message)) return false
  const lower = args.message.toLowerCase()
  return (
    isRewriteLikeMessage(lower) ||
    /\b(replace|change|update|set|edit|rewrite|rephrase)\b/.test(lower)
  )
}

export function shouldPreferFocusedTranslation(args: {
  message: string
  inferredScope: TranslationScope
  activeBlockId?: string
}) {
  if (args.inferredScope !== "page") return false
  if (!args.activeBlockId) return false
  const lower = args.message.toLowerCase()
  const hasExplicitPageCue =
    /\b(this|the|entire|whole|full)\s+page\b/.test(lower) ||
    /\bwhole\s+site\b/.test(lower) ||
    /\ball\s+sections?\b/.test(lower) ||
    /\btranslate\s+page\b/.test(lower)
  if (hasExplicitPageCue) return false
  return true
}
