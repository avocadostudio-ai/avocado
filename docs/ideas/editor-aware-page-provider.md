# Option C: `<EditorAwarePage>` Provider Component

**Status:** Deferred — revisit when we have more site integrations.

## Problem

Every page in a site integration has ~30-40 lines of boilerplate for editor-vs-static rendering:
- `resolveEditorContext()` + conditional draft/static fetching
- `EditorOverlay` + `getPreviewWrapperProps` wiring
- `BlockErrorBoundary` wrapping each block
- Conditional block rendering based on editor context

## Proposal

An `<EditorAwarePage>` component in `site-sdk` that absorbs the editor-vs-static rendering branching. Pages focus on content fetching, not editor plumbing:

```tsx
import { EditorAwarePage } from "@ai-site-editor/site-sdk/editor"

export default async function Page({ params }) {
  const slug = buildSlug(params)
  const draftCtx = await resolveEditorContext()

  return (
    <EditorAwarePage
      slug={slug}
      draftContext={draftCtx}
      getStaticPage={() => getPublishedPage(slug)}
    >
      {(blocks) => blocks.map(b => <BlockRenderer key={b.id} block={b} />)}
    </EditorAwarePage>
  )
}
```

Internally handles:
- Draft vs. static page fetching
- `EditorOverlay` injection when in editor context
- `getPreviewWrapperProps` on each block wrapper
- `BlockErrorBoundary` around each block
- No-ops when `draftCtx` is null (zero production overhead)

## Pros

- Centralizes EditorOverlay + getPreviewWrapperProps + BlockErrorBoundary + conditional rendering
- Pages focus on content fetching, not editor plumbing
- Zero production overhead (no-ops when editorCtx is null)

## Cons / Why Deferred

- **Content fetching is site-specific:** draft vs. static, navigation structure, metadata extraction — hard to abstract without being prescriptive
- **Layout flexibility:** sites with custom chrome/layout need control over where nav/footer sit relative to blocks
- **Over-abstraction risk:** only 2 consumers today (apps/site, examples/sample-site), patterns not yet stable
- **Server component constraints:** `resolveEditorContext()` needs `draftMode()`/`cookies()` — can't be absorbed into a client Provider; the component must be a server component or accept pre-resolved context
- **Render function children pattern** can feel awkward for complex layouts with interleaved site-specific elements

## When to Revisit

- When a 3rd site integration is added — if the page.tsx boilerplate is still ~30 lines of identical code
- When the block rendering pipeline stabilizes (error boundaries, preview wrappers, animations)
- When we add features that require coordinated page-level state (e.g., page transitions, skeleton loading)

## Related

- Option A (catch-all API route) was implemented — see `packages/site-sdk/src/editor-api-handler.ts`
- `packages/site-sdk/src/editor-overlay.tsx` — current EditorOverlay component
- `packages/preview-adapter` — preview bridge and overlay CSS
