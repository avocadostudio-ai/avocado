# Property Editor Improvements

## 1. Auto-expand selected child in Properties panel

When a child block/item is selected in the iframe preview, automatically expand and scroll to that item in the Properties panel on the right. Keeps iframe selection and property editing in sync.

## 2. Content tree — full page hierarchy with drag-and-drop

Add a "Content tree" panel showing the full nested structure of the page:

```
Content tree
  Page
    > Main
      v Section
        Hero          (selected, highlighted)
          Image
          Heading
          Description
          Button Text
      > Section
```

- Collapsible tree nodes for Page > regions > sections > blocks > fields
- Icons per node type (page, section, component, text field, image, etc.)
- Selecting a node highlights the corresponding element in the iframe preview and opens its properties
- Drag-and-drop to reorder sections/blocks within their parent
- Context menu (kebab icon) for delete, duplicate, move up/down
- Could live as a new tab alongside Chat and Properties, or as a collapsible drawer above the property fields

## 3. CMS-style component detail panel

A dedicated detail panel for the selected block, inspired by headless CMS editors (e.g. Adobe AEM). Shows:

```
Main > Section >
[icon] Hero
  [thumb] homepage-hero-1.png   ✕
  + Add
─────────────────────
Style    [  None          v]
Alt Text [homepage hero alt text  ✓]
Heading  [Welcome to CitiSignal   ✓]
Heading Type  [ h1              v]
Description
  T  Our lowest priced plans ever, st...
Button Title Attribute
         [redirect to plans page  ✓]
Button Text
         [Shop Plans             ✓]
Button Link
         [/content/citisignal-one/us...]
```

- Breadcrumb path at top (Main > Section >) showing hierarchy context
- Block type icon + name as header
- Image asset slots with thumbnail, filename, remove (✕), and "+ Add"
- Inline field editing with green checkmark on valid/saved values
- Dropdowns for enum fields (Style, Heading Type)
- Truncated preview for long richtext fields
- Right-side icon rail for quick actions (settings, layers, assets, delete)

## 4. Rich text editor for richtext fields

Replace the plain `<textarea>` for richtext fields with a proper rich text editor. Evaluate library-based vs DIY approaches:

- **Tiptap** (ProseMirror-based) — popular, extensible, React-friendly, MIT license. Likely best fit.
- **Lexical** (Meta) — lightweight, good React integration, newer ecosystem.
- **Slate** — flexible but API has been unstable historically.
- **DIY with contentEditable** — maximum control but significant effort for formatting toolbar, paste handling, undo/redo, etc.

Storage format: output as Markdown (already used in block content) or sanitized HTML depending on block renderer expectations.
