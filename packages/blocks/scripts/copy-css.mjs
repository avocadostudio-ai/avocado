import { cp, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, "..", "src", "blocks")
const outDir = join(here, "..", "dist", "blocks")

await mkdir(outDir, { recursive: true })
await cp(srcDir, outDir, {
  recursive: true,
  filter: (path) => {
    if (path === srcDir) return true
    return !path.endsWith(".ts") && !path.endsWith(".tsx") && !path.endsWith(".test.ts") && !path.endsWith(".test.tsx")
  },
})
console.log("[blocks] copied CSS assets to dist/blocks")
