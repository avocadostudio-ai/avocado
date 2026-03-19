# shadcn/ui Editor Migration Plan

## Completed (Phase 1)

- Tailwind v4 + `@tailwindcss/vite` wired into editor
- `@theme` block mapping existing CSS vars to shadcn semantic tokens
- Dark mode via `@variant dark` + `.editor-dark` CSS variable overrides
- `cn()` utility, `components.json` (new-york style, rsc: false)
- shadcn components installed: button, input, label, switch, dialog, tabs, select, badge
- Settings modal (`SettingsModal.tsx`) migrated to shadcn Dialog + Switch + Select
- ~200 lines of settings CSS deleted from `styles.css`

Git tag `pre-shadcn-editor` marks the state before any shadcn changes.

### Known pattern: Radix portals + dark mode

Radix Dialog/Select portal content to `<body>`, outside the `.editor-dark` DOM tree. Any component using portaled shadcn primitives must:

1. Conditionally add `className="editor-dark"` to the portaled content wrapper
2. Add `font-sans` to ensure Manrope is applied
3. Add `text-foreground` or `text-secondary-foreground` for proper text color inheritance

See `SettingsModal.tsx` for the reference implementation.

---

## Phase 2: Migrate buttons app-wide

Replace hand-written button classes with shadcn `<Button>`.

| Old class | shadcn replacement |
|---|---|
| `.primary-btn` | `<Button>` (default variant) |
| `.secondary-btn` | `<Button variant="secondary">` |
| `.composer-ghost-btn` | `<Button variant="ghost" size="icon">` |

### Files to touch

- `src/App.tsx` — `primary-btn msg-plan-btn`, `secondary-btn msg-plan-btn`, `secondary-btn` (site config)
- `src/components/SitesPage.tsx` — 10+ button instances across create/config/restore modals
- `src/components/claude-style-chat-input.tsx` — `composer-ghost-btn` (plus, voice, selector)

### Notes

- Buttons with compound classes (e.g. `primary-btn msg-plan-btn`) need the contextual class kept or migrated to `className` prop
- `composer-ghost-btn` has `.is-active` state toggling — use `data-[state=active]` or conditional `variant`
- After migration, delete `.primary-btn`, `.secondary-btn`, `.composer-ghost-btn` and all dark mode overrides from `styles.css`

---

## Phase 3: Migrate modals + forms

### Image picker modal (`ImagePickerModal.tsx`)

- Replace custom modal backdrop/container with shadcn `Dialog`
- Replace tabs (URL / Unsplash / Generate) with shadcn `Tabs`
- Replace text inputs with shadcn `Input`
- Apply portal dark mode pattern

### Add block picker (inline in `App.tsx`)

- Replace `.add-block-picker` with shadcn `Dialog` or `Popover`
- Search input → shadcn `Input`
- Block option buttons → styled with `Button variant="ghost"`

### Site config modal (`App.tsx` + `SitesPage.tsx`)

- `.sites-modal` / `.sites-modal-backdrop` → shadcn `Dialog`
- Tab switching (overview/tone/constraints, general/brief/deploy) → shadcn `Tabs`
- Form fields → shadcn `Input` + `Label`
- `.settings-close-btn` buttons → shadcn `DialogClose` (then delete `.settings-close-btn` CSS)

### Variation modal

- `.variation-modal-backdrop` / `.variation-modal` → shadcn `Dialog`

### Property panel forms

- Complex nested field rendering — evaluate whether shadcn `Input`/`Label`/`Select` fit
- AI shimmer animations must be preserved
- Lower priority — only migrate if it simplifies code

---

## Phase 4: Dark mode consolidation

Currently ~750 lines of `.editor-dark` overrides in `styles.css`. Goal: replace with CSS variable swap + Tailwind `dark:` utilities.

### Approach

1. Move all color definitions to CSS custom properties in `:root` and `.editor-dark`
2. Replace `.editor-dark .some-class { color: X }` with `dark:text-X` utilities on the element
3. Keep `@variant dark (&:where(.editor-dark, .editor-dark *))` so `dark:` maps to `.editor-dark`
4. Delete `.editor-dark` override blocks from `styles.css` as they're replaced

### What stays as CSS

- `@keyframes` animations
- Complex layout (grid templates, sticky positioning)
- Pseudo-element styles (`:before`, `:after`)
- Non-color dark overrides (box-shadow, gradients)

---

## Phase 5: Chat UI polish (optional)

Selective Tailwind adoption for chat-specific elements — NOT a full rewrite.

- Message suggestion pills → shadcn `Badge`
- Debug detail panels → Tailwind utility classes
- Streaming indicator → keep custom CSS animations
- Message action buttons (copy, undo) → `Button variant="ghost" size="icon-xs"`

Chat thread, message bubbles, composer shell, and all animations stay as custom CSS.
