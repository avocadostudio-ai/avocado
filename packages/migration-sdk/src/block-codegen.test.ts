import { describe, it, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { generateBlock, regenerateManifest, kebabCase, camelCase } from "./block-codegen.ts"
import type { BlockCodegenInput } from "./types.ts"

// ---------------------------------------------------------------------------
// Helper: create a minimal valid input
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<BlockCodegenInput> & { outputDir: string }): BlockCodegenInput {
  return {
    name: "TestWidget",
    description: "A test block",
    category: "content",
    fields: [
      { name: "heading", kind: "text", label: "Heading", required: true },
      { name: "body", kind: "richtext", label: "Body text", required: false },
    ],
    defaultProps: { heading: "Hello", body: "World" },
    cssTemplate: ".test-widget { color: red; }",
    rendererJsx: 'return <section className="test-widget"><h2>{String(props.heading)}</h2></section>',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

const tmpDirs: string[] = []

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "block-codegen-"))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// kebabCase
// ---------------------------------------------------------------------------

describe("kebabCase", () => {
  it("converts PascalCase to kebab-case", () => {
    assert.equal(kebabCase("PricingTable"), "pricing-table")
    assert.equal(kebabCase("Hero"), "hero")
    assert.equal(kebabCase("FAQAccordion"), "faq-accordion")
    assert.equal(kebabCase("CTA"), "cta")
    assert.equal(kebabCase("TeamGrid"), "team-grid")
  })
})

// ---------------------------------------------------------------------------
// camelCase
// ---------------------------------------------------------------------------

describe("camelCase", () => {
  it("converts PascalCase to camelCase", () => {
    assert.equal(camelCase("PricingTable"), "pricingTable")
    assert.equal(camelCase("Hero"), "hero")
    assert.equal(camelCase("CTA"), "cTA")
  })
})

// ---------------------------------------------------------------------------
// generateBlock — schema.ts with simple fields
// ---------------------------------------------------------------------------

describe("generateBlock", () => {
  it("creates schema.ts with correct Zod schema for simple fields", async () => {
    const outDir = await makeTmpDir()
    const input = makeInput({
      outputDir: outDir,
      fields: [
        { name: "heading", kind: "text", label: "Heading", required: true },
        { name: "subtitle", kind: "text", label: "Subtitle", required: false },
        { name: "count", kind: "number", label: "Count", required: true },
        { name: "variant", kind: "enum", label: "Variant", required: false, enumOptions: ["light", "dark"] },
      ],
    })

    await generateBlock(input)

    const schema = await readFile(join(outDir, "test-widget", "schema.ts"), "utf-8")
    assert.ok(schema.includes('import { z } from "zod"'))
    assert.ok(schema.includes('import { registerBlock, f } from "@avocadostudio-ai/shared"'))
    assert.ok(schema.includes("heading: z.string().min(1)"))
    assert.ok(schema.includes("subtitle: z.string().optional()"))
    assert.ok(schema.includes("count: z.number()"))
    assert.ok(schema.includes('variant: z.enum(["light", "dark"]).optional()'))
    assert.ok(schema.includes("testWidgetDefaultProps"))
  })

  it("creates schema.ts with list fields", async () => {
    const outDir = await makeTmpDir()
    const input = makeInput({
      outputDir: outDir,
      listFields: [
        {
          name: "items",
          label: "Items",
          itemFields: [
            { name: "title", kind: "text", label: "Title", required: true },
            { name: "icon", kind: "image", label: "Icon", required: false },
          ],
        },
      ],
    })

    await generateBlock(input)

    const schema = await readFile(join(outDir, "test-widget", "schema.ts"), "utf-8")
    assert.ok(schema.includes("items: z.array(z.object({"))
    assert.ok(schema.includes("title: z.string().min(1)"))
    assert.ok(schema.includes("icon: z.string().optional()"))
    assert.ok(schema.includes(".min(1)"))
    assert.ok(schema.includes('label: "Items"'))
  })

  it("creates renderer.tsx with component export", async () => {
    const outDir = await makeTmpDir()
    await generateBlock(makeInput({ outputDir: outDir }))

    const renderer = await readFile(join(outDir, "test-widget", "renderer.tsx"), "utf-8")
    assert.ok(renderer.includes('import type { JSX } from "react"'))
    assert.ok(renderer.includes("export function TestWidget(props: Record<string, unknown>): JSX.Element"))
    assert.ok(renderer.includes('className="test-widget"'))
  })

  it("creates styles.css", async () => {
    const outDir = await makeTmpDir()
    await generateBlock(makeInput({ outputDir: outDir }))

    const css = await readFile(join(outDir, "test-widget", "styles.css"), "utf-8")
    assert.equal(css, ".test-widget { color: red; }")
  })

  it("regenerates index.ts manifest", async () => {
    const outDir = await makeTmpDir()
    await generateBlock(makeInput({ outputDir: outDir }))

    const manifest = await readFile(join(outDir, "index.ts"), "utf-8")
    assert.ok(manifest.includes("// Auto-generated by migration-sdk"))
    assert.ok(manifest.includes('import "./test-widget/schema.ts"'))
    assert.ok(manifest.includes('export { TestWidget } from "./test-widget/renderer.tsx"'))
  })

  it("rejects names that conflict with existing block types", async () => {
    const outDir = await makeTmpDir()
    // "Hero" is registered by @avocadostudio-ai/shared
    const input = makeInput({ outputDir: outDir, name: "Hero" })
    await assert.rejects(() => generateBlock(input), /already exists/)
  })

  it("rejects invalid PascalCase names", async () => {
    const outDir = await makeTmpDir()

    await assert.rejects(
      () => generateBlock(makeInput({ outputDir: outDir, name: "pricing-table" })),
      /must be PascalCase/,
    )

    await assert.rejects(
      () => generateBlock(makeInput({ outputDir: outDir, name: "pricingTable" })),
      /must be PascalCase/,
    )

    await assert.rejects(
      () => generateBlock(makeInput({ outputDir: outDir, name: "Pricing Table" })),
      /must be PascalCase/,
    )
  })
})

// ---------------------------------------------------------------------------
// regenerateManifest
// ---------------------------------------------------------------------------

describe("regenerateManifest", () => {
  it("generates correct imports for multiple blocks", async () => {
    const outDir = await makeTmpDir()

    // Create two block directories with schema.ts + renderer.tsx
    for (const name of ["pricing-table", "team-grid"]) {
      const dir = join(outDir, name)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, "schema.ts"), "// placeholder", "utf-8")
      await writeFile(join(dir, "renderer.tsx"), "// placeholder", "utf-8")
    }

    const manifestPath = await regenerateManifest(outDir)
    const manifest = await readFile(manifestPath, "utf-8")

    assert.ok(manifest.includes('import "./pricing-table/schema.ts"'))
    assert.ok(manifest.includes('import "./team-grid/schema.ts"'))
    assert.ok(manifest.includes('export { PricingTable } from "./pricing-table/renderer.tsx"'))
    assert.ok(manifest.includes('export { TeamGrid } from "./team-grid/renderer.tsx"'))

    // Verify ordering: pricing-table before team-grid
    const ptIdx = manifest.indexOf("pricing-table")
    const tgIdx = manifest.indexOf("team-grid")
    assert.ok(ptIdx < tgIdx)
  })
})
