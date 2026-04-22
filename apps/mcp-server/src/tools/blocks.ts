import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { OrchestratorClient } from "../orchestrator-client.ts"
import { jsonResult, errorResult } from "./_helpers.ts"

const pageSlug = z.string().min(1).describe("Page slug the block lives on.")
const blockId = z.string().min(1).describe("Block instance id (from avocado-get-page).")
const listKey = z.string().min(1).describe("List-field name on the block (e.g. 'features', 'items', 'cards').")

export function registerBlockTools(server: McpServer, client: OrchestratorClient) {
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
