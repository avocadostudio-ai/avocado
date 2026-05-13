import { allowedBlockTypes } from "@avocadostudio-ai/shared"

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
      enum: ["edit_plan", "needs_clarification", "content_answer"],
      description: "Whether this is a concrete edit plan, a clarification request, or a read-only answer about page content."
    },
    summary_for_user: {
      type: "string",
      description: "Human-readable summary of what was done. Use past tense. Use **bold** and bullet lists (- item) for readability when listing multiple points."
    },
    change_log: {
      type: "string",
      description: "Markdown summary of changes, one line per operation."
    },
    ops: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          op: { type: "string", description: "Operation name" },
          pageSlug: { type: "string" },
          blockId: { type: "string" },
          afterBlockId: { type: "string" },
          newBlockId: { type: "string" },
          toPageSlug: { type: "string" },
          newPageSlug: { type: "string" },
          newTitle: { type: "string" },
          afterPageSlug: { type: "string" },
          listKey: { type: "string" },
          index: { type: "integer" },
          afterIndex: { type: "integer" },
          patch: { type: "object" },
          block: { type: "object" },
          page: { type: "object" },
          item: { type: "object" }
        },
        required: ["op"]
      },
      description: "Array of operations. Each has 'op' plus operation-specific fields."
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
// Hand-crafted to stay within the intersection of OpenAI strict mode and
// Anthropic json_schema constraints (no propertyNames, $ref, oneOf, etc.).
// ---------------------------------------------------------------------------

function nullable(schema: Record<string, unknown>) {
  return { anyOf: [schema, { type: "null" as const }] }
}

const blockTypeEnumSchema = { type: "string" as const, enum: [...allowedBlockTypes] }

export const intentJsonSchema = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    action: { type: "string" as const, enum: ["add", "move", "update", "remove", "info", "clarify"] },
    target_block_ref: nullable({ type: "string" as const }),
    target_block_type: nullable(blockTypeEnumSchema),
    new_block_type: nullable(blockTypeEnumSchema),
    position: nullable({ type: "string" as const, enum: ["top", "bottom", "before", "after"] }),
    anchor_block_ref: nullable({ type: "string" as const }),
    summary: nullable({ type: "string" as const }),
    assumption: nullable({ type: "string" as const }),
    complexity: nullable({ type: "string" as const, enum: ["simple", "standard", "complex"] })
  },
  required: ["action", "target_block_ref", "target_block_type", "new_block_type",
    "position", "anchor_block_ref", "summary", "assumption", "complexity"] as string[]
}
