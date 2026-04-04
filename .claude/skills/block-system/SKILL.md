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
- `getImageFields(blockType)` — get Set of image prop keys
- `getListImageFields(blockType)` — get Map<listKey, Set<imageFieldKey>> for list items
- `isChrome(type)` — check if block is chrome (pinned, non-removable)
- `defaultPropsForType(type)` — get default props for a block type

## Block Types and Props

| Block | Required props | Optional props |
|---|---|---|
| **Hero** | `heading`, `subheading`, `ctaText`, `ctaHref`, `imageUrl`, `imageAlt` | `imagePosition` (enum: left/right/full, default right), `textAlign` (enum: left/center, default left), `eyebrow`, `secondaryCtaText`, `secondaryCtaHref` |
| **FeatureGrid** | `title`, `features: [{title, description, icon?}]+` | `columns` (enum: 2/3/4, default 3) |
| **Testimonials** | `title`, `items: [{quote, author, role?, imageUrl?, imageAlt?}]+` | — |
| **FAQAccordion** | `title`, `items: [{q, a}]+` | — (answer `a` supports richtext) |
| **CTA** | `title`, `description`, `ctaText`, `ctaHref` | `secondaryCtaText`, `secondaryCtaHref` |
| **Card** | `title`, `description`, `ctaText`, `ctaHref` | `imageUrl`, `imageAlt`, `variant` (enum: default/full-bleed) |
| **CardGrid** | `title`, `cards: [{title, description, ctaText, ctaHref, imageUrl?, imageAlt?}]+` | `subtitle`, `columns` (enum: 2/3/4, default 3), `cardVariant` (enum: default/full-bleed) |
| **RichText** | `body` | `title` (empty string allowed) |
| **Stats** | `stats: [{value, label, icon?, description?}]+` | `title` |
| **TwoColumn** | `left: [TwoColumnChild]+`, `right: [TwoColumnChild]+` | `variant` (enum: default/accent) |
| **Footer** | `copyright`, `columns: [{title, links}]+` | — (chrome block) |
| **SiteHeader** | `siteName`, `logoUrl`, `links: [{label, href?, children?}]+` | `activePath` (chrome block) |
| **Embed** | `url` | `embedType` (enum: map/social/custom), `title`, `aspectRatio` (enum: 16:9/4:3/1:1) |
| **Banner** | `text` | `variant` (enum: info/success/warning), `ctaText`, `ctaHref`, `backgroundColor`, `textColor` |
| **Carousel** | `items: [{imageUrl, imageAlt?, heading?, description?, ctaText?, ctaHref?}]+` | `autoplay` (enum: true/false), `interval` |
| **Gallery** | `images: [{imageUrl, alt?, caption?}]+` | `title`, `columns` (enum: 2/3/4, default 3) |
| **Tabs** | `tabs: [{label, content}]+` | `title` |
| **Table** | `headers: [string]+`, `rows: [[string]]+` | `title`, `striped` (enum: true/false) |
| **Quote** | `quote` | `author`, `role`, `imageUrl`, `imageAlt` |
| **Video** | `src` | `title`, `posterUrl`, `autoplay` (enum: true/false), `loop` (enum: true/false) |

All string fields use `.min(1)` except `RichText.title`, `Stats.title`, and `Tabs.title`.

All blocks support an optional `headingLevel` prop (h1–h6) via metadata.

## Chrome Blocks

**Footer** and **SiteHeader** have `chrome: true`. They are structurally pinned — cannot be added, moved, or removed via the editor. They are always present (header first, footer last).

## Block Rendering

**Renderers:** `packages/blocks/src/blocks/*/renderer.tsx` — each block has its own renderer file.

**Dispatch:** `packages/blocks/src/blocks/index.ts` exports a `renderers` map. `SharedBlockRenderer` in `packages/blocks/src/renderer.tsx` looks up `block.type` and spreads props.

```typescript
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
type FieldMeta = { kind: FieldKind; label?: string; inlineEditable?: boolean; options?: string[]; imageSpec?: ImageSpec; multiline?: boolean }
type ListFieldMeta = { label?: string; itemFields: Record<string, FieldMeta> }
type BlockMeta = {
  displayName: string; description?: string
  category?: "content" | "media" | "navigation" | "conversion" | "layout"
  chrome?: boolean
  fields: Record<string, FieldMeta>
  listFields?: Record<string, ListFieldMeta>
}
```

**Field helper shortcuts** (`_helpers.ts`): `f.text()`, `f.longtext()`, `f.richtext()`, `f.url()`, `f.image()`, `f.imageAlt()`, `f.headingLevel()`.

Inline editability: `text` and `richtext` fields are inline-editable by default; `url`, `image`, `enum`, `color` are not.

`isFieldInlineEditable` handles nested paths like `features[0].title` by splitting on bracket notation to look up `listFields.features.itemFields.title`.

## Variant Patterns

Several blocks support visual variants:

| Block | Prop | Values | Effect |
|---|---|---|---|
| Hero | `imagePosition` | left, right, full | Two-column split or full-width background image |
| Hero | `textAlign` | left, center | Text alignment (center works best with imagePosition full) |
| Card | `variant` | default, full-bleed | Standard card or background image with dark overlay |
| CardGrid | `cardVariant` | default, full-bleed | Applied to all cards in the grid |
| TwoColumn | `variant` | default, accent | Accent adds styling emphasis |
| Banner | `variant` | info, success, warning | Preset color theme |
| Banner | `backgroundColor`/`textColor` | CSS color strings | Custom colors override variant |
| Gallery | `columns` | 2, 3, 4 | Grid column count |
| FeatureGrid | `columns` | 2, 3, 4 | Grid column count |
| CardGrid | `columns` | 2, 3, 4 | Grid column count |
| Embed | `aspectRatio` | 16:9, 4:3, 1:1 | iframe aspect ratio |
| Table | `striped` | true, false | Alternating row backgrounds |

## Icon Fields

FeatureGrid and Stats support an `icon` field per item. The value can be:
- **Emoji** — rendered as `<span>` (e.g., `"⚡"`, `"🛡️"`)
- **Image URL** — rendered as `<img>` when the value starts with `http://` or `https://`

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

| File | Purpose |
|---|---|
| `packages/shared/src/blocks/_registry.ts` | Registry, types, core functions |
| `packages/shared/src/blocks/_helpers.ts` | Field helper shortcuts (f), heading level resolution |
| `packages/shared/src/blocks/index.ts` | Barrel imports, defaults map |
| `packages/shared/src/blocks/*.ts` | Individual block definitions (20 files) |
| `packages/shared/src/schemas.ts` | Page, operation, EditPlan schemas |
| `packages/blocks/src/blocks/index.ts` | Renderer map & registration |
| `packages/blocks/src/blocks/*/renderer.tsx` | Individual block React components |
| `packages/blocks/src/blocks/*/styles.css` | Individual block styles |
| `packages/blocks/src/blocks/_shared.tsx` | Shared components (PrimaryButton, SecondaryButton, BlockImage, renderInline, renderRichTextContent) |
| `apps/orchestrator/src/nlp/deterministic-planner-suggestions.ts` | AI planner block contracts & notes |
