import { z } from "zod"

// ---------------------------------------------------------------------------
// Shared orchestrator API response schemas
// Used by the editor to validate fetch() responses at runtime.
// All schemas are lenient (passthrough extra fields) so they survive server
// additions without requiring client deployments.
// ---------------------------------------------------------------------------

const continuationSchema = z.object({
  chainId: z.string(),
  currentStep: z.number(),
  totalSteps: z.number(),
  nextStepLabel: z.string(),
}).passthrough()

const variationOptionSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  patch: z.record(z.unknown()),
  changedKeys: z.array(z.string()),
}).passthrough()

const variationsSchema = z.object({
  blockId: z.string(),
  blockType: z.string(),
  pageSlug: z.string(),
  baseProps: z.record(z.unknown()),
  options: z.array(variationOptionSchema),
}).passthrough()

export const assistantResponseSchema = z.object({
  status: z.string().optional(),
  summary: z.string().optional(),
  changes: z.array(z.string()).optional(),
  mentionedSlugs: z.array(z.string()).optional(),
  previewVersion: z.number().optional(),
  validationErrors: z.union([
    z.array(z.string()),
    z.object({
      fieldErrors: z.record(z.array(z.string())).optional(),
      formErrors: z.array(z.string()).optional(),
    }).passthrough(),
  ]).optional(),
  modelUsed: z.string().optional(),
  modelKey: z.string().optional(),
  plannerSource: z.enum(["openai", "anthropic", "gemini", "demo"]).optional(),
  pendingPlanId: z.string().optional(),
  destructiveReasons: z.array(z.string()).optional(),
  continuation: continuationSchema.optional(),
  focusBlockId: z.string().optional(),
  updatedSlug: z.string().optional(),
  undoSlug: z.string().optional(),
  suggestions: z.array(z.string()).optional(),
  variations: variationsSchema.optional(),
  debug: z.record(z.unknown()).optional(),
  error: z.string().optional(),
}).passthrough()

export type AssistantResponseParsed = z.infer<typeof assistantResponseSchema>

export const chatStartResponseSchema = z.object({
  streamId: z.string().optional(),
  error: z.string().optional(),
}).passthrough()

export const slugsResponseSchema = z.object({
  slugs: z.array(z.string()).optional(),
}).passthrough()

export const bootstrapResponseSchema = z.object({
  slugs: z.array(z.string()).optional(),
}).passthrough()

export const cancelResponseSchema = z.object({
  status: z.string().optional(),
  error: z.string().optional(),
}).passthrough()
