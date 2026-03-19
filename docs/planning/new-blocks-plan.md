# New Blocks Plan

10 new blocks to add, based on AEM EDS gap analysis. Implementing one at a time.

## Blocks

| # | Block | Category | Status |
|---|---|---|---|
| 1 | **Embed** | media | **Up next** |
| 2 | Separator | layout | Pending |
| 3 | Banner | content | Pending |
| 4 | Quote | content | Pending |
| 5 | LogoGrid | content | Pending |
| 6 | Table | content | Pending |
| 7 | Gallery | media | Pending |
| 8 | Video | media | Pending |
| 9 | Carousel | content | Pending |
| 10 | Tabs | content | Pending |

## Per-Block Spec

### 1. Embed
External content — YouTube, Vimeo, Google Maps, custom iframe.
- **Props**: `embedType: "youtube"|"vimeo"|"map"|"custom"`, `url`, `title`, `aspectRatio: "16:9"|"4:3"|"1:1"`
- **Renderer**: Responsive iframe wrapper with aspect ratio, extract video ID from URL
- **Files**: `packages/shared/src/blocks/embed.ts`, `packages/blocks/src/blocks/embed/renderer.tsx`

### 2. Separator
Visual divider between sections.
- **Props**: `style: "line"|"dots"|"space"`, `spacing: "sm"|"md"|"lg"`
- **Renderer**: `<hr>` variant or spacer div
- **Files**: `packages/shared/src/blocks/separator.ts`, `packages/blocks/src/blocks/separator/renderer.tsx`

### 3. Banner
Full-width announcement/alert bar.
- **Props**: `text`, `variant: "info"|"success"|"warning"`, `ctaText`, `ctaHref`
- **Renderer**: Colored bar with text + optional CTA button
- **Files**: `packages/shared/src/blocks/banner.ts`, `packages/blocks/src/blocks/banner/renderer.tsx`

### 4. Quote
Pull quote / blockquote with attribution.
- **Props**: `quote`, `author`, `role`, `imageUrl`
- **Renderer**: Styled blockquote with optional author avatar, large quotation marks
- **Files**: `packages/shared/src/blocks/quote.ts`, `packages/blocks/src/blocks/quote/renderer.tsx`

### 5. LogoGrid
"Trusted by..." partner/client logo strip.
- **Props**: `title`, `logos[]{imageUrl, alt, href}`
- **Renderer**: Horizontal logo row, responsive wrap, optional links
- **Files**: `packages/shared/src/blocks/logo-grid.ts`, `packages/blocks/src/blocks/logo-grid/renderer.tsx`

### 6. Table
Data table with headers and rows.
- **Props**: `title`, `headers[]`, `rows[][]`, `striped: boolean`
- **Renderer**: Responsive `<table>` with optional stripe styling, horizontal scroll on mobile
- **Files**: `packages/shared/src/blocks/table.ts`, `packages/blocks/src/blocks/table/renderer.tsx`

### 7. Gallery
Image grid layout with captions.
- **Props**: `title`, `columns: 2|3|4`, `images[]{imageUrl, alt, caption}`
- **Renderer**: CSS grid, responsive columns, optional caption overlay
- **Files**: `packages/shared/src/blocks/gallery.ts`, `packages/blocks/src/blocks/gallery/renderer.tsx`

### 8. Video
Direct video playback with poster.
- **Props**: `src`, `posterUrl`, `title`, `autoplay: boolean`, `loop: boolean`
- **Renderer**: HTML5 `<video>` with poster, controls, responsive wrapper
- **Files**: `packages/shared/src/blocks/video.ts`, `packages/blocks/src/blocks/video/renderer.tsx`

### 9. Carousel
Image/content slideshow with navigation.
- **Props**: `items[]{imageUrl, imageAlt, heading, description}`, `autoplay: boolean`, `interval: number`
- **Renderer**: CSS scroll-snap slider, prev/next buttons, dot indicators
- **Files**: `packages/shared/src/blocks/carousel.ts`, `packages/blocks/src/blocks/carousel/renderer.tsx`

### 10. Tabs
Switchable content panels.
- **Props**: `tabs[]{label, content}` (content is rich text)
- **Renderer**: Tab bar + panels, accessible with aria-roles
- **Files**: `packages/shared/src/blocks/tabs.ts`, `packages/blocks/src/blocks/tabs/renderer.tsx`

## Per-Block Checklist
For each block:
- [ ] Create schema file in `packages/shared/src/blocks/`
- [ ] Create renderer in `packages/blocks/src/blocks/`
- [ ] Add import to `packages/shared/src/blocks/index.ts`
- [ ] Add export to `packages/blocks/src/blocks/index.ts`
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] Renders in site preview

## Patterns Reference
- Schema example: `packages/shared/src/blocks/card-grid.ts`
- Renderer example: `packages/blocks/src/blocks/card-grid/renderer.tsx`
- Registry: `packages/shared/src/blocks/_registry.ts`
- Field helpers: `packages/shared/src/blocks/_helpers.ts`
- Shared components: `packages/blocks/src/blocks/_shared.tsx`
