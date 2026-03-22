/**
 * Generate Sanity schema files from the shared block registry.
 *
 * Usage: pnpm sanity:schema-gen
 *
 * Outputs TypeScript schema files to sanity/schemas/blocks/
 * and an index file that exports all block schemas.
 */

import { writeFileSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { getAllBlockMeta, type FieldKind } from "@ai-site-editor/shared"

// Ensure blocks are registered
import "@ai-site-editor/shared"

const outDir = resolve(import.meta.dirname, "schemas/blocks")
mkdirSync(outDir, { recursive: true })

function fieldKindToSanityType(kind: FieldKind): string {
  switch (kind) {
    case "text": return "string"
    case "richtext": return "text"
    case "url": return "string" // relative paths like /about are valid; Sanity's url type rejects them
    case "image": return "image"
    case "imageAlt": return "string"
    case "color": return "string"
    case "number": return "number"
    case "enum": return "string"
    case "headingLevel": return "string"
    default: return "string"
  }
}

/** Convert PascalCase to camelCase, handling acronyms (CTA → cta, FAQAccordion → faqAccordion) */
function toSanityName(pascalCase: string): string {
  // All uppercase (CTA, FAQ) → all lowercase
  if (pascalCase === pascalCase.toUpperCase()) return pascalCase.toLowerCase()
  // Leading uppercase run + rest: "FAQAccordion" → "faq" + "Accordion"
  const match = pascalCase.match(/^([A-Z]+)([A-Z][a-z].*)$/)
  if (match) return match[1].toLowerCase() + match[2]
  return pascalCase.charAt(0).toLowerCase() + pascalCase.slice(1)
}

const allMeta = getAllBlockMeta()
const schemaNames: string[] = []

for (const [blockType, meta] of Object.entries(allMeta)) {
  const sanityName = toSanityName(blockType)
  const varName = `${sanityName}Schema`
  schemaNames.push(sanityName)

  const fields: string[] = []

  // Scalar fields
  for (const [key, fieldMeta] of Object.entries(meta.fields)) {
    if (key === "headingLevel") continue
    const sanityType = fieldKindToSanityType(fieldMeta.kind)

    if (fieldMeta.kind === "enum" && fieldMeta.options?.length) {
      fields.push(`    {
      name: "${key}",
      title: "${fieldMeta.label ?? key}",
      type: "string",
      options: {
        list: [${fieldMeta.options.map((o) => `"${o}"`).join(", ")}],
      },
    }`)
    } else {
      fields.push(`    {
      name: "${key}",
      title: "${fieldMeta.label ?? key}",
      type: "${sanityType}",
    }`)
    }
  }

  // List fields → array type
  if (meta.listFields) {
    for (const [key, listMeta] of Object.entries(meta.listFields)) {
      // CardGrid.cards → array of references to card documents
      if (blockType === "CardGrid" && key === "cards") {
        fields.push(`    {
      name: "${key}",
      title: "${listMeta.label ?? key}",
      type: "array",
      of: [{ type: "reference", to: [{ type: "card" }] }],
    }`)
      } else {
        // Other lists → array of objects
        const itemFields = Object.entries(listMeta.itemFields)
          .filter(([k]) => k !== "headingLevel")
          .map(([k, fm]) => {
            const t = fieldKindToSanityType(fm.kind)
            return `        { name: "${k}", title: "${fm.label ?? k}", type: "${t}" }`
          })
          .join(",\n")

        fields.push(`    {
      name: "${key}",
      title: "${listMeta.label ?? key}",
      type: "array",
      of: [
        {
          type: "object",
          fields: [
${itemFields}
          ],
        },
      ],
    }`)
      }
    }
  }

  const content = `import { defineType } from "sanity"

export const ${varName} = defineType({
  name: "${sanityName}",
  title: "${meta.displayName}",
  type: "document",
  fields: [
${fields.join(",\n")}
  ],
})
`

  writeFileSync(resolve(outDir, `${sanityName}.ts`), content)
  console.log(`  Generated: ${sanityName}.ts`)
}

// Generate index file
const imports = schemaNames.map((n) => `import { ${n}Schema } from "./${n}"`).join("\n")
const exports = `export const blockSchemas = [\n${schemaNames.map((n) => `  ${n}Schema`).join(",\n")}\n]\n`
writeFileSync(resolve(outDir, "index.ts"), `${imports}\n\n${exports}`)
console.log(`\nGenerated ${schemaNames.length} block schemas + index.ts`)
