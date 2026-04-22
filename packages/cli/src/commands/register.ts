import { spawn } from "node:child_process"
import { fail } from "../format.js"

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
  const args: string[] = ["--yes", "@ai-site-editor/site-sdk", "register"]
  if (opts.name) args.push("--name", opts.name)
  if (opts.id) args.push("--id", opts.id)
  if (opts.port !== undefined) args.push("--port", String(opts.port))
  if (opts.orchestrator) args.push("--orchestrator", opts.orchestrator)
  if (opts.secret) args.push("--secret", opts.secret)
  if (opts.session) args.push("--session", opts.session)
  if (opts.purpose) args.push("--purpose", opts.purpose)
  if (opts.previewUrl) args.push("--preview-url", opts.previewUrl)
  if (opts.cwd) args.push("--cwd", opts.cwd)

  await new Promise<void>((resolve, reject) => {
    const child = spawn("npx", args, { stdio: "inherit" })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`avocado-register exited with code ${code}`))
    })
  }).catch((err) => fail((err as Error).message))
}
