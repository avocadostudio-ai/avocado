import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { EditPlan, Operation, PageDoc } from "@ai-site-editor/shared"
import { evaluateDestructiveActions } from "./destructive-action-gate.js"

function page(slug: string, blockCount: number): PageDoc {
  const blocks = Array.from({ length: blockCount }, (_, i) => ({
    id: `b_${slug}_${i}`,
    type: "RichText" as const,
    props: { markdown: `block ${i}` }
  }))
  return {
    id: `p_${slug}`,
    slug,
    title: slug,
    updatedAt: new Date().toISOString(),
    blocks
  }
}

function lookup(pages: PageDoc[]) {
  const map = new Map(pages.map((p) => [p.slug, p]))
  return (slug: string) => map.get(slug) ?? null
}

function plan(ops: Operation[]): Pick<EditPlan, "ops"> {
  return { ops }
}

describe("destructive-action-gate: tier 1", () => {
  it("passes through safe single-op plans", () => {
    const result = evaluateDestructiveActions(
      plan([{ op: "update_props", pageSlug: "/", blockId: "b_home_0", patch: { markdown: "new" } }]),
      lookup([page("/", 3)])
    )
    assert.equal(result.requiresApproval, false)
    assert.deepEqual(result.reasons, [])
  })

  it("flags remove_page when page has content", () => {
    const result = evaluateDestructiveActions(
      plan([{ op: "remove_page", pageSlug: "/about" }]),
      lookup([page("/about", 4)])
    )
    assert.equal(result.requiresApproval, true)
    assert.equal(result.reasons.length, 1)
    assert.equal(result.reasons[0].kind, "remove_page")
    if (result.reasons[0].kind === "remove_page") {
      assert.equal(result.reasons[0].slug, "/about")
      assert.equal(result.reasons[0].blockCount, 4)
    }
  })

  it("flags remove_page even for empty pages", () => {
    const result = evaluateDestructiveActions(
      plan([{ op: "remove_page", pageSlug: "/empty" }]),
      lookup([page("/empty", 0)])
    )
    assert.equal(result.requiresApproval, true)
    assert.equal(result.reasons[0].kind, "remove_page")
    if (result.reasons[0].kind === "remove_page") {
      assert.equal(result.reasons[0].blockCount, 0)
    }
  })

  it("flags multi-page plans (>1 slug touched)", () => {
    const result = evaluateDestructiveActions(
      plan([
        { op: "update_props", pageSlug: "/", blockId: "b1", patch: { foo: "bar" } },
        { op: "update_props", pageSlug: "/about", blockId: "b2", patch: { foo: "baz" } }
      ]),
      lookup([page("/", 2), page("/about", 2)])
    )
    assert.equal(result.requiresApproval, true)
    const reason = result.reasons.find((r) => r.kind === "multi_page_plan")
    assert.ok(reason)
    if (reason?.kind === "multi_page_plan") {
      assert.deepEqual(reason.slugs.sort(), ["/", "/about"])
    }
  })

  it("does not flag as multi-page when only one slug touched", () => {
    const result = evaluateDestructiveActions(
      plan([
        { op: "update_props", pageSlug: "/", blockId: "b1", patch: { foo: "bar" } },
        { op: "update_props", pageSlug: "/", blockId: "b2", patch: { foo: "baz" } }
      ]),
      lookup([page("/", 2)])
    )
    assert.equal(result.requiresApproval, false)
  })

  it("flags bulk remove_block when count >= 3", () => {
    const result = evaluateDestructiveActions(
      plan([
        { op: "remove_block", pageSlug: "/", blockId: "b_/_0" },
        { op: "remove_block", pageSlug: "/", blockId: "b_/_1" },
        { op: "remove_block", pageSlug: "/", blockId: "b_/_2" }
      ]),
      lookup([page("/", 10)])
    )
    assert.equal(result.requiresApproval, true)
    const reason = result.reasons.find((r) => r.kind === "bulk_remove_blocks")
    assert.ok(reason)
    if (reason?.kind === "bulk_remove_blocks") {
      assert.equal(reason.totalRemoveOps, 3)
    }
  })

  it("does not flag as bulk for 2 remove_block ops", () => {
    const result = evaluateDestructiveActions(
      plan([
        { op: "remove_block", pageSlug: "/", blockId: "b_/_0" },
        { op: "remove_block", pageSlug: "/", blockId: "b_/_1" }
      ]),
      lookup([page("/", 10)])
    )
    // 2 of 10 = 20%, not majority wipe; 2 < 3 so not bulk.
    assert.equal(result.requiresApproval, false)
  })

  it("flags majority-wipe when removing >50% of a page's blocks", () => {
    // 2 of 3 blocks = 66% > 50%, should flag even though < bulk threshold
    const result = evaluateDestructiveActions(
      plan([
        { op: "remove_block", pageSlug: "/", blockId: "b_/_0" },
        { op: "remove_block", pageSlug: "/", blockId: "b_/_1" }
      ]),
      lookup([page("/", 3)])
    )
    assert.equal(result.requiresApproval, true)
    const reason = result.reasons.find((r) => r.kind === "majority_page_wipe")
    assert.ok(reason)
    if (reason?.kind === "majority_page_wipe") {
      assert.equal(reason.slug, "/")
      assert.equal(reason.removing, 2)
      assert.equal(reason.total, 3)
    }
  })

  it("does not flag majority-wipe when removing exactly 50%", () => {
    // Ratio must be strictly > 50%
    const result = evaluateDestructiveActions(
      plan([
        { op: "remove_block", pageSlug: "/", blockId: "b_/_0" },
        { op: "remove_block", pageSlug: "/", blockId: "b_/_1" }
      ]),
      lookup([page("/", 4)])
    )
    assert.equal(result.requiresApproval, false)
  })

  it("stacks reasons when multiple tier-1 triggers fire together", () => {
    // remove_page on content + multi-page plan (add_block on /about)
    const result = evaluateDestructiveActions(
      plan([
        { op: "remove_page", pageSlug: "/old" },
        {
          op: "add_block",
          pageSlug: "/about",
          block: { id: "b_new", type: "CTA", props: { title: "x", description: "y", ctaText: "Go", ctaHref: "/" } }
        }
      ]),
      lookup([page("/old", 2), page("/about", 1)])
    )
    assert.equal(result.requiresApproval, true)
    assert.ok(result.reasons.some((r) => r.kind === "remove_page"))
    assert.ok(result.reasons.some((r) => r.kind === "multi_page_plan"))
    assert.equal(result.messages.length, result.reasons.length)
  })

  it("treats duplicate_page with newPageSlug as multi-page", () => {
    const result = evaluateDestructiveActions(
      plan([{ op: "duplicate_page", pageSlug: "/about", newPageSlug: "/about-copy" }]),
      lookup([page("/about", 1)])
    )
    // /about + /about-copy = 2 slugs touched
    assert.ok(result.reasons.some((r) => r.kind === "multi_page_plan"))
  })

  it("messages are non-empty and readable", () => {
    const result = evaluateDestructiveActions(
      plan([{ op: "remove_page", pageSlug: "/about" }]),
      lookup([page("/about", 3)])
    )
    assert.equal(result.messages.length, 1)
    assert.match(result.messages[0], /undo this later/)
  })
})
