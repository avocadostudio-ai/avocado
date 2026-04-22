/**
 * Helpers for `avc new` and `avc register`, which delegate to other packages
 * rather than re-implementing their logic.
 *
 * Why this file exists: the target packages (`create-ai-site-editor` and
 * `@ai-site-editor/site-sdk`) are not publicly published — they live in this
 * workspace and the site-sdk is restricted to GitHub Packages. A blind
 * `npx <pkg>` would 404 for most users. So we first try to resolve the
 * sibling source file on disk and spawn it through the package-local tsx,
 * and only fall back to npx when we can't find a local copy (e.g. when
 * `avc` is installed standalone and the user has the packages available via
 * a configured registry).
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { fail, ui } from "./format.js"

type DelegateTarget = {
  /** Human-readable label, used in error messages. */
  label: string
  /**
   * Relative path from `packages/cli/src/` to the target package's TS
   * entrypoint. Used when we can locate the sibling on disk.
   */
  siblingEntry: string
  /** npm package name used as the `npx --yes <name>` fallback. */
  npmPackage: string
  /** Extra args to pass after the entrypoint (e.g. "register" subcommand). */
  extraArgs?: string[]
}

function resolveSibling(siblingEntry: string): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidate = resolve(here, siblingEntry)
  return existsSync(candidate) ? candidate : null
}

function resolveLocalTsx(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  const tsxBin = resolve(here, "../node_modules/.bin/tsx")
  return existsSync(tsxBin) ? tsxBin : null
}

/**
 * Run a delegated bin, preferring the local sibling package (when present)
 * over `npx`. Inherits stdio so interactive prompts work.
 */
export async function delegate(target: DelegateTarget, userArgs: string[]): Promise<void> {
  const sibling = resolveSibling(target.siblingEntry)
  const tsx = resolveLocalTsx()

  let command: string
  let args: string[]
  let mode: "local" | "npx"

  if (sibling && tsx) {
    command = tsx
    args = [sibling, ...(target.extraArgs ?? []), ...userArgs]
    mode = "local"
  } else {
    command = "npx"
    args = ["--yes", target.npmPackage, ...(target.extraArgs ?? []), ...userArgs]
    mode = "npx"
  }

  await new Promise<void>((res, rej) => {
    const child = spawn(command, args, { stdio: "inherit" })
    child.on("error", rej)
    child.on("exit", (code) => {
      if (code === 0) res()
      else rej(new Error(`${target.label} exited with code ${code}`))
    })
  }).catch((err) => {
    if (mode === "npx") {
      ui.error(`${target.label} failed to run.`)
      ui.dim(`  The CLI fell back to \`npx --yes ${target.npmPackage}\` because the sibling package`)
      ui.dim(`  was not found on disk. This typically means either:`)
      ui.dim(`    • You are not inside the Avocado monorepo, and ${target.npmPackage} is not publicly`)
      ui.dim(`      published (the site-sdk is restricted to GitHub Packages).`)
      ui.dim(`    • The package exists on a private registry that your npm is not configured for.`)
      ui.dim(`  See https://docs.github.com/packages/working-with-a-github-packages-registry for auth setup.`)
      fail((err as Error).message)
    }
    fail((err as Error).message)
  })
}
