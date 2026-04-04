# Block System

Activate this skill when adding or modifying blocks, editing block props, or working with block rendering and validation.

## Block Registry

All 20 block types are registered in `packages/shared/src/blocks/*.ts` via `registerBlock(type, { schema, meta })`. The private maps `_blockSchemas` and `_blockMeta` hold the Zod schema and metadata for each type.

**API:**
- `registerBlock(type, config)` — register a block type with schema and meta
- `getBlockMeta(type)` — get metadata for a block type
- `getAllBlockMeta()` — get all registered metadata
- `isFieldInlineEditable(type, fieldPath)` — check if a field supports inline editing
- `validateBlockProps(type, props)` — Zod `safeParse` shorthand
- `getImageFields(type)` — get Set of scalar image field keys
- `getListImageFields(type)` — get Map of list key → Set of image field keys
- `isChrome(type)` — check if block is structurally pinned (SiteHeader, Footer)
- `defaultPropsForType(type)` — get default props for a block type

## Block Types and Props

| Block | Required props | Optional props |
|---|---|---|
| **Hero** | `heading`, `subheading`, `ctaText`, `ctaHref`, `imageUrl`, `imageAlt` | `imagePosition` (enum: left/right/full, default right), `textAlign` (enum: left/center, default left), `eyebrow`, `secondaryCtaText`, `secondaryCtaHref` |
| **FeatureGrid** | `title`, `features: [{title, description}]+` | `columns` (enum: 2/3/4, default 3), `features[].icon` (emoji or image URL) |
| **Testimonials** | `title`, `items: [{quote, author}]+` | `items[].role`, `items[].imageUrl`, `items[].imageAlt` |
| **FAQAccordion** | `title`, `items: [{q, a}]+` | — (answer `a` supports richtext: bold, italic, links, lists) |
| **CTA** | `title`, `description`, `ctaText`, `ctaHref` | `secondaryCtaText`, `secondaryCtaHref` |
| **Card** | `title`, `description`, `ctaText`, `ctaHref` | `imageUrl`, `imageAlt`, `variant` (enum: default/full-bleed) |
| **CardGrid** | `title`, `cards: [{title, description, ctaText, ctaHref}]+` | `subtitle`, `columns` (enum: 2/3/4, default 3), `cardVariant` (enum: default/full-bleed), `cards[].imageUrl`, `cards[].imageAlt` |
| **RichText** | `body` | `title` (empty string allowed) |
| **Stats** | `stats: [{value, label}]+` | `title`, `stats[].icon` (emoji or image URL), `stats[].description` |
| **TwoColumn** | `left: [child]+`, `right: [child]+` | `variant` (enum: default/accent) — children: `{type, text?, label?, href?, src?, alt?, items?, buttons?}` |
| **Banner** | `text` | `variant` (enum: info/success/warning, default info), `ctaText`, `ctaHref`, `backgroundColor` (CSS color), `textColor` (CSS color) |
| **Tabs** | `tabs: [{label, content}]+` | `title` (content supports richtext) |
| **Table** | `headers: [string]+`, `rows: [[string]]+` | `title`, `striped` (enum: true/false) |
| **Quote** | `quote` | `author`, `role`, `imageUrl`, `imageAlt` |
| **Carousel** | `items: [{imageUrl}]+` | `autoplay` (enum: true/false), `interval`, `items[].imageAlt`, `items[].heading`, `items[].description`, `items[].ctaText`, `items[].ctaHref` |
| **Gallery** | `images: [{imageUrl}]+` | `title`, `columns` (enum: 2/3/4, default 3), `images[].alt`, `images[].caption` |
| **Embed** | `url` | `embedType` (enum: map/social/custom), `title`, `aspectRatio` (enum: 16:9/4:3/1:1) |
| **Video** | `src` | `title`, `posterUrl`, `autoplay` (enum: true/false), `loop` (enum: true/false) |
| **SiteHeader** *(chrome)* | `siteName`, `logoUrl`, `links: [{label}]+` | `links[].href`, `links[].children: [{label, href}]`, `activePath` |
| **Footer** *(chrome)* | `copyright`, `columns: [{title, links}]+` | — (links format: `"Label\|URL"` per line) |

All string fields use `.min(1)` except `RichText.title`, `Stats.title`, `Tabs.title`, and `Banner` custom color fields.

## Variant Notes

- **Hero `textAlign: "center"`** — centers text over the image; best combined with `imagePosition: "full"` for full-width background hero
- **Hero `eyebrow`** — small uppercase label above the heading (e.g. "New", "Coming Soon")
- **Card/CardGrid `full-bleed`** — background image fills the card with a dark gradient overlay, white text on top. Requires `imageUrl`.
- **Banner `backgroundColor`/`textColor`** — CSS color values that override the variant preset colors. Use for brand-specific banner colors.
- **FeatureGrid/CardGrid `columns`** — explicit column count; default `"3"` uses auto-fit responsive grid
- **FAQAccordion answers** — support richtext: `**bold**`, `*italic*`, `[link](url)`, `- list items`, `\n\n` paragraph breaks

## Block Rendering

**Renderers:** `packages/blocks/src/blocks/*/renderer.tsx` — one file per block type, all exported from `packages/blocks/src/blocks/index.ts`.

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
type FieldKind = "text" | "richtext" | "url" | "image" | "imageAlt" | "enum" | "color" | "number" | "headingLevel"
type FieldMeta = { kind: FieldKind; label?: string; inlineEditable?: boolean; options?: string[]; imageSpec?: ImageSpec }
type ListFieldMeta = { label?: string; itemFields: Record<string, FieldMeta> }
type BlockMeta = {
  displayName: string; description?: string
  category?: "content" | "media" | "navigation" | "conversion" | "layout"
  chrome?: boolean  // structurally pinned (SiteHeader, Footer)
  fields: Record<string, FieldMeta>
  listFields?: Record<string, ListFieldMeta>
}
```

**Field helper shortcuts** (`packages/shared/src/blocks/_helpers.ts`):
- `f.text(label)` — single-line text, inline-editable
- `f.longtext(label)` — multiline text, inline-editable
- `f.richtext(label)` — richtext with markdown support
- `f.url(label)` — URL input, not inline-editable
- `f.image(label, imageSpec?)` — image picker
- `f.imageAlt(label)` — alt text
- `f.headingLevel()` — h1–h6 selector

Inline editability: `text` and `richtext` fields are inline-editable by default; `url`, `image`, `enum`, `color` are not.

## Chrome Blocks

SiteHeader and Footer have `chrome: true` — they are structurally pinned, cannot be added/moved/removed via the editor. Only their props can be updated.

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

## Operations (16 types)

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
| `update_site_config` | Site settings | `patch: {name?, logo?, navLabels?, navGroups?}` |

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

| Area | Files |
|---|---|
| Block schemas & meta | `packages/shared/src/blocks/*.ts` (one per block) |
| Registry & types | `packages/shared/src/blocks/_registry.ts` |
| Field helpers | `packages/shared/src/blocks/_helpers.ts` |
| Barrel exports & defaults | `packages/shared/src/blocks/index.ts` |
| Block renderers | `packages/blocks/src/blocks/*/renderer.tsx` |
| Block styles | `packages/blocks/src/blocks/*/styles.css` |
| Shared components | `packages/blocks/src/blocks/_shared.tsx` (buttons, renderInline, renderRichTextContent) |
| Block image component | `packages/blocks/src/blocks/block-image.tsx` |
| AI planner contracts | `apps/orchestrator/src/nlp/deterministic-planner-suggestions.ts` |
| Page & op schemas | `packages/shared/src/schemas.ts` |
