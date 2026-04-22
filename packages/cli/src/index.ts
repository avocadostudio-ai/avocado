#!/usr/bin/env node
/**
 * avc — Avocado Studio CLI.
 *
 * Unified terminal entrypoint for the Avocado Studio developer workflow.
 * Commands are thin wrappers around the orchestrator HTTP API so nothing here
 * needs to stay in sync with orchestrator internals — only the endpoints.
 *
 * Locally, `pnpm exec avc` runs this file via bin/avc.mjs (which shells to
 * tsx). The published binary runs dist/index.js directly.
 */

import { Command } from "commander"
import { publishCommand } from "./commands/publish.js"
import { statusCommand } from "./commands/status.js"
import { diffCommand } from "./commands/diff.js"
import { restoreCommand, restoreListCommand } from "./commands/restore.js"
import { healthCommand } from "./commands/health.js"
import { newCommand } from "./commands/new.js"
import { registerCommand } from "./commands/register.js"
import { sitesListCommand } from "./commands/sites.js"
import { devCommand } from "./commands/dev.js"

const program = new Command()

program
  .name("avc")
  .description("Avocado Studio CLI — manage, publish, and develop Avocado sites from the terminal.")
  .version("0.0.1")

const addCommonConfigFlags = (cmd: Command): Command =>
  cmd
    .option("--orchestrator <url>", "orchestrator URL (env: ORCHESTRATOR_URL)")
    .option("--session <name>", "orchestrator session (env: AVC_SESSION)", "dev")
    .option("--site <id>", "site ID (env: AVC_SITE_ID / NEXT_PUBLIC_DEFAULT_SITE_ID)")
    .option("--site-origin <url>", "origin of the deployed site (for site-contract publish targets)")
    .option("--token <token>", "publish token (env: PUBLISH_TOKEN)")

addCommonConfigFlags(
  program
    .command("publish")
    .description("Publish the draft for a site to its configured target."),
)
  .option("--wait", "poll /publish/status until the deployment is live")
  .option("--timeout <seconds>", "max seconds to wait when --wait is set", (v) => Number(v), 120)
  .action(publishCommand)

addCommonConfigFlags(
  program
    .command("status")
    .description("Show the current publish status for a site."),
).action(statusCommand)

addCommonConfigFlags(
  program
    .command("diff")
    .description("Show the difference between the draft and the published site."),
)
  .option("--json", "emit raw JSON")
  .action(diffCommand)

const restore = program
  .command("restore")
  .description("Inspect or roll back to a historical publish snapshot.")

addCommonConfigFlags(restore.command("list").description("List recent publish snapshots."))
  .option("--limit <n>", "max snapshots to return (1-80)", (v) => Number(v), 30)
  .option("--json", "emit raw JSON")
  .action(restoreListCommand)

addCommonConfigFlags(restore.command("commit <sha>").description("Roll the draft back to a snapshot."))
  .action((sha, opts) => restoreCommand({ ...opts, commit: sha }))

program
  .command("dev")
  .description("Start the orchestrator + editor (and optionally the site) with unified logs.")
  .option("--no-orchestrator", "skip the orchestrator")
  .option("--no-editor", "skip the editor")
  .option("--site", "also start the bundled demo site (apps/site)")
  .option("--only <list>", "comma-separated list of services to run (orchestrator,editor,site)")
  .action(devCommand)

program
  .command("new")
  .description("Scaffold a new AI-site-editor integration (delegates to create-ai-site-editor).")
  .action(newCommand)

program
  .command("register")
  .description("Register the current Next.js site with a running orchestrator.")
  .option("--name <name>", "human-readable site name")
  .option("--id <id>", "kebab-case site ID")
  .option("--port <n>", "dev server port", (v) => Number(v))
  .option("--orchestrator <url>", "orchestrator URL")
  .option("--secret <secret>", "draft mode secret (auto-generated if missing)")
  .option("--session <name>", "orchestrator session", "dev")
  .option("--purpose <text>", "one-line site description for AI context")
  .option("--preview-url <url>", "preview URL (default: http://localhost:<port>)")
  .option("--cwd <path>", "project directory")
  .action(registerCommand)

const sites = program.command("sites").description("Inspect sites registered with the orchestrator.")
addCommonConfigFlags(sites.command("list").description("List all sites for the current session."))
  .option("--json", "emit raw JSON")
  .action(sitesListCommand)

program
  .command("health")
  .description("Check that the orchestrator, editor, and site are reachable.")
  .option("--orchestrator <url>", "orchestrator URL (env: ORCHESTRATOR_URL)")
  .option("--editor <url>", "editor URL (env: NEXT_PUBLIC_EDITOR_ORIGIN)")
  .option("--site-url <url>", "site URL (env: SITE_ORIGIN / NEXT_PUBLIC_SITE_ORIGIN)")
  .action(healthCommand)

program.parseAsync(process.argv).catch((err) => {
  // Any uncaught rejection ends up here; command handlers do their own fail()
  // with friendly messages, so this is only for programmer errors.
  console.error(err)
  process.exit(1)
})
