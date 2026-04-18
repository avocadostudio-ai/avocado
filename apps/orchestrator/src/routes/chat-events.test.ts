import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { chatStreamEventSchema } from "@ai-site-editor/shared"

// Conformance test: every SSE frame emitted by apps/orchestrator/src/routes/chat.ts
// must parse under the shared Zod schema. The fixtures below mirror the exact emit
// call shapes in that file — if a new event type is added or a field is renamed,
// update both the schema (packages/shared/src/chat-events.ts) and this fixture.

const representativeFrames: Record<string, unknown> = {
  status: { type: "status", message: "Planning edits..." },
  heartbeat: {
    type: "heartbeat",
    stage: "planning",
    label: "Planning",
    elapsedMs: 1234,
  },
  token: { type: "token", text: "chunk of planning tokens" },
  field_draft: {
    type: "field_draft",
    blockId: "blk_1",
    editablePath: "title",
    value: "New heading",
  },
  summary_token: { type: "summary_token", text: "partial summary" },
  changelog_entry: { type: "changelog_entry", entry: "Updated hero heading" },
  op_candidate: {
    type: "op_candidate",
    index: 0,
    op: { op: "update_props", blockId: "blk_1", patch: { title: "New" } },
  },
  op_skipped: {
    type: "op_skipped",
    index: 1,
    total: 3,
    op: { op: "update_props", blockId: "blk_1", patch: {} },
    reason: "no_op",
  },
  plan_meta: {
    type: "plan_meta",
    intent: "edit_plan",
    summary: "Update hero heading",
    estimatedOps: 1,
  },
  op_applied: {
    type: "op_applied",
    index: 1,
    total: 1,
    op: { op: "update_props", blockId: "blk_1", patch: { title: "New" } },
    previewVersion: 42,
    focusBlockId: "blk_1",
    updatedSlug: "/home",
  },
  op_applied_null_focus: {
    type: "op_applied",
    index: 1,
    total: 1,
    previewVersion: 42,
    focusBlockId: null,
  },
  rollback_started: {
    type: "rollback_started",
    appliedCount: 2,
    reason: "validation_failed",
  },
  rollback_done: { type: "rollback_done", restoredVersion: 40 },
  image_progress: { type: "image_progress", percent: 50, stage: "fetching" },
  final: {
    type: "final",
    result: {
      status: "ok",
      summary: "Updated the hero heading.",
      changes: ["Changed title to 'New'"],
    },
  },
  error: {
    type: "error",
    result: { error: "Planner timed out" },
    code: 500,
  },
  canceled: { type: "canceled", message: "Run was canceled." },
}

describe("chat SSE frame conformance", () => {
  for (const [name, frame] of Object.entries(representativeFrames)) {
    it(`parses ${name} frame`, () => {
      const result = chatStreamEventSchema.safeParse(frame)
      if (!result.success) {
        assert.fail(`${name} did not parse: ${JSON.stringify(result.error.issues)}`)
      }
    })
  }

  it("rejects unknown event type", () => {
    const result = chatStreamEventSchema.safeParse({ type: "not_a_real_event" })
    assert.equal(result.success, false)
  })

  it("rejects frame missing required field", () => {
    const result = chatStreamEventSchema.safeParse({ type: "status" })
    assert.equal(result.success, false)
  })
})
