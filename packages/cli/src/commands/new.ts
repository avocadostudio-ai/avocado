import { delegate } from "../delegate.js"

/**
 * Thin pass-through to the existing `create-ai-site-editor` scaffolder. We
 * don't re-implement its prompts here — delegating keeps the CLI install
 * surface small (no transitive scaffolder deps for users who only want
 * `avc publish`).
 */
export async function newCommand(): Promise<void> {
  await delegate(
    {
      label: "create-ai-site-editor",
      siblingEntry: "../../create-ai-site-editor/src/index.ts",
      npmPackage: "create-ai-site-editor",
    },
    [],
  )
}
