import { z } from "zod"
import { operationSchema } from "./schemas.ts"

const assistantResponseLike = z.looseObject({
  status: z.string().optional(),
  summary: z.string().optional(),
  changes: z.array(z.string()).optional(),
  suggestions: z.array(z.string()).optional(),
  previewVersion: z.number().optional(),
  focusBlockId: z.string().nullable().optional(),
  updatedSlug: z.string().optional(),
  error: z.string().optional(),
  debug: z.looseObject({}).optional(),
})

const statusEvent = z.object({
  type: z.literal("status"),
  message: z.string(),
})

const heartbeatEvent = z.object({
  type: z.literal("heartbeat"),
  stage: z.string(),
  label: z.string(),
  elapsedMs: z.number(),
})

const tokenEvent = z.object({
  type: z.literal("token"),
  text: z.string(),
})

const fieldDraftEvent = z.object({
  type: z.literal("field_draft"),
  blockId: z.string(),
  editablePath: z.string(),
  value: z.string(),
})

const summaryTokenEvent = z.object({
  type: z.literal("summary_token"),
  text: z.string(),
})

const changelogEntryEvent = z.object({
  type: z.literal("changelog_entry"),
  entry: z.string(),
})

const opCandidateEvent = z.object({
  type: z.literal("op_candidate"),
  index: z.number(),
  op: operationSchema.or(z.looseObject({})),
})

const opSkippedEvent = z.object({
  type: z.literal("op_skipped"),
  index: z.number(),
  total: z.number(),
  op: operationSchema.or(z.looseObject({})).optional(),
  reason: z.string().optional(),
})

const planMetaEvent = z.object({
  type: z.literal("plan_meta"),
  intent: z.string().optional(),
  summary: z.string().optional(),
  estimatedOps: z.number().optional(),
})

const opAppliedEvent = z.object({
  type: z.literal("op_applied"),
  index: z.number(),
  total: z.number(),
  op: operationSchema.or(z.looseObject({})).optional(),
  previewVersion: z.number(),
  focusBlockId: z.string().nullable().optional(),
  updatedSlug: z.string().optional(),
})

const rollbackStartedEvent = z.object({
  type: z.literal("rollback_started"),
  appliedCount: z.number(),
  reason: z.string().optional(),
})

const rollbackDoneEvent = z.object({
  type: z.literal("rollback_done"),
  restoredVersion: z.number().optional(),
})

const imageProgressEvent = z.object({
  type: z.literal("image_progress"),
  percent: z.number().optional(),
  stage: z.string().optional(),
}).loose()

const finalEvent = z.object({
  type: z.literal("final"),
  result: assistantResponseLike,
})

const errorEvent = z.object({
  type: z.literal("error"),
  result: assistantResponseLike.optional(),
  code: z.number().optional(),
})

const canceledEvent = z.object({
  type: z.literal("canceled"),
  message: z.string().optional(),
})

export const chatStreamEventSchema = z.discriminatedUnion("type", [
  statusEvent,
  heartbeatEvent,
  tokenEvent,
  fieldDraftEvent,
  summaryTokenEvent,
  changelogEntryEvent,
  opCandidateEvent,
  opSkippedEvent,
  planMetaEvent,
  opAppliedEvent,
  rollbackStartedEvent,
  rollbackDoneEvent,
  imageProgressEvent,
  finalEvent,
  errorEvent,
  canceledEvent,
])

export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>
export type ChatStreamEventType = ChatStreamEvent["type"]

export type ChatStreamFrame = ChatStreamEvent & { _seq?: number }

export function parseChatStreamFrame(raw: unknown): ChatStreamFrame | null {
  const parsed = chatStreamEventSchema.safeParse(raw)
  if (!parsed.success) return null
  const seq = (raw as { _seq?: unknown })?._seq
  return typeof seq === "number"
    ? ({ ...parsed.data, _seq: seq } as ChatStreamFrame)
    : (parsed.data as ChatStreamFrame)
}
