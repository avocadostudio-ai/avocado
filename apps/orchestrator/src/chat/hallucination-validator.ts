/**
 * Post-plan hallucination validator.
 *
 * Catches planner-generated `update_props` ops whose patches contain keys
 * that aren't in the target block's schema — typically when the planner
 * promises visual changes (colors, animations, gradients) that the block
 * doesn't support. Strips the unsupported keys, appends a user-facing note
 * to `summary_for_user`, and emits a telemetry signal for later analysis.
 *
 * Complements the STRICT SCHEMA DISCIPLINE prompt rule: defense in depth
 * against LLMs that paper over schema limits in their summary text.
 */

import { blockSchemas, getBlockMeta, type BlockType, type EditPlan, type PageDoc } from "@ai-site-editor/shared"

export type HallucinatedProp = {
  blockId: string
  blockType: string
  propName: string
}

export type HallucinationValidationResult = {
  plan: EditPlan
  hallucinatedProps: HallucinatedProp[]
}

/**
 * Return the set of top-level prop keys allowed by a block type's registered
 * schema. Returns null when the block type is unregistered (e.g. custom
 * blocks from an external manifest) — in that case we cannot validate and
 * skip the check.
 */
function allowedPropKeysForBlockType(blockType: string): Set<string> | null {
  const schema = blockSchemas[blockType as BlockType]
  if (!schema) return null
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape
  if (!shape || typeof shape !== "object") return null
  return new Set(Object.keys(shape))
}

/**
 * Look up the current block by id across all pages in the draft. Preferring
 * the targeted page when supplied avoids cross-page collisions on id reuse.
 */
function findBlockType(args: {
  blockId: string
  pageSlug?: string
  draft: Map<string, PageDoc>
}): string | undefined {
  const { blockId, pageSlug, draft } = args
  if (pageSlug) {
    const page = draft.get(pageSlug)
    const hit = page?.blocks.find((b) => b.id === blockId)
    if (hit) return hit.type
  }
  for (const page of draft.values()) {
    const hit = page.blocks.find((b) => b.id === blockId)
    if (hit) return hit.type
  }
  return undefined
}

function humanBlockName(blockType: string): string {
  const meta = getBlockMeta(blockType)
  return meta?.displayName ?? blockType
}

/**
 * Scan every `update_props` op in the plan, strip patch keys that are not
 * in the block's schema, collect the removed (blockType, propName) pairs,
 * and append a single merged note to `summary_for_user` when anything was
 * stripped.
 *
 * Mutates `plan` in place (strips keys, appends the summary note, appends
 * change_log entries) and returns the updated plan alongside the list of
 * stripped props for logging.
 */
export function validateAndStripHallucinatedProps(args: {
  plan: EditPlan
  draft: Map<string, PageDoc>
}): HallucinationValidationResult {
  const { plan, draft } = args
  const hallucinatedProps: HallucinatedProp[] = []

  for (const op of plan.ops) {
    if (op.op !== "update_props") continue
    const blockType = findBlockType({ blockId: op.blockId, pageSlug: op.pageSlug, draft })
    if (!blockType) continue
    const allowedKeys = allowedPropKeysForBlockType(blockType)
    if (!allowedKeys) continue

    const rawPatch = op.patch as Record<string, unknown>
    if (!rawPatch || typeof rawPatch !== "object") continue
    const patchCandidate =
      rawPatch.props && typeof rawPatch.props === "object" && !Array.isArray(rawPatch.props)
        ? (rawPatch.props as Record<string, unknown>)
        : rawPatch

    for (const key of Object.keys(patchCandidate)) {
      if (allowedKeys.has(key)) continue
      delete patchCandidate[key]
      hallucinatedProps.push({ blockId: op.blockId, blockType, propName: key })
    }
  }

  if (hallucinatedProps.length > 0) {
    // Merge duplicates into a single readable note keyed by blockType.
    const byBlockType = new Map<string, Set<string>>()
    for (const entry of hallucinatedProps) {
      const bucket = byBlockType.get(entry.blockType) ?? new Set<string>()
      bucket.add(entry.propName)
      byBlockType.set(entry.blockType, bucket)
    }

    const noteParts: string[] = []
    for (const [blockType, propNames] of byBlockType) {
      const name = humanBlockName(blockType)
      const props = Array.from(propNames).join(", ")
      noteParts.push(`${name} doesn't support ${props} — skipped that part.`)
    }
    const note = `Note: ${noteParts.join(" ")}`
    const summary = plan.summary_for_user?.trimEnd() ?? ""
    plan.summary_for_user = summary.length > 0 ? `${summary}\n\n${note}` : note
    plan.change_log = [...plan.change_log, note]
  }

  return { plan, hallucinatedProps }
}
