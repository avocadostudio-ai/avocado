/**
 * Agent tool definitions for Anthropic tool-use.
 * These are the tools Claude can call to modify the website.
 *
 * Three categories:
 * 1. Compound tools (edit_page, batch_update_props, add_block_with_content)
 * 2. Atomic tools (remove_block, move_block, create_page, etc.)
 * 3. Read-only context tools (get_page, list_pages, get_block_schema)
 */

import type Anthropic from "@anthropic-ai/sdk"
import { type Operation, type PageDoc, type BlockManifest, defaultPropsForType, type BlockType } from "@ai-site-editor/shared"
import { applyOpsAtomically, type ApplyOpsOptions } from "../ops/ops-engine.js"
import { getPage, getSessionDraft, bumpVersion, orderSlugsHomeFirst } from "../state/session-state.js"

type ToolHandler = (input: Record<string, unknown>) => Promise<{ result: string; isError?: boolean }>

export type AgentTool = {
  definition: Anthropic.Messages.Tool
  handler: ToolHandler
}

/**
 * Create all agent tools bound to a specific session.
 */
export function createAgentTools(session: string, options?: { manifest?: BlockManifest }): AgentTool[] {
  const applyOpts: ApplyOpsOptions = options?.manifest ? { componentsManifest: options.manifest } : {}

  // Helper: apply ops and return result
  async function applyOps(ops: Operation[]): Promise<{ result: string; isError?: boolean }> {
    try {
      const result = await applyOpsAtomically(session, ops, applyOpts)
      const version = bumpVersion(session)
      return {
        result: JSON.stringify({
          status: "applied",
          appliedCount: result.appliedCount,
          previewVersion: version,
          skippedOps: result.skippedOps,
        })
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { result: `Error: ${msg}`, isError: true }
    }
  }

  return [
    // ================================================================
    // COMPOUND TOOLS
    // ================================================================

    {
      definition: {
        name: "edit_page",
        description: "Apply multiple operations to a page atomically. All operations succeed or all roll back. Use this for multi-step edits like rewriting multiple blocks, adding and configuring a block, or restructuring a page.",
        input_schema: {
          type: "object" as const,
          properties: {
            pageSlug: { type: "string", description: "Page slug, e.g. '/' or '/pricing'" },
            operations: {
              type: "array",
              description: "Array of operations to apply atomically",
              items: {
                type: "object",
                properties: {
                  op: { type: "string", enum: ["update_props", "add_block", "remove_block", "move_block", "add_item", "update_item", "remove_item", "move_item"] },
                  blockId: { type: "string" },
                  patch: { type: "object", description: "For update_props: key-value pairs to update" },
                  block: { type: "object", description: "For add_block: { id, type, props }", properties: { id: { type: "string" }, type: { type: "string" }, props: { type: "object" } } },
                  afterBlockId: { type: "string", description: "For add_block/move_block: insert after this block" },
                  listKey: { type: "string", description: "For item ops: array prop name" },
                  index: { type: "number", description: "For item ops: item index" },
                  item: { type: "object", description: "For add_item: item data" },
                  afterIndex: { type: "number", description: "For move_item: target position" },
                },
                required: ["op"],
              },
            },
          },
          required: ["pageSlug", "operations"],
        },
      },
      handler: async (input) => {
        const pageSlug = input.pageSlug as string
        const operations = (input.operations as Array<Record<string, unknown>>).map((op) => ({
          ...op,
          pageSlug,
        })) as unknown as Operation[]
        return applyOps(operations)
      },
    },

    {
      definition: {
        name: "batch_update_props",
        description: "Update multiple properties on a single block. Use this for text edits — e.g. updating heading, subheading, and CTA text on a Hero block in one call.",
        input_schema: {
          type: "object" as const,
          properties: {
            pageSlug: { type: "string", description: "Page slug" },
            blockId: { type: "string", description: "Block ID to update" },
            patch: { type: "object", description: "Key-value pairs of properties to update. E.g. { heading: 'New Title', subheading: 'New subtitle' }" },
          },
          required: ["pageSlug", "blockId", "patch"],
        },
      },
      handler: async (input) => {
        const op: Operation = {
          op: "update_props",
          pageSlug: input.pageSlug as string,
          blockId: input.blockId as string,
          patch: input.patch as Record<string, unknown>,
        }
        return applyOps([op])
      },
    },

    {
      definition: {
        name: "add_block_with_content",
        description: "Add a new block to a page with populated content. Generates a unique block ID automatically. Available block types: Hero, FeatureGrid, Testimonials, FAQAccordion, CTA, Card, CardGrid, RichText, Stats, TwoColumn, Banner, Carousel, Gallery, Tabs, Table, Quote, Video, Embed.",
        input_schema: {
          type: "object" as const,
          properties: {
            pageSlug: { type: "string", description: "Page slug" },
            blockType: { type: "string", description: "Block type (PascalCase), e.g. 'FAQAccordion', 'Hero', 'FeatureGrid'" },
            props: { type: "object", description: "Block properties. Use get_block_schema to see available props for each type." },
            afterBlockId: { type: "string", description: "Insert after this block. Omit to append at end." },
          },
          required: ["pageSlug", "blockType", "props"],
        },
      },
      handler: async (input) => {
        const blockType = input.blockType as string
        const safeType = blockType.toLowerCase().replace(/[^a-z0-9]+/g, "_")
        const blockId = `b_${safeType}_${Date.now()}_${Math.floor(Math.random() * 1000)}`
        const props = input.props as Record<string, unknown>
        const defaults = defaultPropsForType(blockType as BlockType)
        const mergedProps = { ...defaults, ...props }

        const op: Record<string, unknown> = {
          op: "add_block",
          pageSlug: input.pageSlug as string,
          block: { id: blockId, type: blockType, props: mergedProps },
        }
        if (input.afterBlockId) op.afterBlockId = input.afterBlockId

        return applyOps([op as unknown as Operation])
      },
    },

    // ================================================================
    // ATOMIC TOOLS
    // ================================================================

    {
      definition: {
        name: "remove_block",
        description: "Remove a block from a page.",
        input_schema: {
          type: "object" as const,
          properties: {
            pageSlug: { type: "string" },
            blockId: { type: "string" },
          },
          required: ["pageSlug", "blockId"],
        },
      },
      handler: async (input) => applyOps([{ op: "remove_block", pageSlug: input.pageSlug as string, blockId: input.blockId as string }]),
    },

    {
      definition: {
        name: "move_block",
        description: "Move a block to a new position on the page. Set afterBlockId to place it after a specific block, or omit to move to the top.",
        input_schema: {
          type: "object" as const,
          properties: {
            pageSlug: { type: "string" },
            blockId: { type: "string" },
            afterBlockId: { type: "string", description: "Place after this block. Omit to move to top." },
          },
          required: ["pageSlug", "blockId"],
        },
      },
      handler: async (input) => {
        const op: Record<string, unknown> = { op: "move_block", pageSlug: input.pageSlug, blockId: input.blockId }
        if (input.afterBlockId) op.afterBlockId = input.afterBlockId
        return applyOps([op as unknown as Operation])
      },
    },

    {
      definition: {
        name: "create_page",
        description: "Create a new page with blocks.",
        input_schema: {
          type: "object" as const,
          properties: {
            slug: { type: "string", description: "Page slug, e.g. '/pricing'" },
            title: { type: "string" },
            blocks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  type: { type: "string" },
                  props: { type: "object" },
                },
                required: ["id", "type", "props"],
              },
            },
          },
          required: ["slug", "title", "blocks"],
        },
      },
      handler: async (input) => {
        const page = {
          slug: input.slug as string,
          title: input.title as string,
          blocks: (input.blocks as Array<{ id: string; type: string; props: Record<string, unknown> }>),
        } as PageDoc
        return applyOps([{ op: "create_page", page }])
      },
    },

    {
      definition: {
        name: "rename_page",
        description: "Rename a page (change its slug and/or title).",
        input_schema: {
          type: "object" as const,
          properties: {
            pageSlug: { type: "string" },
            newPageSlug: { type: "string" },
            newTitle: { type: "string" },
          },
          required: ["pageSlug", "newPageSlug"],
        },
      },
      handler: async (input) => applyOps([{
        op: "rename_page",
        pageSlug: input.pageSlug as string,
        newPageSlug: input.newPageSlug as string,
        ...(input.newTitle ? { newTitle: input.newTitle as string } : {}),
      }]),
    },

    {
      definition: {
        name: "remove_page",
        description: "Delete a page.",
        input_schema: {
          type: "object" as const,
          properties: { pageSlug: { type: "string" } },
          required: ["pageSlug"],
        },
      },
      handler: async (input) => applyOps([{ op: "remove_page", pageSlug: input.pageSlug as string }]),
    },

    // ================================================================
    // READ-ONLY CONTEXT TOOLS
    // ================================================================

    {
      definition: {
        name: "get_page",
        description: "Get the full content of a page — all blocks with their properties. Use this to inspect the current state before making edits.",
        input_schema: {
          type: "object" as const,
          properties: {
            pageSlug: { type: "string", description: "Page slug, e.g. '/' or '/pricing'" },
          },
          required: ["pageSlug"],
        },
      },
      handler: async (input) => {
        const page = getPage(session, input.pageSlug as string)
        if (!page) return { result: `Page "${input.pageSlug}" not found`, isError: true }
        return {
          result: JSON.stringify({
            slug: page.slug,
            title: page.title,
            blocks: page.blocks.map((b) => ({
              id: b.id,
              type: b.type,
              props: b.props,
            })),
          }, null, 2),
        }
      },
    },

    {
      definition: {
        name: "list_pages",
        description: "List all pages in the site with their titles and block counts.",
        input_schema: {
          type: "object" as const,
          properties: {},
        },
      },
      handler: async () => {
        const draft = getSessionDraft(session)
        const slugs = orderSlugsHomeFirst(Array.from(draft.keys()))
        const pages = slugs.map((slug: string) => {
          const page = getPage(session, slug)
          return {
            slug,
            title: page?.title ?? "(untitled)",
            blockCount: page?.blocks.length ?? 0,
            blockTypes: page?.blocks.map((b) => b.type) ?? [],
          }
        })
        return { result: JSON.stringify(pages, null, 2) }
      },
    },

    {
      definition: {
        name: "get_block_schema",
        description: "Get the property schema for a block type. Shows all available properties, their types, and which are required.",
        input_schema: {
          type: "object" as const,
          properties: {
            blockType: { type: "string", description: "Block type name (PascalCase), e.g. 'Hero', 'FAQAccordion'" },
          },
          required: ["blockType"],
        },
      },
      handler: async (input) => {
        const blockType = input.blockType as string
        const defaults = defaultPropsForType(blockType as BlockType)
        return {
          result: JSON.stringify({
            type: blockType,
            defaultProps: defaults,
            hint: "These are the default props. The actual schema may accept additional fields. Use the default props structure as a guide.",
          }, null, 2),
        }
      },
    },
  ]
}
