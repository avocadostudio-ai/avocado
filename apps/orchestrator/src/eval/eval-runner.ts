// ---------------------------------------------------------------------------
// Planner quality eval — runner
// ---------------------------------------------------------------------------

import { app } from "../index.js"
import type { PageDoc } from "@ai-site-editor/shared"
import type { AIProvider, ModelKey } from "../state/session-state.js"
import type { EvalCase, CaseScore } from "./eval-types.js"
import { scoreCase } from "./eval-scorer.js"
import { RICH_PAGES } from "./eval-fixture.js"

const SITE_ID = "eval-test"

type RunOptions = {
  provider: AIProvider
  modelKey: ModelKey
  concurrency: number
  cases: EvalCase[]
  quiet: boolean
  onCaseComplete?: (score: CaseScore, index: number, total: number) => void
}

type RunResult = {
  scores: CaseScore[]
  totalTimeMs: number
}

// ---------------------------------------------------------------------------
// Semaphore for concurrency control
// ---------------------------------------------------------------------------

class Semaphore {
  private queue: Array<() => void> = []
  private active = 0

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++
      return
    }
    return new Promise<void>((resolve) => this.queue.push(resolve))
  }

  release(): void {
    this.active--
    const next = this.queue.shift()
    if (next) {
      this.active++
      next()
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers (via Fastify inject)
// ---------------------------------------------------------------------------

async function bootstrap(session: string): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: "/draft/bootstrap",
    payload: {
      session,
      siteId: SITE_ID,
      pages: RICH_PAGES,
    },
  })
  if (res.statusCode !== 200) {
    throw new Error(`bootstrap failed: ${res.statusCode} ${res.body}`)
  }
}

async function chat(
  session: string,
  slug: string,
  message: string,
  provider: AIProvider,
  modelKey: ModelKey
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: "POST",
    url: "/chat",
    payload: {
      session,
      siteId: SITE_ID,
      slug,
      message,
      provider,
      modelKey,
      executionMode: "auto",
    },
  })
  return { status: res.statusCode, body: res.json() as Record<string, unknown> }
}

async function getDraftPage(session: string, slug: string): Promise<PageDoc | null> {
  const res = await app.inject({
    method: "GET",
    url: `/draft/pages?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(SITE_ID)}&slug=${encodeURIComponent(slug)}`,
  })
  if (res.statusCode !== 200) return null
  return res.json() as PageDoc
}

async function getDraftSlugs(session: string): Promise<string[]> {
  const res = await app.inject({
    method: "GET",
    url: `/draft/slugs?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(SITE_ID)}`,
  })
  if (res.statusCode !== 200) return []
  return ((res.json() as { slugs: string[] }).slugs) ?? []
}

// ---------------------------------------------------------------------------
// Build draft state snapshot
// ---------------------------------------------------------------------------

type DraftState = {
  pages: Map<string, PageDoc>
  slugs: string[]
}

async function captureDraftState(session: string, slugs: string[]): Promise<DraftState> {
  const pages = new Map<string, PageDoc>()
  for (const slug of slugs) {
    const page = await getDraftPage(session, slug)
    if (page) pages.set(slug, page)
  }
  return { pages, slugs }
}

// ---------------------------------------------------------------------------
// Run a single eval case
// ---------------------------------------------------------------------------

async function runCase(
  evalCase: EvalCase,
  provider: AIProvider,
  modelKey: ModelKey
): Promise<CaseScore> {
  const session = `eval-${evalCase.id}-${Date.now()}`

  // Bootstrap RICH_PAGES
  await bootstrap(session)

  // Capture before-state
  const slugsBefore = await getDraftSlugs(session)
  const draftBefore = await captureDraftState(session, slugsBefore)

  // Run chat
  const startMs = performance.now()
  const { body } = await chat(session, evalCase.slug, evalCase.message, provider, modelKey)
  const latencyMs = Math.round(performance.now() - startMs)

  // Capture after-state
  const slugsAfter = await getDraftSlugs(session)
  // Also fetch any slugs mentioned in assertions
  const assertionSlugs = (evalCase.assertions ?? [])
    .filter((a) => a.slug && !slugsAfter.includes(a.slug))
    .map((a) => a.slug!)
  const allSlugsAfter = [...new Set([...slugsAfter, ...assertionSlugs])]
  const draftAfter = await captureDraftState(session, allSlugsAfter)

  // Score
  return scoreCase({
    evalCase,
    chatResult: body as {
      status: string
      summary: string
      debug?: { opTypes?: string[]; opCount?: number; estimatedUsd?: number | null }
    },
    draftAfter,
    draftBefore,
    latencyMs,
  })
}

// ---------------------------------------------------------------------------
// Run all cases
// ---------------------------------------------------------------------------

export async function runEval(options: RunOptions): Promise<RunResult> {
  const { provider, modelKey, concurrency, cases, onCaseComplete } = options
  const sem = new Semaphore(concurrency)
  const scores: CaseScore[] = []
  const startMs = performance.now()

  // Wait for Fastify to be ready
  await app.ready()

  const promises = cases.map(async (evalCase, index) => {
    await sem.acquire()
    try {
      const score = await runCase(evalCase, provider, modelKey)
      scores.push(score)
      onCaseComplete?.(score, index, cases.length)
    } catch (err) {
      // Record a zero-score for cases that crash
      const errorScore: CaseScore = {
        caseId: evalCase.id,
        category: evalCase.category,
        composite: 0,
        pass: false,
        dimensions: {
          status: 0,
          opTypeF1: 0,
          targeting: 0,
          assertions: 0,
          contentQuality: 0,
        },
        latencyMs: 0,
        estimatedUsd: null,
        chatResult: {
          status: "error",
          summary: String(err),
          opTypes: [],
          opCount: 0,
        },
        failureDetails: [`runner error: ${err}`],
      }
      scores.push(errorScore)
      onCaseComplete?.(errorScore, index, cases.length)
    } finally {
      sem.release()
    }
  })

  await Promise.all(promises)

  const totalTimeMs = Math.round(performance.now() - startMs)

  // Sort scores to match input case order
  const caseIdOrder = new Map(cases.map((c, i) => [c.id, i]))
  scores.sort((a, b) => (caseIdOrder.get(a.caseId) ?? 0) - (caseIdOrder.get(b.caseId) ?? 0))

  return { scores, totalTimeMs }
}
