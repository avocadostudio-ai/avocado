import { mkdir, writeFile, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { getBlockMeta } from "@ai-site-editor/shared"
import type { BlockCodegenInput, BlockCodegenResult, FieldSpec } from "./types.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function kebabCase(pascal: string): string {
  return pascal
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
}

export function camelCase(pascal: string): string {
  return pascal[0].toLowerCase() + pascal.slice(1)
}

function pascalFromKebab(kebab: string): string {
  return kebab
    .split("-")
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join("")
}

// ---------------------------------------------------------------------------
// Code generators
// ---------------------------------------------------------------------------

function zodTypeForField(field: FieldSpec): string {
  switch (field.kind) {
    case "enum": {
      const opts = (field.enumOptions ?? []).map((o) => JSON.stringify(o)).join(", ")
      const base = `z.enum([${opts}])`
      return field.required ? base : `${base}.optional()`
    }
    case "number": {
      const base = "z.number()"
      return field.required ? base : `${base}.optional()`
    }
    default: {
      // text, richtext, url, image, imageAlt, color
      const base = field.required ? "z.string().min(1)" : "z.string().optional()"
      return base
    }
  }
}

function fieldMetaCall(field: FieldSpec): string {
  switch (field.kind) {
    case "text":
    case "color":
      return `f.text(${JSON.stringify(field.label)})`
    case "richtext":
      return `f.richtext(${JSON.stringify(field.label)})`
    case "url":
      return `f.url(${JSON.stringify(field.label)})`
    case "image": {
      if (field.imageSpec) {
        return `f.image(${JSON.stringify(field.label)}, ${JSON.stringify(field.imageSpec)})`
      }
      return `f.image(${JSON.stringify(field.label)})`
    }
    case "imageAlt":
      return `f.imageAlt(${JSON.stringify(field.label)})`
    case "enum": {
      const opts = (field.enumOptions ?? []).map((o) => JSON.stringify(o)).join(", ")
      return `{ kind: "enum", label: ${JSON.stringify(field.label)}, options: [${opts}] }`
    }
    case "number":
      return `{ kind: "number", label: ${JSON.stringify(field.label)} }`
    default:
      return `f.text(${JSON.stringify(field.label)})`
  }
}

function generateSchemaSource(input: BlockCodegenInput): string {
  const { name, description, category, fields, listFields, defaultProps } = input
  const camel = camelCase(name)

  const lines: string[] = []
  lines.push(`import { z } from "zod"`)
  lines.push(`import { registerBlock, f } from "@ai-site-editor/shared"`)
  lines.push("")
  lines.push(`registerBlock(${JSON.stringify(name)}, {`)

  // schema
  lines.push("  schema: z.object({")
  for (const field of fields) {
    lines.push(`    ${field.name}: ${zodTypeForField(field)},`)
  }
  if (listFields) {
    for (const lf of listFields) {
      const itemFields = lf.itemFields.map((f) => `      ${f.name}: ${zodTypeForField(f)},`).join("\n")
      const required = lf.itemFields.some((f) => f.required)
      const arrayMin = required ? ".min(1)" : ""
      lines.push(`    ${lf.name}: z.array(z.object({`)
      lines.push(itemFields)
      lines.push(`    }))${arrayMin},`)
    }
  }
  lines.push("  }),")

  // meta
  lines.push("  meta: {")
  lines.push(`    displayName: ${JSON.stringify(name)},`)
  lines.push(`    description: ${JSON.stringify(description)},`)
  lines.push(`    category: ${JSON.stringify(category)},`)
  lines.push("    fields: {")
  for (const field of fields) {
    lines.push(`      ${field.name}: ${fieldMetaCall(field)},`)
  }
  lines.push("    },")

  if (listFields && listFields.length > 0) {
    lines.push("    listFields: {")
    for (const lf of listFields) {
      lines.push(`      ${lf.name}: {`)
      lines.push(`        label: ${JSON.stringify(lf.label)},`)
      lines.push("        itemFields: {")
      for (const itemField of lf.itemFields) {
        lines.push(`          ${itemField.name}: ${fieldMetaCall(itemField)},`)
      }
      lines.push("        },")
      lines.push("      },")
    }
    lines.push("    },")
  }

  lines.push("  },")
  lines.push("})")
  lines.push("")
  lines.push(`export function ${camel}DefaultProps(): Record<string, unknown> {`)
  lines.push(`  return ${JSON.stringify(defaultProps, null, 2).split("\n").map((l, i) => (i === 0 ? l : "  " + l)).join("\n")}`)
  lines.push("}")
  lines.push("")

  return lines.join("\n")
}

