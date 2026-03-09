export const DEFAULT_PLAN_VISIBLE_CHANGE_COUNT = 3

export function normalizePlanChangeLines(lines: string[]): string[] {
  return lines.map((line) => line.trim()).filter((line) => line.length > 0)
}

export function visiblePlanChangeLines(args: {
  lines: string[]
  expanded: boolean
  maxVisible?: number
}): string[] {
  const normalized = normalizePlanChangeLines(args.lines)
  const maxVisible = Math.max(1, args.maxVisible ?? DEFAULT_PLAN_VISIBLE_CHANGE_COUNT)
  if (args.expanded || normalized.length <= maxVisible) return normalized
  return normalized.slice(0, maxVisible)
}

export function planHasHiddenChanges(args: {
  lines: string[]
  maxVisible?: number
}): boolean {
  const normalized = normalizePlanChangeLines(args.lines)
  const maxVisible = Math.max(1, args.maxVisible ?? DEFAULT_PLAN_VISIBLE_CHANGE_COUNT)
  return normalized.length > maxVisible
}
