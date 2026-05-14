/**
 * Post-plan change_log coverage validator.
 *
 * When a planner returns an edit_plan with N ops, the user reads change_log
 * to decide whether to approve. If change_log is shorter than ops[], the
 * user is approving blind to the uncovered ops — a silent bait-and-switch
 * that erodes trust. If change_log is LONGER than ops[], the planner is
 * describing changes it won't actually make (e.g. emits `duplicate_page`
 * alone but narrates 4 follow-up `update_props` edits in change_log); the
 * approval UI then promises content the apply step will silently drop.
 *
 * For the under-coverage case, the validator appends a synthesized bullet
 * per uncovered op. For the over-coverage case, it trims trailing entries
 * so the rendered plan matches what will actually run. Both directions
 * report counts for telemetry so we can track how often planners drift.
 */

import { getBlockMeta, type EditPlan, type Operation, type PageDoc } from "@avocadostudio-ai/shared"

export type ChangelogCoverageResult = {
  plan: EditPlan
  missingCount: number
  synthesizedEntries: string[]
  extraCount: number
  droppedEntries: string[]
}

function lookupBlockTypeName(args: {
  blockId: string
  pageSlug: string
  draft: Map<string, PageDoc>
}): string | undefined {
  const { blockId, pageSlug, draft } = args
  const page = draft.get(pageSlug)
  const hit = page?.blocks.find((b) => b.id === blockId)
  if (!hit) return undefined
  return getBlockMeta(hit.type)?.displayName ?? hit.type
}

function describeBlockOp(args: {
  verb: string
  blockId: string
  pageSlug: string
  draft: Map<string, PageDoc>
}): string {
  const name = lookupBlockTypeName(args)
  return name ? `Will ${args.verb} the ${name} block.` : `Will ${args.verb} a block.`
}

function describeOp(op: Operation, draft: Map<string, PageDoc>): string {
  switch (op.op) {
    case "update_props":
      return describeBlockOp({ verb: "update", blockId: op.blockId, pageSlug: op.pageSlug, draft })
    case "add_block": {
      const name = getBlockMeta(op.block.type)?.displayName ?? op.block.type
      return `Will add a new ${name} block.`
    }
    case "remove_block":
      return describeBlockOp({ verb: "remove", blockId: op.blockId, pageSlug: op.pageSlug, draft })
    case "move_block":
      return describeBlockOp({ verb: "reorder", blockId: op.blockId, pageSlug: op.pageSlug, draft })
    case "duplicate_block":
      return describeBlockOp({ verb: "duplicate", blockId: op.blockId, pageSlug: op.pageSlug, draft })
    case "add_item":
      return describeBlockOp({ verb: "add an item to", blockId: op.blockId, pageSlug: op.pageSlug, draft })
    case "update_item":
      return describeBlockOp({ verb: "update an item in", blockId: op.blockId, pageSlug: op.pageSlug, draft })
    case "remove_item":
      return describeBlockOp({ verb: "remove an item from", blockId: op.blockId, pageSlug: op.pageSlug, draft })
    case "move_item":
      return describeBlockOp({ verb: "reorder an item in", blockId: op.blockId, pageSlug: op.pageSlug, draft })
    case "create_page":
      return `Will create page ${op.page.slug}.`
    case "remove_page":
      return `Will remove page ${op.pageSlug}.`
    case "rename_page":
      return `Will rename page ${op.pageSlug}.`
    case "move_page":
      return `Will reorder page ${op.pageSlug}.`
    case "duplicate_page":
      return `Will duplicate page ${op.pageSlug}.`
    case "update_page_meta":
      return "Will update page metadata."
    case "update_site_config":
      return "Will update site settings."
    default: {
      const _exhaustive: never = op
      return "Will apply an additional change."
    }
  }
}

/**
 * Ensure change_log has at least one entry per op for edit_plan intents.
 * When short, synthesize a generic entry per uncovered op so the user sees
 * an accurate count of changes. Non-edit_plan intents and empty ops lists
 * are passed through unchanged.
 */
export function validateChangelogCoverage(args: {
  plan: EditPlan
  draft: Map<string, PageDoc>
}): ChangelogCoverageResult {
  const { plan, draft } = args
  const empty = { plan, missingCount: 0, synthesizedEntries: [], extraCount: 0, droppedEntries: [] }
  if (plan.intent !== "edit_plan") return empty
  const opCount = plan.ops.length
  const changeCount = plan.change_log.length
  if (changeCount === opCount) return empty

  // Empty ops list with non-empty change_log is almost always a planner
  // confusion (intent should have been content_answer). Leave it for
  // higher-level handling rather than wiping the user-facing copy here.
  if (opCount === 0) return empty

  if (changeCount < opCount) {
    const missingCount = opCount - changeCount
    const synthesizedEntries: string[] = []
    for (let i = changeCount; i < opCount; i++) {
      synthesizedEntries.push(describeOp(plan.ops[i], draft))
    }
    plan.change_log = [...plan.change_log, ...synthesizedEntries]
    return { plan, missingCount, synthesizedEntries, extraCount: 0, droppedEntries: [] }
  }

  // changeCount > opCount: planner described more changes than it emitted ops
  // for. Trim trailing entries so the approval UI matches reality.
  const extraCount = changeCount - opCount
  const droppedEntries = plan.change_log.slice(opCount)
  plan.change_log = plan.change_log.slice(0, opCount)
  return { plan, missingCount: 0, synthesizedEntries: [], extraCount, droppedEntries }
}
