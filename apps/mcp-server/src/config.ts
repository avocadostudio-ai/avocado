/**
 * Install-time configuration bound via environment variables.
 *
 * Each MCP install is scoped to exactly one (session, siteId) pair. The client
 * (Claude Desktop / Claude Code) passes these through when it spawns the stdio
 * server, so tool calls don't need to accept session/siteId as arguments.
 */

export type McpConfig = {
  orchestratorUrl: string
  session: string
  siteId: string
  /** Optional bearer token for /publish. Falls back to env DRAFT_MODE_SECRET if not set. */
  publishToken?: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const orchestratorUrl = (env.ORCHESTRATOR_URL ?? "http://localhost:4200").replace(/\/+$/, "")
  const session = env.AVOCADO_SESSION?.trim() || "dev"
  const siteId = env.AVOCADO_SITE_ID?.trim() || ""
  if (!siteId) {
    throw new Error(
      "AVOCADO_SITE_ID is required. Set it to the site this MCP install should edit (e.g. 'avocado-stories')."
    )
  }
  const publishToken = env.AVOCADO_PUBLISH_TOKEN?.trim() || undefined
  return { orchestratorUrl, session, siteId, publishToken }
}
