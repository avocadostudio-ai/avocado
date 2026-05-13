// ---------------------------------------------------------------------------
// Demo mode — single-feature playground gated on a shared API key
// ---------------------------------------------------------------------------
//
// When DEMO_MODE=1 is set, the orchestrator becomes a "try it before you
// sign up" playground: the hosting team's OPENAI_API_KEY / ANTHROPIC_API_KEY
// powers the planner, but everything is locked down so casual users can't
// drain it. The only operation permitted is `update_props` on a Hero block.
// Everything else (add/remove/move blocks, editing other blocks, agent
// routes, image generation) returns a friendly rejection.
//
// Design choices:
// - SERVER-ENFORCED: client-trusted `siteCapabilities` flags aren't enough;
//   a curl request could bypass them. We enforce in `applyOpsAtomically`
//   and via a Fastify preHandler hook.
// - PER-IP ISOLATION: each demo visitor gets their own ephemeral session
//   key `demo-<hash>` seeded from `demoPublishedPages()`. No persistence —
//   state resets on server restart. Avoids visitors stomping on each other.
// - RATE LIMITING: simple in-memory token bucket per IP. Default 20 req/hr.
// - NO IMAGES: detectImageOps is short-circuited in demo mode so DALL-E /
//   Unsplash calls can't be triggered. Text-only edits keep latency low
//   and costs bounded.

import { createHash } from "node:crypto"
import type { Operation, PageDoc } from "@avocadostudio-ai/shared"
import { OperationError } from "./errors.js"

// ---------------------------------------------------------------------------
// Config — read once at module load, memoized
// ---------------------------------------------------------------------------

const TRUE_VALUES = new Set(["1", "true", "yes", "on"])

function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  return TRUE_VALUES.has(raw.trim().toLowerCase())
}

function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name]
  if (!raw) return fallback
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean)
  return parts.length > 0 ? parts : fallback
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Is demo mode enabled for this orchestrator process? */
export function isDemoModeEnabled(): boolean {
  return envFlag("DEMO_MODE", false)
}

/** Operation types allowed in demo mode. Defaults to ["update_props"]. */
export function getDemoAllowedOpTypes(): string[] {
  return envList("DEMO_ALLOWED_OPS", ["update_props"])
}

/** Block types on which update_props is allowed. Defaults to ["Hero"]. */
export function getDemoAllowedBlockTypes(): string[] {
  return envList("DEMO_ALLOWED_BLOCK_TYPES", ["Hero"])
}

/** Max requests per IP per hour. Defaults to 20. */
export function getDemoRateLimitPerHour(): number {
  return envNumber("DEMO_RATE_LIMIT_PER_IP_PER_HOUR", 20)
}

/** Should image generation be disabled in demo mode? Defaults to true. */
export function isDemoImageGenDisabled(): boolean {
  return envFlag("DEMO_DISABLE_IMAGE_GEN", true)
}

// ---------------------------------------------------------------------------
// Per-IP session key
// ---------------------------------------------------------------------------

/**
 * Deterministic ephemeral session key for a demo visitor.
 *
 * We hash the IP to avoid leaking it, and keep the key short enough to read
 * in logs. The key does NOT contain "::" so it routes through the default
 * `getSessionDraft` path which auto-seeds from `demoPublishedPages()`.
 */
export function demoSessionKeyForIp(ip: string): string {
  const normalized = (ip || "anon").trim() || "anon"
  const hash = createHash("sha1").update(normalized).digest("hex").slice(0, 10)
  return `demo-${hash}`
}

/**
 * Extract a client IP from a Fastify request. Render puts the real client IP
 * in `x-forwarded-for` (first entry). Falls back to request.ip.
 */
export function extractClientIp(request: {
  headers: Record<string, string | string[] | undefined>
  ip?: string
}): string {
  const xff = request.headers["x-forwarded-for"]
  const header = Array.isArray(xff) ? xff[0] : xff
  if (typeof header === "string" && header.length > 0) {
    const first = header.split(",")[0]?.trim()
    if (first) return first
  }
  return request.ip ?? "anon"
}

// ---------------------------------------------------------------------------
// Operation gating
// ---------------------------------------------------------------------------

