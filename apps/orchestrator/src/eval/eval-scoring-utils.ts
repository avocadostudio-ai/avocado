// ---------------------------------------------------------------------------
// Shared op-normalization and F1 scoring utilities.
// Extracted from scripts/benchmark-models.ts for reuse in the eval framework.
// ---------------------------------------------------------------------------

export const CANONICAL_OPS = [
  "create_page",
  "add_block",
  "update_props",
  "remove_block",
  "move_block",
  "duplicate_block",
  "add_item",
  "update_item",
  "remove_item",
  "move_item",
  "rename_page",
  "remove_page",
  "move_page",
  "duplicate_page",
  "update_page_meta",
  "update_site_config"
] as const

export type CanonicalOp = (typeof CANONICAL_OPS)[number]

export const OP_ALIASES: Record<string, CanonicalOp> = {
  create_page: "create_page",
  createpage: "create_page",
  create_page_op: "create_page",
  add_block: "add_block",
  addblock: "add_block",
  insert_block: "add_block",
  insertblock: "add_block",
  update_props: "update_props",
  updateprops: "update_props",
  update_block: "update_props",
  updateblock: "update_props",
  edit_block: "update_props",
  editblock: "update_props",
  remove_block: "remove_block",
  removeblock: "remove_block",
  delete_block: "remove_block",
  deleteblock: "remove_block",
  move_block: "move_block",
  moveblock: "move_block",
  reorder_block: "move_block",
  reorderblock: "move_block",
  duplicate_block: "duplicate_block",
  duplicateblock: "duplicate_block",
  copy_block: "duplicate_block",
  copyblock: "duplicate_block",
  clone_block: "duplicate_block",
  cloneblock: "duplicate_block",
  add_item: "add_item",
  additem: "add_item",
  insert_item: "add_item",
  insertitem: "add_item",
  append_item: "add_item",
  appenditem: "add_item",
  update_item: "update_item",
  updateitem: "update_item",
  edit_item: "update_item",
  edititem: "update_item",
  remove_item: "remove_item",
  removeitem: "remove_item",
  delete_item: "remove_item",
  deleteitem: "remove_item",
  move_item: "move_item",
  moveitem: "move_item",
  reorder_item: "move_item",
  reorderitem: "move_item",
  rename_page: "rename_page",
  renamepage: "rename_page",
  remove_page: "remove_page",
  removepage: "remove_page",
  delete_page: "remove_page",
  deletepage: "remove_page",
  move_page: "move_page",
  movepage: "move_page",
  reorder_page: "move_page",
  reorderpage: "move_page",
  duplicate_page: "duplicate_page",
  duplicatepage: "duplicate_page",
  copy_page: "duplicate_page",
  copypage: "duplicate_page",
  clone_page: "duplicate_page",
  clonepage: "duplicate_page",
  update_page_meta: "update_page_meta",
  updatepagemeta: "update_page_meta",
  set_page_meta: "update_page_meta",
  setpagemeta: "update_page_meta",
  update_site_config: "update_site_config",
  updatesiteconfig: "update_site_config",
  set_site_config: "update_site_config",
  setsiteconfig: "update_site_config"
}

export function normalizeOp(value: unknown): CanonicalOp | null {
  if (typeof value !== "string") return null
  const key = value.toLowerCase().trim().replace(/[\s-]+/g, "_")
  if ((CANONICAL_OPS as readonly string[]).includes(key)) return key as CanonicalOp
  return OP_ALIASES[key] ?? null
}

export type CommandEval = {
  expectedOps: string[]
  predictedOps: string[]
  missingOps: string[]
  unexpectedOps: string[]
  precision: number
  recall: number
  f1: number
  exactMatch: boolean
}

export function evaluateCommandMatchFromPredicted(
  expectedOps: string[] | undefined,
  predicted: string[]
): CommandEval | undefined {
  if (!expectedOps || expectedOps.length === 0) return undefined
  const expected = Array.from(
    new Set(
      expectedOps
        .map((item) => normalizeOp(item))
        .filter((item): item is CanonicalOp => !!item)
    )
  )
  if (expected.length === 0) return undefined

  const normalizedPredicted = predicted
    .map((item) => normalizeOp(item))
    .filter((item): item is CanonicalOp => !!item)
  const uniquePredicted = Array.from(new Set(normalizedPredicted))

  const predictedSet = new Set(uniquePredicted)
  const intersection = expected.filter((op) => predictedSet.has(op))
  const missing = expected.filter((op) => !predictedSet.has(op))
  const expectedSet = new Set(expected)
  const unexpected = uniquePredicted.filter((op) => !expectedSet.has(op))
  const precision = uniquePredicted.length > 0 ? intersection.length / uniquePredicted.length : 0
  const recall = expected.length > 0 ? intersection.length / expected.length : 0
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
  const exactMatch = missing.length === 0 && unexpected.length === 0

  return {
    expectedOps: expected,
    predictedOps: uniquePredicted,
    missingOps: missing,
    unexpectedOps: unexpected,
    precision,
    recall,
    f1,
    exactMatch
  }
}
