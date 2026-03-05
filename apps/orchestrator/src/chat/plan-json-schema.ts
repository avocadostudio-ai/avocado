// ---------------------------------------------------------------------------
// JSON Schema for EditPlan — used as Anthropic tool_use input_schema
// ---------------------------------------------------------------------------
// Intentionally loose on the ops array: the downstream normalizePlanCandidate +
// Zod editPlanSchema validation handles strict validation and repair. Keeping
// the schema simple avoids the model fighting overly-rigid constraints while
// still guaranteeing we get structured JSON instead of prose.
// ---------------------------------------------------------------------------

export const editPlanJsonSchema = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    intent: {
      type: "string",
      enum: ["edit_plan", "needs_clarification"],
      description: "Whether this is a concrete edit plan or a clarification request."
    },
    summary_for_user: {
      type: "string",
      description: "Short human-readable summary of what the plan will do. Use future tense."
    },
    change_log: {
      type: "array",
      items: { type: "string" },
      description: "One entry per operation describing what that op does."
    },
    ops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          op: {
            type: "string",
            description: "Operation name, e.g. add_block, update_props, remove_block, etc."
          }
        },
        required: ["op"]
      },
      description: "Array of operations to apply. Each must have an 'op' field."
    },
    suggested_next_actions: {
      type: "array",
      items: { type: "string" },
      description: "2-4 short imperative phrases the user could type next."
    }
  },
  required: ["intent", "summary_for_user", "change_log", "ops"] as string[]
} as const
