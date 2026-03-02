# Block System

Activate this skill when adding or modifying blocks, editing block props, or working with block rendering and validation.

## Block Registry

All 11 block types are registered in `packages/shared/src/index.ts` via `registerBlock(type, { schema, meta })`. The private maps `_blockSchemas` and `_blockMeta` hold the Zod schema and metadata for each type.

**API:**
- `registerBlock(type, config)` — register a block type with schema and meta
- `getBlockMeta(type)` — get metadata for a block type
- `getAllBlockMeta()` — get all registered metadata
- `isFieldInlineEditable(type, fieldPath)` — check if a field supports inline editing
- `validateBlockProps(type, props)` — Zod `safeParse` shorthand

## Block Types and Props

| Block | Required props | Optional props |
|---|---|---|
| **Hero** | `heading`, `subheading`, `ctaText`, `ctaHref`, `imageUrl`, `imageAlt` | `secondaryCtaText`, `secondaryCtaHref` |
| **FeatureGrid** | `title`, `features: [{title, description}]+` | — |
| **Testimonials** | `title`, `items: [{quote, author}]+` | — |
| **FAQAccordion** | `title`, `items: [{q, a}]+` | — |
| **CTA** | `title`, `description`, `ctaText`, `ctaHref` | — |
| **Card** | `title`, `description`, `ctaText`, `ctaHref` | — |
| **CardGrid** | `title`, `cards: [{title, description, ctaText, ctaHref}]+` | — |
| **RichText** | `body` | `title` (empty string allowed) |
| **Stats** | `stats: [{value, label}]+` | `title` |
| **TwoColumn** | `heading`, `body`, `imageUrl`, `imageAlt` | `imagePosition` (enum: left/right, default right), `ctaText`, `ctaHref` |
| **Footer** | `copyright`, `columns: [{title, links}]+` | — |

All string fields use `.min(1)` except `RichText.title` and `Stats.title`.

## Block Rendering

**Renderer:** `packages/blocks/src/renderer.tsx` — single file containing all 11 block components as module-private functions. Only `SharedBlockRenderer` is exported.

```typescript
// Dispatch: looks up block.type in static map, spreads props
export function SharedBlockRenderer({ block }: { block: BlockInstance }) {
  const Renderer = renderers[block.type]
  if (!Renderer) return null
  return <Renderer {...block.props} />
}
```

Each component defensively casts props (`String(props.field ?? "")`), uses `Array.isArray()` for lists.

**Inline markup:** `renderInline(text)` handles `**bold**`, `*italic*`, `[link](url)` inside text content.

**RichText pipeline:** `normalizeRichTextBody` → split on `\n\n` → `renderRichTextBlock` detects headings, unordered/ordered lists, falls back to `<p>`.

## Editable Attributes

Every renderable prop node carries:
- `data-editable-target="heading"` — prop key or dot-path (e.g., `features[0].title`)
- `data-editable-target-label="heading"` — same, used for CSS `::before` tooltip
- `data-editable-label="heading"` — used for left-floating pill tooltip

**Path format:** scalar props use `"heading"`, array items use bracket notation: `"features[0].title"`, `"items[2].quote"`, `"cards[1].ctaHref"`.

## FieldMeta System

```typescript
type FieldKind = "text" | "richtext" | "url" | "image" | "imageAlt" | "enum" | "color" | "number"
type FieldMeta = { kind: FieldKind; label?: string; inlineEditable?: boolean; options?: string[] }
type ListFieldMeta = { label?: string; itemFields: Record<string, FieldMeta> }
type BlockMeta = {
  displayName: string; description?: string
  category?: "content" | "media" | "navigation" | "conversion" | "layout"
  fields: Record<string, FieldMeta>
  listFields?: Record<string, ListFieldMeta>
}
```

Inline editability: `text` and `richtext` fields are inline-editable by default; `url` and `image` are not.

`isFieldInlineEditable` handles nested paths like `features[0].title` by splitting on bracket notation to look up `listFields.features.itemFields.title`.

## Zod Schemas

```typescript
blockInstanceSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1).refine(t => t in _blockSchemas),
  props: z.record(z.unknown())
})

pageDocSchema = z.object({
  id, slug, title, updatedAt: z.string().min(1),
  blocks: z.array(blockInstanceSchema),
  meta: pageMetaSchema.optional()
})
```

## Operations (15 types)

`operationSchema` — `z.discriminatedUnion("op", [...])`:

| op | Description | Key fields |
|---|---|---|
| `create_page` | Create a new page | `page: PageDoc` |
| `add_block` | Insert a block | `pageSlug`, `block`, `afterBlockId?` |
| `update_props` | Patch scalar props | `pageSlug`, `blockId`, `patch` |
| `remove_block` | Delete a block | `pageSlug`, `blockId` |
| `move_block` | Reorder a block | `pageSlug`, `blockId`, `afterBlockId?` |
| `duplicate_block` | Copy a block | `pageSlug`, `blockId`, `toPageSlug?`, `newBlockId?` |
| `add_item` | Append to list prop | `pageSlug`, `blockId`, `listKey`, `item`, `afterIndex?` |
| `update_item` | Patch list item | `pageSlug`, `blockId`, `listKey`, `index`, `patch` |
| `remove_item` | Delete list item | `pageSlug`, `blockId`, `listKey`, `index` |
| `move_item` | Reorder list item | `pageSlug`, `blockId`, `listKey`, `index`, `afterIndex?` |
| `rename_page` | Change slug/title | `pageSlug`, `newPageSlug`, `newTitle?` |
| `remove_page` | Delete a page | `pageSlug` |
| `move_page` | Reorder a page | `pageSlug`, `afterPageSlug?` |
| `duplicate_page` | Copy a page | `pageSlug`, `newPageSlug?`, `newTitle?` |
| `update_page_meta` | Edit SEO meta | `pageSlug`, `patch: {title?, description?, ogImage?}` |

## EditPlan Schema

```typescript
editPlanSchema = z.object({
  intent: z.enum(["edit_plan", "needs_clarification"]),
  summary_for_user: z.string().min(1),
  change_log: z.array(z.string()),
  ops: z.array(operationSchema)
})
```

## Key Files

- `packages/shared/src/index.ts` — schemas, types, block registry
- `packages/blocks/src/renderer.tsx` — all block components + SharedBlockRenderer
- `apps/site/components/block-renderer.tsx` — site-side wrapper with editable attributes
