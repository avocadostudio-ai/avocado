import type { EditPlan, Operation, PageDoc } from "@ai-site-editor/shared"

/**
 * Tier 1 destructive-action gate. Evaluates an edit plan and decides whether
 * it should be held for explicit human approval before applying, regardless
 * of undo/redo availability.
 *
 * Undo protects against recovery; it does not protect against:
 *   - AI misinterpretation (LLM deleted the wrong block)
 *   - Cross-page ops (undo is per-page, not atomic across pages)
 *   - Cognitive slip (user didn't notice until redo stack was cleared)
 *   - Server restart wiping the in-memory undo stack
 *
 * Tier 1 triggers (no toggle — always required):
 *   1. remove_page (always — even empty pages represent structural site content)
 *   2. Multi-page AI plans (ops touch more than one slug)
 *   3. Bulk delete: >= BULK_REMOVE_BLOCK_THRESHOLD remove_block ops in a
 *      single plan, OR a plan that removes > HALF of the blocks on any page
 */

export type DestructiveReason =
  | { kind: "remove_page"; slug: string; blockCount: number }
  | { kind: "multi_page_plan"; slugs: string[] }
  | { kind: "bulk_remove_blocks"; totalRemoveOps: number }
  | { kind: "majority_page_wipe"; slug: string; removing: number; total: number }

export type DestructiveEvaluation = {
  requiresApproval: boolean
  reasons: DestructiveReason[]
  messages: string[]
}

export const BULK_REMOVE_BLOCK_THRESHOLD = 3
export const MAJORITY_WIPE_RATIO = 0.5

export type PageLookup = (slug: string) => PageDoc | null

function slugsTouchedByOps(ops: readonly Operation[]): string[] {
  const set = new Set<string>()
  for (const op of ops) {
    if (op.op === "create_page") {
      set.add(op.page.slug)
      continue
    }
    if (op.op === "update_site_config") continue
    if ("pageSlug" in op && typeof op.pageSlug === "string") set.add(op.pageSlug)
    if (op.op === "duplicate_block" && typeof op.toPageSlug === "string") set.add(op.toPageSlug)
    if (op.op === "duplicate_page" && typeof op.newPageSlug === "string") set.add(op.newPageSlug)
    if (op.op === "rename_page") set.add(op.newPageSlug)
  }
  return Array.from(set)
}

export function evaluateDestructiveActions(
  plan: Pick<EditPlan, "ops">,
  getPage: PageLookup
): DestructiveEvaluation {
  const reasons: DestructiveReason[] = []
  const ops = plan.ops

  // 1. remove_page — always destructive regardless of block count
  for (const op of ops) {
    if (op.op !== "remove_page") continue
    const page = getPage(op.pageSlug)
    const blockCount = page?.blocks?.length ?? 0
    reasons.push({ kind: "remove_page", slug: op.pageSlug, blockCount })
  }

  // 2. Multi-page plan (>1 slug touched in a single chat turn)
  const touchedSlugs = slugsTouchedByOps(ops)
  if (touchedSlugs.length > 1) {
    reasons.push({ kind: "multi_page_plan", slugs: touchedSlugs })
  }

  // 3a. Bulk remove_block — absolute count across the whole plan
  const removeBlockOps = ops.filter((op) => op.op === "remove_block")
  if (removeBlockOps.length >= BULK_REMOVE_BLOCK_THRESHOLD) {
    reasons.push({ kind: "bulk_remove_blocks", totalRemoveOps: removeBlockOps.length })
  }

  // 3b. Majority-wipe — plan removes > 50% of blocks on any single page
  const removesBySlug = new Map<string, number>()
  for (const op of removeBlockOps) {
    if (op.op !== "remove_block") continue
    removesBySlug.set(op.pageSlug, (removesBySlug.get(op.pageSlug) ?? 0) + 1)
  }
  for (const [slug, removing] of removesBySlug) {
    const page = getPage(slug)
    const total = page?.blocks?.length ?? 0
    if (total > 0 && removing / total > MAJORITY_WIPE_RATIO) {
      // Avoid duplicating with bulk_remove_blocks when both apply — both are
      // informative, so we keep them.
      reasons.push({ kind: "majority_page_wipe", slug, removing, total })
    }
  }

  return {
    requiresApproval: reasons.length > 0,
    reasons,
    messages: reasons.map(describeDestructiveReason)
  }
}

export function describeDestructiveReason(reason: DestructiveReason): string {
  switch (reason.kind) {
    case "remove_page":
      return reason.blockCount > 0
        ? `Delete page ${reason.slug} (${reason.blockCount} block${reason.blockCount === 1 ? "" : "s"} will be removed).`
        : `Delete page ${reason.slug}.`
    case "multi_page_plan":
      return `Change ${reason.slugs.length} pages in one step (${reason.slugs.join(", ")}).`
    case "bulk_remove_blocks":
      return `Delete ${reason.totalRemoveOps} blocks in one step.`
    case "majority_page_wipe":
      return `Remove ${reason.removing} of ${reason.total} blocks on ${reason.slug}.`
  }
}
