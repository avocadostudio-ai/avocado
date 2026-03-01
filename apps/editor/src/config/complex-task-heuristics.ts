export const COMPLEX_TASK_HEURISTICS = {
  minCharsForComplex: 180,
  minActionsWithConnector: 2,
  minConnectorsForActionRule: 1,
  minActionsAny: 3,
  minActionsWithClauses: 2,
  minClausesForActionRule: 2,
  actionKeywords: ["add", "remove", "delete", "replace", "move", "duplicate", "rename", "create", "rewrite", "update", "change", "reorder", "insert"],
  connectorKeywords: ["and", "then", "also", "after", "before", "while", "plus"]
} as const
