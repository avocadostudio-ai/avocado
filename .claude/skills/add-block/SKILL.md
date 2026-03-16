# Adding a New Block Type (E2E Guide)

Activate this skill when adding a new block type to the site editor. This covers schema definition, rendering, styling, and full integration with the editor UI, AI planner, and preview overlay.

## How It Works (Auto-Wiring)

Most integration is **automatic** once a block is registered:

1. **Schema**: Importing the block file triggers `registerBlock()` → adds to `allowedBlockTypes` array
2. **Editor manifest**: `buildComponentsManifest()` iterates `allowedBlockTypes` → derives field metadata and JSON schema automatically → editor fetches via `/api/editor/components`
3. **Property panel**: Editor reads `BlockMeta.fields` and `listFields` → generates inputs by `kind` (text, richtext, image, enum, color, etc.)
4. **AI planner**: `blockContractsSummary()` iterates `allowedBlockTypes` → derives allowed/required/optional props from Zod schema → feeds into LLM prompt
5. **Inline editing**: Preview adapter finds `data-editable-target` attributes → `isFieldInlineEditable()` checks field kind

**Only 3 manual wiring points** (barrel imports):

| File | What to add |
|---|---|
| `packages/shared/src/blocks/index.ts` | Side-effect import + `defaults` map entry |
| `packages/blocks/src/blocks/index.ts` | Renderer import + `renderers` map entry |
| `packages/blocks/src/blocks/styles.css` | `@import` for new block CSS |

No changes needed in `apps/site/`, `apps/editor/`, or `packages/preview-adapter/`.

## Files to Create

| # | File | Purpose |
|---|---|---|
| 1 | `packages/shared/src/blocks/<name>.ts` | `registerBlock()` + Zod schema + `BlockMeta` + default props |
| 2 | `packages/blocks/src/blocks/<name>/renderer.tsx` | React renderer component |
| 3 | `packages/blocks/src/blocks/<name>/styles.css` | Desktop + mobile + dark-mode CSS |

## Step 1 — Define Schema, Metadata & Defaults

Create `packages/shared/src/blocks/<name>.ts`:

```typescript
import { z } from "zod"
import { registerBlock } from "./_registry.ts"
import { f } from "./_helpers.ts"

registerBlock("MyBlock", {
  schema: z.object({
    title: z.string().min(1),
    subtitle: z.string().optional(),
    imageUrl: z.string().min(1),
    imageAlt: z.string().optional(),
    ctaText: z.string().min(1),
    ctaHref: z.string().min(1),
    items: z.array(z.object({
      title: z.string().min(1),
      description: z.string().optional(),
    })).min(1),
  }),
  meta: {
    displayName: "My Block",
    description: "What this block does.",   // Shown in editor + fed to AI
    category: "content",                    // "content" | "media" | "navigation" | "conversion" | "layout"
    fields: {
      title: f.text("Section title"),
      subtitle: f.text("Subtitle"),
      imageUrl: f.image("Image", { aspectRatio: "landscape", width: 800, height: 450 }),
      imageAlt: f.imageAlt("Image alt text"),
      ctaText: f.text("Button label"),
      ctaHref: f.url("Button link"),
    },
    listFields: {
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

export function myBlockDefaultProps(): Record<string, unknown> {
  return {
    title: "Default title",
    subtitle: "",
    imageUrl: "/hero-generated.svg",
    imageAlt: "Decorative image",
    ctaText: "Learn more",
    ctaHref: "/",
    items: [
      { title: "First item", description: "Description here." },
    ],
  }
}
```

### Schema rules

- Required strings: `z.string().min(1)`
- Optional strings: `z.string().optional()`
- Arrays: `z.array(z.object({...})).min(1)`
- Enums: `z.enum(["left", "right"]).default("left")`
- `required` on each `FieldMeta` is **auto-derived** from Zod `.isOptional()` — don't set manually

### Field helper shortcuts (`f`)

| Helper | Kind | Inline editable | Editor input |
|---|---|---|---|
| `f.text(label)` | `text` | Yes | Single-line input |
| `f.longtext(label)` | `text` (multiline) | Yes | Textarea |
| `f.richtext(label)` | `richtext` | Yes | Textarea |
| `f.url(label)` | `url` | No | URL input |
| `f.image(label, imageSpec?)` | `image` | No | Image picker |
| `f.imageAlt(label)` | `imageAlt` | Yes | Single-line input |
| `f.headingLevel()` | `headingLevel` | No | Dropdown (h1–h6) |

For `enum` fields, use the full `FieldMeta` object:
```typescript
someEnum: { kind: "enum", label: "Position", options: ["left", "right"], inlineEditable: false }
```

### `imageSpec` (optional but recommended)

Tells the AI image pipeline the ideal dimensions. The editor and AI planner read this automatically.

```typescript
f.image("Hero image", { aspectRatio: "landscape", width: 1200, height: 600 })
```

## Step 2 — Register in Barrel

In `packages/shared/src/blocks/index.ts`:

