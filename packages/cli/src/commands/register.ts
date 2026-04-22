import { delegate } from "../delegate.js"

type RegisterOptions = {
  name?: string
  id?: string
  port?: number
  orchestrator?: string
  secret?: string
  session?: string
  purpose?: string
  previewUrl?: string
  cwd?: string
}

/**
 * Pass-through to the existing `avocado-register` bin in the site-sdk. Same
 * rationale as newCommand — avoid duplicating the env-file merge logic,
 * which is already battle-tested there.
 */
export async function registerCommand(opts: RegisterOptions): Promise<void> {
  const args: string[] = []
  if (opts.name) args.push("--name", opts.name)
  if (opts.id) args.push("--id", opts.id)
  if (opts.port !== undefined) args.push("--port", String(opts.port))
  if (opts.orchestrator) args.push("--orchestrator", opts.orchestrator)
  if (opts.secret) args.push("--secret", opts.secret)
  if (opts.session) args.push("--session", opts.session)
  if (opts.purpose) args.push("--purpose", opts.purpose)
  if (opts.previewUrl) args.push("--preview-url", opts.previewUrl)
  if (opts.cwd) args.push("--cwd", opts.cwd)

  await delegate(
    {
      label: "avocado-register",
      siblingEntry: "../../site-sdk/src/cli/register.ts",
      npmPackage: "@ai-site-editor/site-sdk",
      // The npx fallback calls the `register` subcommand of the site-sdk bin.
      extraArgs: ["register"],
    },
    args,
  )
}