function generateRendererSource(name: string, rendererJsx: string): string {
  const lines: string[] = []
  lines.push(`import type { JSX } from "react"`)
  lines.push("")
  lines.push(`export function ${name}(props: Record<string, unknown>): JSX.Element {`)
  // Indent each line of rendererJsx
  for (const line of rendererJsx.split("\n")) {
    lines.push(`  ${line}`)
  }
  lines.push("}")
  lines.push("")
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Manifest regeneration
// ---------------------------------------------------------------------------

export async function regenerateManifest(outputDir: string): Promise<string> {
  const entries: string[] = []

  let dirEntries: string[]
  try {
    dirEntries = await readdir(outputDir)
  } catch {
    dirEntries = []
  }

  for (const entry of dirEntries.sort()) {
    const entryPath = join(outputDir, entry)
    const s = await stat(entryPath).catch(() => null)
    if (!s?.isDirectory()) continue

    const hasSchema = await stat(join(entryPath, "schema.ts"))
      .then(() => true)
      .catch(() => false)
    const hasRenderer = await stat(join(entryPath, "renderer.tsx"))
      .then(() => true)
      .catch(() => false)

    if (hasSchema && hasRenderer) {
      entries.push(entry)
    }
  }

  const lines: string[] = []
  lines.push("// Auto-generated by migration-sdk — do not edit manually")

  // Schema imports (side-effect: triggers registerBlock)
  for (const dir of entries) {
    lines.push(`import "./${dir}/schema.ts"`)
  }

  // Renderer exports
  for (const dir of entries) {
    const pascal = pascalFromKebab(dir)
    lines.push(`export { ${pascal} } from "./${dir}/renderer.tsx"`)
  }
  lines.push("")

  const manifestPath = join(outputDir, "index.ts")
  await writeFile(manifestPath, lines.join("\n"), "utf-8")
  return manifestPath
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function generateBlock(input: BlockCodegenInput): Promise<BlockCodegenResult> {
  // Validate PascalCase
  if (!/^[A-Z][a-zA-Z0-9]*$/.test(input.name)) {
    throw new Error(`Invalid block name "${input.name}": must be PascalCase (start with uppercase, no spaces/hyphens)`)
  }

  // Check for conflicts with existing block types
  if (getBlockMeta(input.name)) {
    throw new Error(`Block type "${input.name}" already exists in the registry`)
  }

  // Require at least one field or listField
  const hasFields = input.fields.length > 0
  const hasListFields = (input.listFields?.length ?? 0) > 0
  if (!hasFields && !hasListFields) {
    throw new Error("At least one field or listField is required")
  }

  const kebab = kebabCase(input.name)
  const blockDir = join(input.outputDir, kebab)
  await mkdir(blockDir, { recursive: true })

  const filesCreated: string[] = []

  // Generate schema.ts
  const schemaPath = join(blockDir, "schema.ts")
  await writeFile(schemaPath, generateSchemaSource(input), "utf-8")
  filesCreated.push(schemaPath)

  // Generate renderer.tsx
  const rendererPath = join(blockDir, "renderer.tsx")
  await writeFile(rendererPath, generateRendererSource(input.name, input.rendererJsx), "utf-8")
  filesCreated.push(rendererPath)

  // Generate styles.css
  const stylesPath = join(blockDir, "styles.css")
  await writeFile(stylesPath, input.cssTemplate, "utf-8")
  filesCreated.push(stylesPath)

  // Regenerate manifest
  const manifestPath = await regenerateManifest(input.outputDir)

  return {
    blockType: input.name,
    filesCreated,
    manifestUpdated: manifestPath,
  }
}
