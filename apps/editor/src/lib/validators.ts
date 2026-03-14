import { COMPLEX_TASK_HEURISTICS } from "../config/complex-task-heuristics"

export function sanitizeSiteId(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function slugLabel(route: string) {
  if (route === "/") return "Home (/)"
  const pretty = route
    .slice(1)
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[-_]/g, " "))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" / ")
  return `${pretty || route} (${route})`
}

export function extensionFromMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes("png")) return "png"
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg"
  if (normalized.includes("webp")) return "webp"
  if (normalized.includes("gif")) return "gif"
  if (normalized.includes("webm")) return "webm"
  if (normalized.includes("wav")) return "wav"
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3"
  if (normalized.includes("mp4") || normalized.includes("m4a")) return "m4a"
  return "webm"
}

export function isVariationRequest(message: string) {
  const lower = message.toLowerCase()
  const asksGenerate = lower.includes("generate") || lower.includes("create")
  const asksVariation = /variat/.test(lower)
  return asksGenerate && asksVariation
}

export function isComplexTaskRequest(message: string) {
  const trimmed = message.trim()
  if (trimmed.length === 0) return false
  const lower = trimmed.toLowerCase()
  const actionPattern = new RegExp(`\\b(${COMPLEX_TASK_HEURISTICS.actionKeywords.join("|")})\\b`, "g")
  const connectorPattern = new RegExp(`\\b(${COMPLEX_TASK_HEURISTICS.connectorKeywords.join("|")})\\b`, "g")
  const actionMatches = (lower.match(actionPattern) ?? []).length
  const connectorMatches = (lower.match(connectorPattern) ?? []).length
  const clauseMatches = (trimmed.match(/[,.!?;]/g) ?? []).length
  if (trimmed.length >= COMPLEX_TASK_HEURISTICS.minCharsForComplex) return true
  if (actionMatches >= COMPLEX_TASK_HEURISTICS.minActionsWithConnector && connectorMatches >= COMPLEX_TASK_HEURISTICS.minConnectorsForActionRule) return true
  if (actionMatches >= COMPLEX_TASK_HEURISTICS.minActionsAny) return true
  return actionMatches >= COMPLEX_TASK_HEURISTICS.minActionsWithClauses && clauseMatches >= COMPLEX_TASK_HEURISTICS.minClausesForActionRule
}

export function normalizeComparableText(value: string) {
  return value
    .toLowerCase()
    .replace(/["'`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

export function comparableTokens(value: string) {
  const stopwords = new Set([
    "the",
    "a",
    "an",
    "in",
    "on",
    "to",
    "for",
    "of",
    "and",
    "with",
    "by",
    "from",
    "that",
    "this",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "it",
    "its",
    "selected",
    "block"
  ])
  return normalizeComparableText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !stopwords.has(token))
}

export function isRedundantChangeLine(summary: string | undefined, line: string) {
  const summaryNorm = normalizeComparableText(summary ?? "")
  const lineNorm = normalizeComparableText(line)
  if (!summaryNorm || !lineNorm) return false
  if (lineNorm === summaryNorm || lineNorm.includes(summaryNorm) || summaryNorm.includes(lineNorm)) return true

  const summaryTokens = new Set(comparableTokens(summaryNorm))
  const lineTokens = new Set(comparableTokens(lineNorm))
  if (summaryTokens.size === 0 || lineTokens.size === 0) return false

  let overlap = 0
  for (const token of lineTokens) {
    if (summaryTokens.has(token)) overlap += 1
  }

  const coverLine = overlap / lineTokens.size
  const coverSummary = overlap / summaryTokens.size
  return coverLine >= 0.55 || coverSummary >= 0.55
}
