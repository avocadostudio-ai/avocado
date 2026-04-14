// ---------------------------------------------------------------------------
// Planner quality eval — type definitions
// ---------------------------------------------------------------------------

export type EvalCase = {
  id: string
  category: string
  slug: string
  message: string
  tags: string[]
  weight?: number

  expectedStatus: "applied" | "needs_clarification"
  expectedOpTypes: string[]
  expectedOpCount?: { min: number; max: number }
  expectedTargetBlockIds?: string[]
  expectedTargetBlockTypes?: string[]
  forbiddenBlockIds?: string[]

  assertions?: EvalAssertion[]
  contentChecks?: ContentCheck[]
}

export type EvalAssertion = {
  type:
    | "block_prop_equals"
    | "block_prop_matches"
    | "block_prop_changed"
    | "block_exists"
    | "block_not_exists"
    | "block_count"
    | "page_exists"
    | "page_not_exists"
    | "item_count_delta"
  blockType?: string
  blockId?: string
  prop?: string
  value?: unknown
  pattern?: string
  slug?: string
  delta?: number
  count?: number
}

export type ContentCheck = {
  type: "max_word_count" | "no_banned_words" | "matches_regex"
  blockType?: string
  prop?: string
  maxWords?: number
  bannedWords?: string[]
  pattern?: string
}

export type CaseScore = {
  caseId: string
  category: string
  composite: number
  pass: boolean
  dimensions: {
    status: number
    opTypeF1: number
    targeting: number
    assertions: number
    contentQuality: number
  }
  latencyMs: number
  estimatedUsd: number | null
  chatResult: {
    status: string
    summary: string
    opTypes: string[]
    opCount: number
  }
  failureDetails?: string[]
}

export type EvalReport = {
  timestamp: string
  gitSha: string
  provider: string
  modelKey: string
  modelUsed: string
  cases: CaseScore[]
  summary: {
    weightedScore: number
    passCount: number
    totalCount: number
    passRate: number
    totalCost: number | null
    totalTimeMs: number
    byCategory: Record<string, { score: number; pass: number; total: number }>
  }
  regressions?: Array<{
    caseId: string
    baselineScore: number
    currentScore: number
    delta: number
  }>
}

export const DIMENSION_WEIGHTS = {
  status: 0.20,
  opTypeF1: 0.30,
  targeting: 0.20,
  assertions: 0.25,
  contentQuality: 0.05,
} as const

export const PASS_THRESHOLD = 0.7
export const REGRESSION_THRESHOLD = 0.15
