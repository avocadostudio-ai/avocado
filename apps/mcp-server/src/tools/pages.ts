import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { OrchestratorClient } from "../orchestrator-client.ts"
import { jsonResult, errorResult } from "./_helpers.ts"

const pageSlug = z.string().min(1).describe("Page slug, starts with '/' (e.g. '/', '/pricing').")

export function registerPageTools(server: McpServer, client: OrchestratorClient) {
  server.tool(
    "avocado-get-page",
    "Fetch a single page's full draft document (blocks + meta) by slug.",
    { slug: pageSlug },
    async ({ slug }) => {
      try {
        return jsonResult(await client.getPage(slug))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-list-pages",
    "List every page in the current draft (home page first). Returns both `slugs: string[]` and a richer `pages: [{ slug, title, updatedAt, blockCount }]` summary — use `pages` to plan multi-page work without needing a follow-up avocado-get-page per slug.",
    {},
    async () => {
      try {
        return jsonResult(await client.listSlugs())
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-create-page",
    "Create a new page. The page must include a unique slug, title, and an initial blocks array (can be empty).",
    {
      slug: pageSlug,
      title: z.string().min(1),
      blocks: z.array(z.object({
        id: z.string().min(1),
        type: z.string().min(1),
        props: z.record(z.string(), z.unknown()),
      })).default([]),
      meta: z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        ogImage: z.string().optional(),
      }).optional(),
    },
    async ({ slug, title, blocks, meta }) => {
      try {
        return jsonResult(await client.applyOps([
          {
            op: "create_page",
            page: {
              id: `p_${slug.replace(/[^a-zA-Z0-9]+/g, "_")}_${Date.now()}`,
              slug,
              title,
              updatedAt: new Date().toISOString(),
              blocks,
              meta,
            },
          },
        ]))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-rename-page",
    "Rename a page — change its slug and/or title. Internal links to the old slug are rewritten automatically.",
    {
      slug: pageSlug,
      newSlug: z.string().min(1).describe("New slug (starts with '/').").optional(),
      newTitle: z.string().min(1).optional(),
    },
    async ({ slug, newSlug, newTitle }) => {
      if (!newSlug && !newTitle) return errorResult(new Error("Provide newSlug or newTitle."))
      try {
        return jsonResult(await client.applyOps([
          { op: "rename_page", pageSlug: slug, newPageSlug: newSlug ?? slug, newTitle },
        ]))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-duplicate-page",
    "Duplicate a page, optionally under a new slug/title and inserted after a specific page in the nav order. When `newTitle` is passed, `meta.title` is synced to the new title too (so SEO doesn't show the source page's title). Response includes `duplicatedPages: [{ slug, blockIdMap: { [oldId]: newId } }]` — use the map to target copied blocks directly without a follow-up avocado-get-page.",
    {
      slug: pageSlug,
      newSlug: z.string().min(1).optional(),
      newTitle: z.string().min(1).optional(),
      afterSlug: z.string().min(1).optional().describe("Slug of the page the duplicate should appear after in nav order."),
    },
    async ({ slug, newSlug, newTitle, afterSlug }) => {
      try {
        return jsonResult(await client.applyOps([
          { op: "duplicate_page", pageSlug: slug, newPageSlug: newSlug, newTitle, afterPageSlug: afterSlug },
        ]))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-remove-page",
    "Delete a page from the draft. Undo-able from the editor history.",
    { slug: pageSlug },
    async ({ slug }) => {
      try {
        return jsonResult(await client.applyOps([{ op: "remove_page", pageSlug: slug }]))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-update-page-meta",
    "Patch a page's SEO metadata (title, description, ogImage). Only provided keys are updated.",
    {
      slug: pageSlug,
      title: z.string().optional(),
      description: z.string().optional(),
      ogImage: z.string().optional(),
    },
    async ({ slug, title, description, ogImage }) => {
      const patch: Record<string, string> = {}
      if (title !== undefined) patch.title = title
      if (description !== undefined) patch.description = description
      if (ogImage !== undefined) patch.ogImage = ogImage
      if (Object.keys(patch).length === 0) return errorResult(new Error("Provide at least one of title, description, ogImage."))
      try {
        return jsonResult(await client.applyOps([{ op: "update_page_meta", pageSlug: slug, patch }]))
      } catch (err) {
        return errorResult(err)
      }
    }
  )
}
