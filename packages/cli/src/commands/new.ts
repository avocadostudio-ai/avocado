import { spawn } from "node:child_process"
import { fail } from "../format.js"

/**
 * Thin pass-through to the existing `create-ai-site-editor` scaffolder. We
 * don't re-implement its prompts here — spawning npx keeps the `avc` install
 * surface small (no transitive scaffolder deps for users who only want
 * `avc publish`).
 */
export async function newCommand(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npx", ["--yes", "create-ai-site-editor"], {
      stdio: "inherit",
    })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`create-ai-site-editor exited with code ${code}`))
    })
  }).catch((err) => fail((err as Error).message))
}
