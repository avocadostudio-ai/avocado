import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { OrchestratorClient } from "../orchestrator-client.ts"
import { jsonResult, errorResult } from "./_helpers.ts"

export function registerSiteTools(server: McpServer, client: OrchestratorClient) {
  server.tool(
    "avocado-register-site",
    "Register or update the site entry for this install (preview URL, display name, port, purpose, tone). Required once before the editor can find the site.",
    {
      name: z.string().min(1).optional().describe("Display name shown in the editor's site switcher."),
      previewUrl: z.string().url().optional().describe("URL where the Next.js site is running (e.g. http://localhost:3000)."),
      port: z.number().int().positive().optional(),
      purpose: z.string().optional().describe("One-liner describing what the site is about. Used as AI context."),
      secret: z.string().optional().describe("DRAFT_MODE_SECRET value so the orchestrator can fetch draft content."),
    },
    async (args) => {
      try {
        return jsonResult(await client.request("POST", "/sites/register", {
          body: client.scopedBody(args),
        }))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-list-sites",
    "List every site registered under the current session.",
    {},
    async () => {
      try {
        return jsonResult(await client.request("GET", "/sites", { query: { session: client.config.session } }))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-get-site-config",
    "Fetch the current site's config (name, logo, tone, purpose, nav labels/groups, theme overrides).",
    {},
    async () => {
      try {
        return jsonResult(await client.getSiteConfig())
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-update-site-config",
    "Patch the site's config (name, logo, navLabels, navGroups). Only provided keys are updated; others remain untouched. Undo-able via history.",
    {
      name: z.string().optional(),
      logo: z.string().optional().describe("URL or path to the site logo."),
      navLabels: z.record(z.string(), z.string()).optional().describe("Slug → custom nav label (e.g. { '/pricing': 'Plans & Pricing' })."),
      navGroups: z.record(z.string(), z.array(z.string())).optional().describe("Parent label → child slugs (e.g. { 'Products': ['/bananas', '/cherries'] })."),
    },
    async ({ name, logo, navLabels, navGroups }) => {
      const patch: Record<string, unknown> = {}
      if (name !== undefined) patch.name = name
      if (logo !== undefined) patch.logo = logo
      if (navLabels !== undefined) patch.navLabels = navLabels
      if (navGroups !== undefined) patch.navGroups = navGroups
      if (Object.keys(patch).length === 0) {
        return errorResult(new Error("Provide at least one of name, logo, navLabels, navGroups."))
      }
      try {
        return jsonResult(await client.applyOps([{ op: "update_site_config", patch }]))
      } catch (err) {
        return errorResult(err)
      }
    }
  )
}