1. Add named import: `import { myBlockDefaultProps } from "./<name>.ts"`
2. Add to `defaults` map: `MyBlock: myBlockDefaultProps,`

The side-effect import of the file triggers `registerBlock()`. The named import provides default props for the "add block" flow.

## Step 3 — Create the Renderer

Create `packages/blocks/src/blocks/<name>/renderer.tsx`:

```tsx
import type { JSX } from "react"
import { resolveHeadingTag } from "@ai-site-editor/shared"
import { PrimaryButton, renderInline } from "../_shared"

export function MyBlock(props: Record<string, unknown>): JSX.Element {
  const HeadingTag = resolveHeadingTag("MyBlock", props) as keyof JSX.IntrinsicElements
  const title = String(props.title ?? "")
  const subtitle = String(props.subtitle ?? "")
  const items = Array.isArray(props.items) ? props.items : []

  return (
    <section className="my-block">
      <div className="my-block__inner section__inner">
        {title.length > 0 && (
          <HeadingTag data-editable-target="title" data-editable-target-label="title" data-editable-label="title">
            {renderInline(title)}
          </HeadingTag>
        )}
        {subtitle.length > 0 && (
          <p className="my-block__subtitle" data-editable-target="subtitle" data-editable-target-label="subtitle" data-editable-label="subtitle">
            {renderInline(subtitle)}
          </p>
        )}
        <div className="my-block__grid">
          {items.map((raw, idx) => {
            const item = (raw ?? {}) as Record<string, unknown>
            return (
              <div key={idx} className="my-block__item">
                <h3 data-editable-target={`items[${idx}].title`} data-editable-target-label={`items[${idx}].title`} data-editable-label={`items[${idx}].title`}>
                  {String(item.title ?? "")}
                </h3>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
```

### Renderer patterns

| Pattern | How |
|---|---|
| **Props type** | Always `Record<string, unknown>` — never typed props |
| **String coercion** | `String(props.field ?? "")` for every string field |
| **Array fields** | `Array.isArray(props.items) ? props.items : []` |
| **Array item access** | `const item = (raw ?? {}) as Record<string, unknown>` |
| **Optional rendering** | `{title.length > 0 && <h2>...</h2>}` |
| **Dynamic heading** | `resolveHeadingTag("BlockName", props)` for h1–h6 |
| **Rich text** | `renderRichTextContent(text)` for block-level, `renderInline(text)` for inline |
| **Buttons** | `PrimaryButton`, `SecondaryButton` from `../_shared` |
| **Wrapper element** | `<section>` with `.section__inner` for most blocks; `<footer>` for footer-type |

### Inline editing data attributes

Every element that maps to an editable prop **must** have these three attributes for the preview overlay and inline editing to work:

```tsx
// Scalar prop
<h2
  data-editable-target="title"
  data-editable-target-label="title"
  data-editable-label="title"
>

// Array item field
<span
  data-editable-target={`items[${idx}].value`}
  data-editable-target-label={`items[${idx}].value`}
  data-editable-label={`items[${idx}].value`}
>
```

Without these: the field won't be selectable or inline-editable in the editor preview.

## Step 4 — Add CSS Styles

Create `packages/blocks/src/blocks/<name>/styles.css`:

```css
/* Desktop */
.my-block { background: var(--section-bg); }

.my-block__inner {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 24px;
}

.my-block__inner > h2 { /* heading styles from _base.css apply automatically via .section__inner > h2 */ }

/* Dark mode overrides (only if defaults don't work) */
.dark .my-block__item { border-color: var(--border); }

/* Mobile */
@media (max-width: 900px) {
  .my-block__inner { grid-template-columns: 1fr; }
}
```

### CSS variables available (from theme)

| Variable | Purpose |
|---|---|
| `var(--brand)` | Primary brand color |
| `var(--brand-fg)` | Text on brand background |
| `var(--brand-subtle)` | Light brand tint |
| `var(--heading)` | Heading text color |
| `var(--text-100)` | Body text color |
| `var(--text-200)` | Muted/secondary text |
| `var(--bg-0)` | Page background |
| `var(--bg-1)` | Card/surface background |
| `var(--section-bg)` | Section alternating background |
| `var(--border)` | Border color |
| `var(--radius-btn)` | Button border radius |
| `var(--radius-card)` | Card border radius |

### Base styles inherited automatically

- `section` gets full-width bleed + padding from `_base.css`
- `.section__inner` gets `max-width: 960px; margin: 0 auto`
- `.section__inner > h2` gets heading font styles
- `.btn-primary` / `.btn-secondary` get button styles + dark overrides

## Step 5 — Register CSS

In `packages/blocks/src/blocks/styles.css`, add:

```css
@import "./<name>/styles.css";
```

## Step 6 — Register Renderer

In `packages/blocks/src/blocks/index.ts`:

1. Add import: `import { MyBlock } from "./<name>/renderer"`
2. Add to `renderers` object: `MyBlock,`

## Step 7 — Add AI Planner Notes (Optional)

