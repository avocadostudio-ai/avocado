import { z } from "zod"
import { allowedBlockTypes, type BlockType } from "@ai-site-editor/shared"

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
// Generated from intentSchemaForAI (Zod) via z.toJSONSchema().
// ---------------------------------------------------------------------------

const blockTypeEnum = z.enum(allowedBlockTypes as [BlockType, ...BlockType[]])

/** Zod schema for AI structured output — uses .nullable() so all fields are required (OpenAI strict mode). */
const intentSchemaForAI = z.object({
  action: z.enum(["add", "move", "update", "remove", "info", "clarify"]),
  target_block_ref: z.string().nullable(),
  target_block_type: blockTypeEnum.nullable(),
  new_block_type: blockTypeEnum.nullable(),
  position: z.enum(["top", "bottom", "before", "after"]).nullable(),
  anchor_block_ref: z.string().nullable(),
  patch: z.record(z.string(), z.unknown()).nullable(),
  summary: z.string().nullable(),
  assumption: z.string().nullable()
})

function stripSchemaKey(obj: Record<string, unknown>): Record<string, unknown> {
  const { $schema, ...rest } = obj
  return rest
}

export const intentJsonSchema = stripSchemaKey(
  z.toJSONSchema(intentSchemaForAI) as Record<string, unknown>
)
