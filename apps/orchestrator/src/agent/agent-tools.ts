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
import { applyOpsAtomically, pickFocusBlockId, type ApplyOpsOptions } from "../ops/ops-engine.js"
import { getPage, getSessionDraft, bumpVersion, orderSlugsHomeFirst, getSiteConfig } from "../state/session-state.js"
import { unsplashSearchHandler, unsplashSearchManifest } from "../tools/builtins/unsplash-search.js"
import { unsplashGetByIdHandler, unsplashGetByIdManifest } from "../tools/builtins/unsplash-get-by-id.js"
import { imageGenerateHandler, imageGenerateManifest } from "../tools/builtins/image-generate.js"
import type { ToolCallContext } from "../tools/types.js"

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
      console.log("[agent-tools] Applying ops:", JSON.stringify(ops.map(o => o.op)))
      const result = await applyOpsAtomically(session, ops, applyOpts)
      console.log("[agent-tools] Applied successfully:", result.appliedCount)
      const version = bumpVersion(session)
      const focusBlockId = pickFocusBlockId(ops)
      return {
        result: JSON.stringify({
          status: "applied",
          appliedCount: result.appliedCount,
          previewVersion: version,
          focusBlockId,
          skippedOps: result.skippedOps,
          slugs: extractSlugsFromOps(ops),
        })
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { result: `Error: ${msg}`, isError: true }
    }
  }

  function extractSlugsFromOps(ops: Operation[]): string[] {
    const slugs = new Set<string>()
    for (const op of ops as Array<Record<string, unknown>>) {
      if (typeof op.pageSlug === "string") slugs.add(op.pageSlug)
      if (typeof op.newPageSlug === "string") slugs.add(op.newPageSlug)
      if (typeof op.toPageSlug === "string") slugs.add(op.toPageSlug)
      const page = op.page
      if (page && typeof page === "object" && typeof (page as Record<string, unknown>).slug === "string") {
        slugs.add((page as Record<string, unknown>).slug as string)
      }
    }
    return Array.from(slugs)
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

    {
      definition: {
        name: "duplicate_block",
        description: "Clone a block. Optionally place the copy on a different page or after a specific block.",
        input_schema: {
          type: "object" as const,
          properties: {
            pageSlug: { type: "string" },
            blockId: { type: "string", description: "Block to duplicate" },
            toPageSlug: { type: "string", description: "Target page (omit for same page)" },
            afterBlockId: { type: "string", description: "Place copy after this block" },
          },
          required: ["pageSlug", "blockId"],
        },
      },
      handler: async (input) => {
        const op: Record<string, unknown> = { op: "duplicate_block", pageSlug: input.pageSlug, blockId: input.blockId }
        if (input.toPageSlug) op.toPageSlug = input.toPageSlug
        if (input.afterBlockId) op.afterBlockId = input.afterBlockId
        return applyOps([op as unknown as Operation])
      },
    },

    {
      definition: {
        name: "duplicate_page",
        description: "Clone a page with all its blocks.",
        input_schema: {
          type: "object" as const,
          properties: {
            pageSlug: { type: "string", description: "Page to duplicate" },
            newPageSlug: { type: "string", description: "Slug for the copy (e.g. '/pricing-v2')" },
            newTitle: { type: "string", description: "Title for the copy" },
          },
          required: ["pageSlug"],
        },
      },
      handler: async (input) => {
        const op: Record<string, unknown> = { op: "duplicate_page", pageSlug: input.pageSlug }
        if (input.newPageSlug) op.newPageSlug = input.newPageSlug
        if (input.newTitle) op.newTitle = input.newTitle
        return applyOps([op as unknown as Operation])
      },
    },

    {
      definition: {
        name: "move_page",
        description: "Reorder a page in the site navigation. Set afterPageSlug to place it after a specific page, or omit to move to the top.",
        input_schema: {
          type: "object" as const,
          properties: {
            pageSlug: { type: "string" },
            afterPageSlug: { type: "string", description: "Place after this page. Omit to move to top." },
          },
          required: ["pageSlug"],
        },
      },
      handler: async (input) => {
        const op: Record<string, unknown> = { op: "move_page", pageSlug: input.pageSlug }
        if (input.afterPageSlug) op.afterPageSlug = input.afterPageSlug
        return applyOps([op as unknown as Operation])
      },
    },

    {
      definition: {
        name: "update_page_meta",
        description: "Update page SEO metadata — title, description, and Open Graph image.",
        input_schema: {
          type: "object" as const,
          properties: {
            pageSlug: { type: "string" },
            patch: {
              type: "object",
              description: "SEO fields to update",
              properties: {
                title: { type: "string", description: "Page title (browser tab, search results)" },
                description: { type: "string", description: "Meta description for search engines" },
                ogImage: { type: "string", description: "Open Graph image URL for social sharing" },
              },
            },
          },
          required: ["pageSlug", "patch"],
        },
      },
      handler: async (input) => applyOps([{
        op: "update_page_meta",
        pageSlug: input.pageSlug as string,
        patch: input.patch as Record<string, unknown>,
      } as unknown as Operation]),
    },

    {
      definition: {
        name: "add_item",
        description: "Add an item to an array property on a block (e.g. FAQ items, feature cards, testimonials).",
        input_schema: {
          type: "object" as const,
          properties: {
            pageSlug: { type: "string" },
            blockId: { type: "string" },
            listKey: { type: "string", description: "Array property name (e.g. 'items', 'features', 'testimonials')" },
            item: { type: "object", description: "Item data to add" },
            afterIndex: { type: "number", description: "Insert after this index. Omit to append." },
          },
          required: ["pageSlug", "blockId", "listKey", "item"],
        },
      },
      handler: async (input) => {
        const op: Record<string, unknown> = { op: "add_item", pageSlug: input.pageSlug, blockId: input.blockId, listKey: input.listKey, item: input.item }
        if (input.afterIndex !== undefined) op.afterIndex = input.afterIndex
        return applyOps([op as unknown as Operation])
      },
    },

    {
      definition: {
        name: "update_item",
        description: "Update a single item in an array property on a block.",
        input_schema: {
          type: "object" as const,
          properties: {
            pageSlug: { type: "string" },
            blockId: { type: "string" },
            listKey: { type: "string" },
            index: { type: "number", description: "Item index (0-based)" },
            patch: { type: "object", description: "Key-value pairs to update on the item" },
          },
          required: ["pageSlug", "blockId", "listKey", "index", "patch"],
        },
      },
      handler: async (input) => applyOps([{
        op: "update_item",
        pageSlug: input.pageSlug as string,
        blockId: input.blockId as string,
        listKey: input.listKey as string,
        index: input.index as number,
        patch: input.patch as Record<string, unknown>,
      } as unknown as Operation]),
    },

    {
      definition: {
        name: "remove_item",
        description: "Remove an item from an array property on a block.",
        input_schema: {
          type: "object" as const,
          properties: {
            pageSlug: { type: "string" },
            blockId: { type: "string" },
            listKey: { type: "string" },
            index: { type: "number", description: "Item index to remove (0-based)" },
          },
          required: ["pageSlug", "blockId", "listKey", "index"],
        },
      },
      handler: async (input) => applyOps([{
        op: "remove_item",
        pageSlug: input.pageSlug as string,
        blockId: input.blockId as string,
        listKey: input.listKey as string,
        index: input.index as number,
      } as unknown as Operation]),
    },

    {
      definition: {
        name: "move_item",
        description: "Reorder an item within an array property on a block.",
        input_schema: {
          type: "object" as const,
          properties: {
            pageSlug: { type: "string" },
            blockId: { type: "string" },
            listKey: { type: "string" },
            index: { type: "number", description: "Current item index (0-based)" },
            afterIndex: { type: "number", description: "Move to after this index" },
          },
          required: ["pageSlug", "blockId", "listKey", "index", "afterIndex"],
        },
      },
      handler: async (input) => applyOps([{
        op: "move_item",
        pageSlug: input.pageSlug as string,
        blockId: input.blockId as string,
        listKey: input.listKey as string,
        index: input.index as number,
        afterIndex: input.afterIndex as number,
      } as unknown as Operation]),
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

    // ================================================================
    // SITE CONFIG TOOLS
    // ================================================================

    {
      definition: {
        name: "get_site_config",
        description: "Get the site configuration — site name, logo URL, navigation labels, and navigation groups.",
        input_schema: {
          type: "object" as const,
          properties: {},
        },
      },
      handler: async () => {
        const config = getSiteConfig(session)
        return { result: JSON.stringify(config, null, 2) }
      },
    },

    {
      definition: {
        name: "update_site_config",
        description: "Update site configuration — site name, logo, navigation labels (custom text for nav links), and navigation groups (dropdown menus). Use this to edit the site header, rename the site, or reorganize navigation.",
        input_schema: {
          type: "object" as const,
          properties: {
            name: { type: "string", description: "Site name displayed in the header" },
            logo: { type: "string", description: "Logo URL" },
            navLabels: {
              type: "object",
              description: "Custom navigation labels. Keys are page slugs, values are display text. E.g. { \"/pricing\": \"Plans & Pricing\" }",
            },
            navGroups: {
              type: "object",
              description: "Navigation dropdown groups. Keys are group labels, values are arrays of page slugs. E.g. { \"Products\": [\"/bananas\", \"/cherries\"] }",
            },
          },
        },
      },
      handler: async (input) => {
        const patch: Record<string, unknown> = {}
        if (input.name !== undefined) patch.name = input.name
        if (input.logo !== undefined) patch.logo = input.logo
        if (input.navLabels !== undefined) patch.navLabels = input.navLabels
        if (input.navGroups !== undefined) patch.navGroups = input.navGroups
        return applyOps([{ op: "update_site_config", patch } as unknown as Operation])
      },
    },

    // ================================================================
    // IMAGE/MEDIA TOOLS
    // ================================================================

    {
      definition: {
        name: "unsplash_get_by_id",
        description: "Resolve an Unsplash photo page URL (e.g. https://unsplash.com/photos/slug-PHOTOID) or a bare photo ID to a direct image asset URL. ALWAYS call this when the user or reporter provides an unsplash.com/photos/... link — that link is an HTML page, not an image, and assigning it to imageUrl will break rendering. The returned imageUrl is safe to pass straight into batch_update_props.",
        input_schema: {
          type: "object" as const,
          properties: {
            url: { type: "string", description: "Unsplash photo page URL" },
            photoId: { type: "string", description: "Bare Unsplash photo ID (alternative to url)" },
          },
        },
      },
      handler: async (input) => {
        try {
          const ctx: ToolCallContext = { siteId: "", sessionId: session, traceId: "agent", plannerProvider: "anthropic" }
          const result = await unsplashGetByIdHandler({ input, context: ctx, manifest: unsplashGetByIdManifest })
          return { result: JSON.stringify(result) }
        } catch (e: unknown) {
          return { result: `Error: ${e instanceof Error ? e.message : String(e)}`, isError: true }
        }
      },
    },

    {
      definition: {
        name: "unsplash_search",
        description: "Search Unsplash for stock photos. Returns a list of image candidates with URLs. Use the imageUrl from the result to update a block's image property via batch_update_props.",
        input_schema: {
          type: "object" as const,
          properties: {
            query: { type: "string", description: "Natural-language photo search query, e.g. 'modern office workspace' or 'tropical beach sunset'" },
            limit: { type: "number", description: "Number of candidates to return (1-5, default 3)" },
          },
          required: ["query"],
        },
      },
      handler: async (input) => {
        try {
          const ctx: ToolCallContext = { siteId: "", sessionId: session, traceId: "agent", plannerProvider: "anthropic" }
          const result = await unsplashSearchHandler({ input, context: ctx, manifest: unsplashSearchManifest })
          return { result: JSON.stringify(result) }
        } catch (e: unknown) {
          return { result: `Error: ${e instanceof Error ? e.message : String(e)}`, isError: true }
        }
      },
    },

    {
      definition: {
        name: "image_generate",
        description: "Generate an AI image from a text prompt using DALL-E or Gemini. Returns an image URL. Use the imageUrl from the result to update a block's image property via batch_update_props. Default to 'draft' quality unless the user asks for high quality. Always provide blockType, blockId, and pageSlug for context-aware generation.",
        input_schema: {
          type: "object" as const,
          properties: {
            prompt: { type: "string", description: "Detailed text prompt describing the image to generate" },
            aspectRatio: { type: "string", enum: ["landscape", "square", "portrait"], description: "Aspect ratio (default: landscape)" },
            quality: { type: "string", enum: ["draft", "final"], description: "Quality: 'draft' for fast, 'final' for production" },
            style: { type: "string", description: "Optional style guidance, e.g. 'photorealistic', 'illustration', 'flat design'" },
            background: { type: "string", enum: ["transparent", "opaque", "auto"], description: "Background: 'transparent' for logos/icons/cutouts, 'opaque' for full scenes, 'auto' lets the model decide (default: auto)" },
            outputFormat: { type: "string", enum: ["png", "webp", "jpeg"], description: "Output format (default: png). Use png for transparency." },
            blockType: { type: "string", description: "Block type (e.g. 'Hero', 'Card') — helps match image composition to layout" },
            blockId: { type: "string", description: "Block ID — enables context-aware generation using block content" },
            pageSlug: { type: "string", description: "Page slug — used with blockId to look up page context" },
          },
          required: ["prompt"],
        },
      },
      handler: async (input) => {
        try {
          const ctx: ToolCallContext = { siteId: "", sessionId: session, traceId: "agent", plannerProvider: "anthropic" }
          const result = await imageGenerateHandler({ input, context: ctx, manifest: imageGenerateManifest })
          return { result: JSON.stringify(result) }
        } catch (e: unknown) {
          return { result: `Error: ${e instanceof Error ? e.message : String(e)}`, isError: true }
        }
      },
    },

    // ================================================================
    // VARIATION TOOLS
    // ================================================================

    {
      definition: {
        name: "generate_variations",
        description: "Present content variations for a block to the user. YOU generate the alternative content — provide 2-4 variations with different tones, styles, or approaches. Each variation needs a title, summary, and patch (key-value pairs to change on the block). The user sees these as clickable cards and picks their favorite. Always call get_page first to see current block props before generating variations. Do NOT apply changes after calling this — let the user pick.",
        input_schema: {
          type: "object" as const,
          properties: {
            pageSlug: { type: "string", description: "Page slug containing the block" },
            blockId: { type: "string", description: "Block ID to generate variations for" },
            variations: {
              type: "array",
              description: "2-4 alternative content options. Each must be materially different.",
              items: {
                type: "object",
                properties: {
                  title: { type: "string", description: "Short label, e.g. 'Crisp & Direct', 'Benefit-Led', 'Action-Driven'" },
                  summary: { type: "string", description: "One-line explanation of the approach" },
                  patch: { type: "object", description: "Key-value pairs to change on the block props. Only include props that differ from current values." },
                },
                required: ["title", "summary", "patch"],
              },
            },
          },
          required: ["pageSlug", "blockId", "variations"],
        },
      },
      handler: async (input) => {
        const page = getPage(session, input.pageSlug as string)
        if (!page) return { result: `Page "${input.pageSlug}" not found`, isError: true }
        const block = page.blocks.find(b => b.id === input.blockId)
        if (!block) return { result: `Block "${input.blockId}" not found`, isError: true }

        const rawVariations = input.variations as Array<{ title: string; summary: string; patch: Record<string, unknown> }>
        if (!Array.isArray(rawVariations) || rawVariations.length === 0) {
          return { result: "At least one variation is required", isError: true }
        }

        const blockProps = block.props as Record<string, unknown>
        const validatedVariations = rawVariations.slice(0, 6).map((v, idx) => {
          // Filter patch to only keys that exist on the block and differ from current value
          const cleanPatch: Record<string, unknown> = {}
          const changedKeys: string[] = []
          for (const [key, value] of Object.entries(v.patch)) {
            if (key in blockProps && JSON.stringify(blockProps[key]) !== JSON.stringify(value)) {
              cleanPatch[key] = value
              changedKeys.push(key)
            }
          }
          return {
            id: `var_${idx}_${Date.now()}`,
            title: v.title || `Option ${String.fromCharCode(65 + idx)}`,
            summary: v.summary || "",
            patch: Object.keys(cleanPatch).length > 0 ? cleanPatch : v.patch,
            changedKeys: changedKeys.length > 0 ? changedKeys : Object.keys(v.patch),
          }
        })

        return {
          result: JSON.stringify({
            status: "ok",
            summary: `Generated ${validatedVariations.length} variations for ${block.type}.`,
            blockId: block.id,
            blockType: block.type,
            pageSlug: input.pageSlug,
            baseProps: blockProps,
            variations: validatedVariations,
          })
        }
      },
    },
  ]
}
