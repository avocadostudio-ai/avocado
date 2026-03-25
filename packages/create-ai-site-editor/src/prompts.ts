import * as p from "@clack/prompts"
import { basename } from "node:path"
import type { ScaffoldConfig, CmsChoice, BlocksMode } from "./types.js"

export async function runPrompts(cwd: string): Promise<ScaffoldConfig | null> {
  p.intro("Create AI Site Editor Integration")

  const cms = await p.select({
    message: "Which CMS?",
    options: [
      { value: "sanity" as const, label: "Sanity" },
      { value: "contentful" as const, label: "Contentful" },
      { value: "strapi" as const, label: "Strapi" },
      { value: "none" as const, label: "None (static JSON)" },
    ],
  })
  if (p.isCancel(cms)) { p.cancel("Cancelled."); return null }

  const siteId = await p.text({
    message: "Site ID (used for orchestrator sessions)",
    placeholder: basename(cwd),
    defaultValue: basename(cwd),
    validate: (v) => /^[a-zA-Z0-9_-]+$/.test(v) ? undefined : "Only letters, numbers, hyphens, and underscores",
  })
  if (p.isCancel(siteId)) { p.cancel("Cancelled."); return null }

  const blocksMode = await p.select({
    message: "Block types?",
    options: [
      { value: "default" as const, label: "Default blocks", hint: "Hero, CTA, FeatureGrid, etc." },
      { value: "custom" as const, label: "Custom blocks", hint: "Generates stub manifest for you to fill in" },
    ],
  })
  if (p.isCancel(blocksMode)) { p.cancel("Cancelled."); return null }

  return {
    cms: cms as CmsChoice,
    siteId: siteId as string,
    blocksMode: blocksMode as BlocksMode,
  }
}
