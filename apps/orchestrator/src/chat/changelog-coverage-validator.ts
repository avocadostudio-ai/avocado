/**
 * Post-plan change_log coverage validator.
 *
 * When a planner returns an edit_plan with N ops, the user reads change_log
 * to decide whether to approve. If change_log is shorter than ops[], the
 * user is approving blind to the uncovered ops — a silent bait-and-switch
 * that erodes trust. Complements the prompt rule ("change_log coverage is
 * MANDATORY") as defense in depth against LLMs that cluster ops.
 *
 * The validator appends a generic synthesized bullet per uncovered op so
 * the user at least sees the correct count, and reports the shortfall for
 * telemetry so we can track how often the LLM under-delivers.
 */

import { getBlockMeta, type EditPlan, type Operation, type PageDoc } from "@avocadostudio-ai/shared"

export type ChangelogCoverageResult = {
  plan: EditPlan
  missingCount: number
  synthesizedEntries: string[]
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
  if (plan.intent !== "edit_plan") return { plan, missingCount: 0, synthesizedEntries: [] }
  const opCount = plan.ops.length
  const changeCount = plan.change_log.length
  if (changeCount >= opCount) return { plan, missingCount: 0, synthesizedEntries: [] }

  const missingCount = opCount - changeCount
  const synthesizedEntries: string[] = []
  for (let i = changeCount; i < opCount; i++) {
    synthesizedEntries.push(describeOp(plan.ops[i], draft))
  }
  plan.change_log = [...plan.change_log, ...synthesizedEntries]
  return { plan, missingCount, synthesizedEntries }
}
