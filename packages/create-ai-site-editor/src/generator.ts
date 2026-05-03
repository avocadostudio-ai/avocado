import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { ScaffoldConfig, GeneratedFile } from "./types.js"
import { editorApiRoute, revalidateRoute, manifestFile, pageFile, middlewareFile, envExample } from "./templates/common.js"
import { sanityTemplates } from "./templates/sanity.js"
import { contentfulTemplates } from "./templates/contentful.js"
import { strapiTemplates } from "./templates/strapi.js"
import { staticTemplates } from "./templates/static.js"

export function collectFiles(config: ScaffoldConfig): GeneratedFile[] {
  const files: GeneratedFile[] = []

  files.push({ path: "app/api/editor/[...path]/route.ts", content: editorApiRoute(config) })

  const revalidate = revalidateRoute(config)
  if (revalidate) files.push({ path: "app/api/revalidate/route.ts", content: revalidate })

  files.push({ path: "lib/manifest.ts", content: manifestFile(config) })
  files.push({ path: "app/[[...slug]]/page.tsx", content: pageFile(config, "static") })
  files.push({ path: "app/preview-draft/[[...slug]]/page.tsx", content: pageFile(config, "preview") })
  files.push({ path: "middleware.ts", content: middlewareFile() })
  files.push({ path: ".env.local.example", content: envExample(config) })

  switch (config.cms) {
    case "sanity": files.push(...sanityTemplates(config)); break
    case "contentful": files.push(...contentfulTemplates(config)); break
    case "strapi": files.push(...strapiTemplates(config)); break
    case "none": files.push(...staticTemplates(config)); break
  }

  return files
}

export async function generateFiles(
  cwd: string,
  files: GeneratedFile[],
): Promise<{ written: string[]; skipped: string[] }> {
  const written: string[] = []
  const skipped: string[] = []

  // Create all unique directories upfront
  const dirs = new Set(files.map((f) => dirname(join(cwd, f.path))))
  await Promise.all([...dirs].map((d) => mkdir(d, { recursive: true })))

  for (const file of files) {
    const fullPath = join(cwd, file.path)
    try {
      await writeFile(fullPath, file.content, { encoding: "utf-8", flag: "wx" })
      written.push(file.path)
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") {
        skipped.push(file.path)
        continue
      }
      throw err
    }
  }

  return { written, skipped }
}
