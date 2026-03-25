#!/usr/bin/env node

import * as p from "@clack/prompts"
import { runPrompts } from "./prompts.js"
import { collectFiles, generateFiles } from "./generator.js"
import { printInstructions } from "./instructions.js"

async function main() {
  const cwd = process.cwd()
  const config = await runPrompts(cwd)
  if (!config) return

  const files = collectFiles(config)

  // Show file list and confirm
  const fileList = files.map((f) => `  ${f.path}`).join("\n")
  const confirm = await p.confirm({
    message: `Generate ${files.length} files?\n${fileList}`,
  })
  if (p.isCancel(confirm) || !confirm) {
    p.cancel("Cancelled.")
    return
  }

  const { written, skipped } = await generateFiles(cwd, files)

  if (skipped.length > 0) {
    p.log.warn(`Skipped (already exist):\n${skipped.map((f) => `  ${f}`).join("\n")}`)
  }

  p.log.success(`Generated ${written.length} files`)
  p.log.message(printInstructions(config))
  p.outro("Done!")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
