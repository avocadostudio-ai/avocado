import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { Operation } from "@ai-site-editor/shared"
import type { OrchestratorClient } from "../orchestrator-client.ts"
import { jsonResult, errorResult } from "./_helpers.ts"

const pageSlug = z.string().min(1).describe("Page slug the block lives on.")
const blockId = z.string().min(1).describe("Block instance id (from avocado-get-page).")
const listKey = z.string().min(1).describe("List-field name on the block (e.g. 'features', 'items', 'cards').")

export function registerBlockTools(server: McpServer, client: OrchestratorClient) {
  server.tool(
    "avocado-batch-apply",
    [
      "Apply an array of ops in a single atomic transaction. All ops commit together or none do, and `previewVersion` only bumps once for the whole batch. Use for multi-op flows (e.g. translating every field on a page, bulk list-item edits) instead of chaining single-op tools — avoids N round-trips and N version bumps.",
      "",
      "IMPORTANT: batch ops use the wire-format Operation schema, NOT the single-op MCP tool parameter names. Field names differ: single-op tools like `avocado-rename-page` take `slug`/`newSlug` and `avocado-update-page-meta` takes flat `title`/`description`/`ogImage`, but their batch equivalents take `pageSlug`/`newPageSlug` and `patch: { title?, description?, ogImage? }` respectively. Tip: if you're unsure about an op's exact shape, probe with a minimal 1–2 op batch before constructing a large payload.",
      "",
      "Required fields per op type:",
      "- { op: 'create_page', page: { id, slug, title, updatedAt, blocks: [{id,type,props}], meta? } }",
      "- { op: 'add_block', pageSlug, block: { id, type, props }, afterBlockId? }",
      "- { op: 'update_props', pageSlug, blockId, patch }",
      "- { op: 'remove_block', pageSlug, blockId }",
      "- { op: 'move_block', pageSlug, blockId, afterBlockId? }",
      "- { op: 'duplicate_block', pageSlug, blockId, toPageSlug?, newBlockId?, afterBlockId? }",
      "- { op: 'add_item', pageSlug, blockId, listKey, item, afterIndex? }",
      "- { op: 'update_item', pageSlug, blockId, listKey, index, patch }",
      "- { op: 'remove_item', pageSlug, blockId, listKey, index }",
      "- { op: 'move_item', pageSlug, blockId, listKey, index, afterIndex? }",
      "- { op: 'rename_page', pageSlug, newPageSlug?, newTitle? } — provide at least one of newPageSlug (different from current) or newTitle (different from current). Omit newPageSlug for title-only rename.",
      "- { op: 'remove_page', pageSlug }",
      "- { op: 'move_page', pageSlug, afterPageSlug? }",
      "- { op: 'duplicate_page', pageSlug, newPageSlug?, newTitle?, afterPageSlug? }",
      "- { op: 'update_page_meta', pageSlug, patch: { title?, description?, ogImage? } } — patch must contain at least one field whose value differs from the current meta.",
      "- { op: 'update_site_config', patch: { name?, logo?, navLabels?, navGroups? } }",
      "",
      "The whole call rejects atomically if any op fails validation. For a multi-step edit where one op is finicky, consider running the reliable bulk as a batch and the finicky one as a follow-up single-op call so a rejection on the hard op doesn't roll back the good work.",
    ].join("\n"),
    {
      ops: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .describe("Array of ops to apply atomically. Each must include an `op` discriminator and the wire-format fields required for that op type (see tool description for the per-op shape list)."),
    },
    async ({ ops }) => {
      if (!Array.isArray(ops) || ops.length === 0) {
        return errorResult(new Error("ops must be a non-empty array."))
      }
      try {
        return jsonResult(await client.applyOps(ops as Operation[]))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-add-block",
    "Insert a new block into a page. Call avocado-get-block-schema first to learn the required prop shape for the block type.",
    {
      pageSlug,
      block: z.object({
        id: z.string().min(1),
        type: z.string().min(1),
        props: z.record(z.string(), z.unknown()),
      }),
      afterBlockId: z.string().min(1).optional().describe("Insert after this block id. Omit to append at the end."),
    },
    async ({ pageSlug, block, afterBlockId }) => {
      try {
        return jsonResult(await client.applyOps([{ op: "add_block", pageSlug, block, afterBlockId }]))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-update-block-props",
    "Patch one or more props on an existing block. Only the keys in `patch` are updated; other props remain untouched.",
    {
      pageSlug,
      blockId,
      patch: z.record(z.string(), z.unknown()).describe("Partial props object. Keys must be valid for the block type."),
    },
    async ({ pageSlug, blockId, patch }) => {
      try {
        return jsonResult(await client.applyOps([{ op: "update_props", pageSlug, blockId, patch }]))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-remove-block",
    "Delete a block from a page. Undo-able from the editor history.",
    { pageSlug, blockId },
    async ({ pageSlug, blockId }) => {
      try {
        return jsonResult(await client.applyOps([{ op: "remove_block", pageSlug, blockId }]))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-move-block",
    "Reorder a block within its page. Pass afterBlockId to place it after another block, or omit to move to the top.",
    {
      pageSlug,
      blockId,
      afterBlockId: z.string().min(1).optional(),
    },
    async ({ pageSlug, blockId, afterBlockId }) => {
      try {
        return jsonResult(await client.applyOps([{ op: "move_block", pageSlug, blockId, afterBlockId }]))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-duplicate-block",
    "Duplicate a block, optionally onto a different page and/or with an explicit new id.",
    {
      pageSlug,
      blockId,
      toPageSlug: z.string().min(1).optional().describe("Target page slug (defaults to the source page)."),
      newBlockId: z.string().min(1).optional(),
      afterBlockId: z.string().min(1).optional(),
    },
    async ({ pageSlug, blockId, toPageSlug, newBlockId, afterBlockId }) => {
      try {
        return jsonResult(await client.applyOps([
          { op: "duplicate_block", pageSlug, blockId, toPageSlug, newBlockId, afterBlockId },
        ]))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  // ── List-field item ops ──

  server.tool(
    "avocado-add-list-item",
    "Append or insert an item into a block's list field (e.g. add a feature to FeatureGrid, an item to FAQAccordion).",
    {
      pageSlug,
      blockId,
      listKey,
      item: z.record(z.string(), z.unknown()),
      afterIndex: z.number().int().min(0).optional().describe("Insert after this index. Omit to append."),
    },
    async ({ pageSlug, blockId, listKey, item, afterIndex }) => {
      try {
        return jsonResult(await client.applyOps([
          { op: "add_item", pageSlug, blockId, listKey, item, afterIndex },
        ]))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-update-list-item",
    "Patch fields on one item inside a block's list field, by zero-based index.",
    {
      pageSlug,
      blockId,
      listKey,
      index: z.number().int().min(0),
      patch: z.record(z.string(), z.unknown()),
    },
    async ({ pageSlug, blockId, listKey, index, patch }) => {
      try {
        return jsonResult(await client.applyOps([
          { op: "update_item", pageSlug, blockId, listKey, index, patch },
        ]))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-remove-list-item",
    "Remove an item from a block's list field by zero-based index.",
    {
      pageSlug,
      blockId,
      listKey,
      index: z.number().int().min(0),
    },
    async ({ pageSlug, blockId, listKey, index }) => {
      try {
        return jsonResult(await client.applyOps([
          { op: "remove_item", pageSlug, blockId, listKey, index },
        ]))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-move-list-item",
    "Reorder an item inside a block's list field. Pass afterIndex to place it after another item, or omit to move to the top.",
    {
      pageSlug,
      blockId,
      listKey,
      index: z.number().int().min(0),
      afterIndex: z.number().int().min(0).optional(),
    },
    async ({ pageSlug, blockId, listKey, index, afterIndex }) => {
      try {
        return jsonResult(await client.applyOps([
          { op: "move_item", pageSlug, blockId, listKey, index, afterIndex },
        ]))
      } catch (err) {
        return errorResult(err)
      }
    }
  )
}
