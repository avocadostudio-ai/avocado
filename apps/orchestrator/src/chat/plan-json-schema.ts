// ---------------------------------------------------------------------------
// JSON Schema for EditPlan — used as Anthropic tool_use input_schema and
// OpenAI json_schema response_format.
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
        additionalProperties: false,
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

// ---------------------------------------------------------------------------
// JSON Schema for intent parsing — used with output_config.format for
// constrained decoding (guaranteed valid JSON matching this schema).
// ---------------------------------------------------------------------------

export const intentJsonSchema = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["add", "move", "update", "remove", "info", "clarify"],
      description: "The editing action to perform."
    },
    target_block_ref: {
      type: ["string", "null"] as const,
      description: "Block ID or type reference to target (e.g. 'b_hero1' or 'hero')."
    },
    target_block_type: {
      type: ["string", "null"] as const,
      description: "Block type to target (e.g. 'Hero', 'CTA')."
    },
    new_block_type: {
      type: ["string", "null"] as const,
      description: "Block type to add (e.g. 'Hero', 'FAQAccordion')."
    },
    position: {
      type: ["string", "null"] as const,
      enum: ["top", "bottom", "before", "after", null],
      description: "Placement position for add/move operations."
    },
    anchor_block_ref: {
      type: ["string", "null"] as const,
      description: "Block ID or type reference for relative positioning."
    },
    patch: {
      type: ["object", "null"] as const,
      description: "Partial props to update on the target block."
    },
    summary: {
      type: ["string", "null"] as const,
      description: "Brief summary of the intended action."
    },
    assumption: {
      type: ["string", "null"] as const,
      description: "Any assumption made about an ambiguous request."
    }
  },
  required: [
    "action",
    "target_block_ref",
    "target_block_type",
    "new_block_type",
    "position",
    "anchor_block_ref",
    "patch",
    "summary",
    "assumption"
  ] as string[]
} as const
