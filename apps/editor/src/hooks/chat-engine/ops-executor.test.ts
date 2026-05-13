import test from "node:test"
import assert from "node:assert/strict"
import type { Operation } from "@avocadostudio-ai/shared"
import {
  buildInlineEditOperation,
  planApplyOpsUiSync,
  structuralEditGuard,
  type SelectionSyncDeps,
  syncFocusState
} from "./ops-executor"

test("planApplyOpsUiSync returns patch transport on applied response with preview version", () => {
  const patchOp = { op: "move_block", pageSlug: "/", blockId: "b1" } as Operation
  const planned = planApplyOpsUiSync({
    resOk: true,
    data: { status: "applied", previewVersion: 11, focusBlockId: "b1" },
    fallbackSummary: "Could not reorder blocks.",
    patchTransportEnabled: true,
    patchOp
  })

  assert.equal(planned.ok, true)
  if (!planned.ok) return
  assert.equal(planned.transport.kind, "patch")
  if (planned.transport.kind !== "patch") return
  assert.equal(planned.transport.fromVersion, 10)
  assert.equal(planned.transport.toVersion, 11)
  assert.equal(planned.transport.focusBlockId, "b1")
})

test("planApplyOpsUiSync falls back to draftUpdated when patch transport cannot be used", () => {
  const planned = planApplyOpsUiSync({
    resOk: true,
    data: { status: "applied" },
    fallbackSummary: "Could not delete block.",
    fallbackFocusBlockId: "b2",
    patchTransportEnabled: true
  })

  assert.equal(planned.ok, true)
  if (!planned.ok) return
  assert.equal(planned.transport.kind, "draft")
  assert.equal(planned.focusBlockId, "b2")
})

test("planApplyOpsUiSync maps non-applied response to assistant error", () => {
  const planned = planApplyOpsUiSync({
    resOk: false,
    data: { status: "error", error: "boom", changes: ["x"] },
    fallbackSummary: "Could not apply inline edit.",
    patchTransportEnabled: true
  })

  assert.equal(planned.ok, false)
  if (planned.ok) return
  assert.equal(planned.assistant.status, "error")
  assert.equal(planned.assistant.summary, "boom")
  assert.deepEqual(planned.assistant.changes, ["x"])
})

test("structuralEditGuard blocks operation and rate-limits notices", () => {
  const first = structuralEditGuard({
    allowStructuralEdits: false,
    action: "add a block",
    reason: "manifest missing",
    lastNoticeAt: 0,
    now: 5000
  })
  assert.equal(first.allowed, false)
  assert.ok(first.notice)

  const second = structuralEditGuard({
    allowStructuralEdits: false,
    action: "add a block",
    reason: "manifest missing",
    lastNoticeAt: first.nextLastNoticeAt,
    now: 5500
  })
  assert.equal(second.allowed, false)
  assert.equal(second.notice, null)
})

test("buildInlineEditOperation returns update_item for indexed path and update_props for scalar path", () => {
  const indexed = buildInlineEditOperation("/", "b_hero", "items[2].title", "New")
  assert.ok(indexed)
  assert.equal(indexed?.patchOp.op, "update_item")

  const scalar = buildInlineEditOperation("/", "b_hero", "headline", "Hi")
  assert.ok(scalar)
  assert.equal(scalar?.patchOp.op, "update_props")

  const invalid = buildInlineEditOperation("/", "b_hero", "items[bad].title", "X")
  assert.equal(invalid, null)
})

test("syncFocusState updates refs and setters consistently", () => {
  const deps: SelectionSyncDeps = {
    activeBlockIdRef: { current: undefined },
    activeBlockTypeRef: { current: undefined },
    activeEditablePathRef: { current: undefined },
    setActiveBlockId: (id) => { deps.activeBlockIdRef.current = id },
    setActiveBlockType: (value) => { deps.activeBlockTypeRef.current = value },
    setActiveEditablePath: (value) => { deps.activeEditablePathRef.current = value }
  }

  syncFocusState({ deps, focusBlockId: "b3", blockType: "Hero", editablePath: "headline" })
  assert.equal(deps.activeBlockIdRef.current, "b3")
  assert.equal(deps.activeBlockTypeRef.current, "Hero")
  assert.equal(deps.activeEditablePathRef.current, "headline")

  syncFocusState({ deps, focusBlockId: null, clearSelection: true })
  assert.equal(deps.activeBlockIdRef.current, undefined)
  assert.equal(deps.activeBlockTypeRef.current, undefined)
  assert.equal(deps.activeEditablePathRef.current, undefined)
})
