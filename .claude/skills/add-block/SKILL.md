# Adding a New Block Type (E2E Guide)

Activate this skill when adding a new block type to the site editor. This covers the full process from schema to rendering to styling.

## Overview

Adding a block requires changes to **3 files** (+ 1 optional). No routing, wiring, or config changes needed — the registry auto-populates `allowedBlockTypes`, `SharedBlockRenderer` dispatches dynamically, and the planner auto-derives prop contracts from the Zod schema.

| File | What to add |
|---|---|
| `packages/shared/src/index.ts` | `registerBlock()` call with Zod schema + `BlockMeta` |
| `packages/blocks/src/renderer.tsx` | React component + entry in `renderers` map |
| `apps/site/app/globals.css` | CSS for the block + mobile breakpoint rules |
| `apps/orchestrator/src/nlp/deterministic-planner.ts` | *(optional)* Entry in `_blockNotes` for LLM guidance |

## Step 1 — Define the Schema & Metadata

In `packages/shared/src/index.ts`, add a `registerBlock()` call **after the last existing registration** (before the "Backwards-compatible exports" comment).

### Schema rules

- Use `z.object({...})` for the props shape
- Scalar strings: `z.string().min(1)` (required) or `z.string().optional()` (optional)
- Arrays: `z.array(z.object({...})).min(1)`
- Enums: `z.enum(["value1", "value2"]).default("value1")`
- Optional title (can be empty): `z.string()` without `.min(1)`

### Metadata structure

```typescript
registerBlock("MyBlock", {
  schema: z.object({ /* ... */ }),
  meta: {
    displayName: "My Block",           // Human-readable name
    description: "What this block does.", // For AI context
    category: "content",               // "content" | "media" | "navigation" | "conversion" | "layout"
    fields: {
      title: f.text("Section title"),  // Use the `f` helpers
      body: f.richtext("Body text"),
      imageUrl: f.image("Image"),
      imageAlt: f.imageAlt("Image alt text"),
      ctaHref: f.url("Button link"),
      someEnum: { kind: "enum", label: "Position", options: ["left", "right"], inlineEditable: false },
    },
    listFields: {                      // Only if the block has array props
      items: {
        label: "Items",
        itemFields: {
          title: f.text("Item title"),
          description: f.text("Item description"),
        }
      }
    }
  }
})
```

### Field helper shortcuts (`f`)

| Helper | Kind | Inline editable? |
|---|---|---|
| `f.text(label)` | `text` | Yes |
| `f.richtext(label)` | `richtext` | Yes |
| `f.url(label)` | `url` | No |
| `f.image(label)` | `image` | No |
| `f.imageAlt(label)` | `imageAlt` | Yes |

For `enum` fields, specify the full `FieldMeta` object (no shortcut).

### Update the type union

Add the new block name to the type union in the `blockSchemas` export:

```typescript
export const blockSchemas = _blockSchemas as Record<string, z.ZodObject<any>> & {
  [K in "Hero" | ... | "MyBlock"]: z.ZodObject<any>
}
```

## Step 2 — Create the Renderer Component

In `packages/blocks/src/renderer.tsx`, add a function **above** the `renderers` map.

### Patterns to follow

1. **Props type:** Always `Record<string, unknown>` — never typed props
2. **Defensive coercion:** `String(props.field ?? "")` for every string field
3. **Array fields:** `Array.isArray(props.items) ? props.items : []`
4. **Array item access:** `const row = (item ?? {}) as Record<string, unknown>`
5. **Editable attributes on every element that maps to a prop:**

```tsx
// Scalar prop
<h2
  data-editable-target="title"
  data-editable-target-label="title"
  data-editable-label="title"
>
  {String(props.title ?? "")}
</h2>

// Array item field
<span
  data-editable-target={`items[${idx}].value`}
  data-editable-target-label={`items[${idx}].value`}
  data-editable-label={`items[${idx}].value`}
>
  {String(row.value ?? "")}
</span>
```

6. **Conditional rendering** for optional props: `{title.length > 0 && (<h2>...</h2>)}`
7. **Use existing components:** `PrimaryButton`, `SecondaryButton` for CTA links
8. **Rich text content:** Use `renderInline(text)` for bold/italic/link markup support

### Add to the renderers map

```typescript
const renderers: Record<string, (props: Record<string, unknown>) => JSX.Element | null> = {
  // ...existing...
  MyBlock,
}
```

### Semantic element choice

- Most blocks: `<section>` wrapper with `<div className="section__inner">`
- Footer: Use `<footer>` instead of `<section>` (add full-width styles manually since `section` rules don't apply)
- Lists of items: `<div>` grid or `<ul>` depending on semantics

## Step 3 — Add CSS Styles

In `apps/site/app/globals.css`, add styles **before** the `@media (max-width: 900px)` block, and mobile overrides **inside** it.

### Desktop styles checklist

- Block wrapper class (e.g. `.my-block`)
- Inner layout (grid or flex)
- Typography (font sizes, weights, colors, spacing)
- Use the existing color palette: `#0f172a` (headings), `#334155` / `#1e293b` (body), `#64748b` (muted), `#0f766e` (accent/links)

### Mobile styles (`@media max-width: 900px`)

- Collapse grids to `1fr` column
- Add new grid classes to the existing `grid-template-columns: 1fr` rule if applicable
- Reset any `order` overrides for mobile

### Full-width blocks

Regular `<section>` elements get full-width automatically via existing CSS. Non-section elements (like `<footer>`) need:

```css
.site-footer {
  width: 100vw;
  margin-left: calc(50% - 50vw);
  margin-right: calc(50% - 50vw);
}
```

## Step 4 — Add Planner Notes

The AI planner's `blockContractsSummary()` in `apps/orchestrator/src/nlp/deterministic-planner.ts` **auto-derives** `allowedProps`, `required`, and `optional` from the Zod schema. However, the `notes` field that guides the LLM on how to use each block comes from the `_blockNotes` map.

Add an entry to `_blockNotes` for your block:

```typescript
const _blockNotes: Record<string, string> = {
  // ...existing...
  MyBlock: "items must be a non-empty array of {title, description}. title is an optional heading."
}
```

Good notes should describe:
- Array prop item shapes (e.g. `{title, description}`)
- Enum values and defaults (e.g. `imagePosition is 'left' or 'right'`)
- Special string formats (e.g. `links is one 'Label|URL' per line`)
- Optional prop behavior (e.g. `set both ctaText and ctaHref to show a button`)

If you omit the note, the system falls back to the block's `description` from metadata.

## Step 5 — Verify

```bash
pnpm typecheck   # Must pass — checks all workspaces
pnpm build       # Should pass (ignore pre-existing errors in other packages)
```

No test changes needed — block rendering is schema-driven and the registry auto-wires everything.

## Checklist

- [ ] `registerBlock()` in `packages/shared/src/index.ts` with schema + meta
- [ ] Type union updated in `blockSchemas` export
- [ ] Renderer function in `packages/blocks/src/renderer.tsx`
- [ ] Added to `renderers` map
- [ ] CSS in `apps/site/app/globals.css` (desktop + mobile)
- [ ] `data-editable-target` / `data-editable-target-label` / `data-editable-label` on every editable element
- [ ] `_blockNotes` entry in `apps/orchestrator/src/nlp/deterministic-planner.ts`
- [ ] `pnpm typecheck` passes
- [ ] Update block count in `.claude/skills/block-system/SKILL.md`