export type DemoEnforcement = {
  allowed: Operation[]
  rejected: Array<{ op: Operation; reason: string }>
}

/**
 * Look up a block by id across all staged pages. Returns its `type` string,
 * or undefined if the block wasn't found.
 */
function findBlockTypeInStaged(staged: Map<string, PageDoc>, blockId: string): string | undefined {
  for (const page of staged.values()) {
    for (const block of page.blocks) {
      if (block.id === blockId) return block.type
    }
  }
  return undefined
}

/**
 * Validate a list of operations against demo-mode rules. Returns the split
 * between allowed and rejected ops; caller decides whether to proceed with
 * the allowed subset or to throw.
 */
export function splitDemoOps(
  ops: Operation[],
  staged: Map<string, PageDoc>
): DemoEnforcement {
  const allowedTypes = new Set(getDemoAllowedOpTypes())
  const allowedBlockTypes = new Set(getDemoAllowedBlockTypes())
  const allowed: Operation[] = []
  const rejected: Array<{ op: Operation; reason: string }> = []

  for (const op of ops) {
    if (!allowedTypes.has(op.op)) {
      rejected.push({
        op,
        reason: `Operation type "${op.op}" is not available in the demo. Allowed: ${[...allowedTypes].join(", ")}.`
      })
      continue
    }
    // `update_props` is the only op type we currently allow, so we only need
    // to special-case that. When the allow-list is widened, add branches here.
    if (op.op === "update_props") {
      const blockType = findBlockTypeInStaged(staged, op.blockId)
      if (!blockType) {
        rejected.push({
          op,
          reason: `Block "${op.blockId}" was not found in the current draft.`
        })
        continue
      }
      if (!allowedBlockTypes.has(blockType)) {
        rejected.push({
          op,
          reason: `Editing "${blockType}" blocks is disabled in the demo. Only ${[...allowedBlockTypes].join(" / ")} edits are available — try changing the hero headline.`
        })
        continue
      }
      allowed.push(op)
      continue
    }
    // Belt-and-suspenders: if an op type slipped past allowedTypes but isn't
    // update_props, refuse it explicitly.
    rejected.push({
      op,
      reason: `Operation "${op.op}" is not permitted in the demo.`
    })
  }

  return { allowed, rejected }
}

/**
 * Throws an `OperationError` if any of the given ops violates demo-mode
 * rules. Used as the final gate inside `applyOpsAtomically`, so both chat
 * and direct `/ops` paths are covered.
 */
export function enforceDemoOps(
  ops: Operation[],
  staged: Map<string, PageDoc>
): void {
  const { rejected } = splitDemoOps(ops, staged)
  if (rejected.length === 0) return
  const firstReason = rejected[0]?.reason ?? "Operation not permitted in demo mode."
  throw new OperationError(
    `Demo mode: ${firstReason}`,
    {
      category: "planner_refusal",
      retryable: false,
      userMessage:
        "This demo only supports editing the hero section. Try: \"change the hero headline to Welcome to my new site\"."
    }
  )
}

// ---------------------------------------------------------------------------
// Rate limiter — simple in-memory sliding-window bucket per IP
// ---------------------------------------------------------------------------

type Bucket = { count: number; windowStart: number }
const WINDOW_MS = 60 * 60 * 1000 // 1 hour

const rateBuckets = new Map<string, Bucket>()

/**
 * Consume one token for the given IP. Returns `{ ok: true }` if allowed,
 * or `{ ok: false, retryAfterSeconds }` if the quota for the current
 * hourly window is exhausted.
 */
export function consumeDemoRateToken(ip: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const now = Date.now()
  const limit = getDemoRateLimitPerHour()
  const key = ip || "anon"
  const bucket = rateBuckets.get(key)
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    rateBuckets.set(key, { count: 1, windowStart: now })
    return { ok: true }
  }
  if (bucket.count >= limit) {
    const retryAfterMs = WINDOW_MS - (now - bucket.windowStart)
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) }
  }
  bucket.count += 1
  return { ok: true }
}

/** Reset the rate limiter (test hook). */
export function _resetDemoRateLimiterForTests(): void {
  rateBuckets.clear()
}