The AI planner auto-derives prop contracts from the Zod schema. For blocks with complex semantics, add a hint to `_blockNotes` in `apps/orchestrator/src/nlp/deterministic-planner-suggestions.ts`:

```typescript
const _blockNotes: Record<string, string> = {
  // ...existing...
  MyBlock: "items must be a non-empty array of {title, description}. title is an optional heading."
}
```

Good notes describe:
- Array item shapes (e.g. `{title, description}`)
- Enum values and defaults (e.g. `imagePosition is 'left' or 'right'`)
- Special formats (e.g. `links is one 'Label|URL' per line`)
- Conditional visibility (e.g. `set both ctaText and ctaHref to show a button`)

Skip this step for simple blocks — the auto-generated contract is usually sufficient.

## Step 8 — Create Focused Test

Create `packages/blocks/src/blocks/<name>/renderer.test.ts` to validate the block in isolation:

```typescript
import test from "node:test"
import assert from "node:assert/strict"
import { validateBlockProps, getBlockMeta, defaultPropsForType } from "@ai-site-editor/shared"
import { renderers } from "../index"

const BLOCK_TYPE = "MyBlock"

test(`${BLOCK_TYPE}: registered in block registry`, () => {
  const meta = getBlockMeta(BLOCK_TYPE)
  assert.ok(meta, `${BLOCK_TYPE} not found in registry`)
  assert.ok(meta.displayName, "missing displayName")
  assert.ok(meta.category, "missing category")
})

test(`${BLOCK_TYPE}: default props pass schema validation`, () => {
  const props = defaultPropsForType(BLOCK_TYPE)
  const result = validateBlockProps(BLOCK_TYPE, props)
  assert.equal(result.success, true, `Schema validation failed: ${JSON.stringify(result.success ? null : result.error.issues)}`)
})

test(`${BLOCK_TYPE}: renderer is registered`, () => {
  assert.ok(renderers[BLOCK_TYPE], `No renderer found for ${BLOCK_TYPE}`)
  assert.equal(typeof renderers[BLOCK_TYPE], "function")
})
```

Adapt the `BLOCK_TYPE` constant and add block-specific schema validation tests:
- Test that required props are enforced (empty string rejected, missing fields rejected)
- Test that enum fields reject invalid values
- Test that optional fields work with and without values
- Test array fields with empty arrays if applicable

**Note:** Avoid `renderToStaticMarkup` in tests — the JSX automatic runtime (`react-jsx`) doesn't inject React globals needed for server rendering in the test runner. Focus tests on schema validation, metadata, and renderer registration.

**Note:** Test files are excluded from `packages/blocks/tsconfig.json` via `"exclude": ["src/**/*.test.ts"]` since the blocks package doesn't have `@types/node`. Tests run via `tsx` directly which handles this. This is already configured — no changes needed.

## Step 9 — Verify (iterate until green)

Run verification commands and **fix any errors before moving on**. If typecheck or tests fail, read the error output, fix the issue, and re-run until both pass. Do not skip this step.

```bash
pnpm typecheck   # Must pass — all workspaces
pnpm test        # All tests should pass
```

The existing `buildComponentsManifest` test in `apps/site/test/editor-components-manifest.test.ts` automatically validates that every registered block has a valid schema and valid default props. This means your new block is already covered — if the schema or defaults are wrong, this test will catch it.

**If typecheck fails:** fix type errors in the schema or renderer, then re-run.
**If tests fail:** check that `defaultProps` satisfies all required schema fields and that the `registerBlock()` call has correct metadata. Fix and re-run.

Keep iterating until both commands pass with zero errors.

Then manually verify in the running app:
- Block appears in editor's "add block" list (auto via manifest)
- Property panel renders correct inputs for each field (auto via metadata)
- Inline editing works on text/richtext fields (requires `data-editable-target`)
- AI can create and edit the block (auto via schema contracts)
- Dark mode and mobile responsive styles look correct

## Checklist

**Create:**
- [ ] `packages/shared/src/blocks/<name>.ts` — `registerBlock()` + default props function
- [ ] `packages/blocks/src/blocks/<name>/renderer.tsx` — React component with `data-editable-*` attributes
- [ ] `packages/blocks/src/blocks/<name>/styles.css` — Desktop + mobile + dark CSS
- [ ] `packages/blocks/src/blocks/<name>/renderer.test.ts` — Focused test (registry, schema, render)

**Wire (3 barrel files):**
- [ ] `packages/shared/src/blocks/index.ts` — import + `defaults` map entry
- [ ] `packages/blocks/src/blocks/index.ts` — import + `renderers` map entry
- [ ] `packages/blocks/src/blocks/styles.css` — `@import` line

**Optional:**
- [ ] `apps/orchestrator/src/nlp/deterministic-planner-suggestions.ts` — `_blockNotes` entry

**Verify (iterate until green):**
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes (including new block-specific test)
- [ ] If either fails, fix and re-run until both pass
- [ ] Block renders on site
- [ ] Editor property panel works
- [ ] Inline editing works in preview
- [ ] AI can add/edit the block
