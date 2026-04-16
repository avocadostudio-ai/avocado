# Chat Panel Resizer — Deferred Improvements

Follow-ups from a 2026-04-16 layout review of the chat-panel splitter
(`.panel-splitter` in `apps/editor/src/styles.css`). Three items from that
review shipped the same session (min-width raised `240 → 380`, chatWidth
persisted to `localStorage`, max capped at `min(50vw, 720px)`). The two
items below were deferred.

## Already shipped

| Item | Summary |
|------|---------|
| Min width too low | `CHAT_WIDTH_MIN = 380` in `apps/editor/src/lib/defaults.ts` (was 240; content after 56px rail was only 184px) |
| No persistence | `resolveDefaultChatWidth()` seeds store from `localStorage("editor-chat-width-v1")`; central subscriber in `editor-store.ts` writes on change |
| Max unbounded on wide screens | `CHAT_WIDTH_MAX_ABS = 720`; effective max is `min(vw*0.5, 720)` via shared `clampChatWidth()` |

## Deferred

### 1. Splitter discoverability + double-click reset

`.panel-splitter::before` has `opacity: 0` until `:hover` (see
`apps/editor/src/styles.css` around line 80–107), so new users have no
signal that the chat panel is resizable. The 16px hit area with `-8px`
negative margin also means the visible hover bar only appears once the
cursor is already on the edge.

**Fix — visibility**

Option A (hairline at rest): render `.panel-splitter::before` at
`opacity: 0.35` (or a subtle `var(--line)` hairline) by default and bump
to `0.8` on hover. Low visual weight, but enough to signal affordance.

Option B (edge chevron on hover): keep at-rest invisible, but on hover
show a small chevron/grip icon centered on the bar. More discoverable the
first time the cursor enters the area.

Recommend A — simpler and matches how VS Code / Linear render their
side-panel splitters.

**Fix — double-click reset**

Add `onDoubleClick` on the `.panel-splitter` element in `App.tsx` (near
line 1798) that calls `setChatWidth(null)`. The store subscriber will
clear the localStorage key, and the CSS default
`clamp(450px, 20vw, 600px)` takes over.

**LOE:** ~30 min. No state changes, no new deps.

### 2. Accessibility on the resizer

The splitter is a bare `<div>` with a `pointerdown` handler — no role, no
keyboard support, invisible to screen readers.

**Fix**

On `.panel-splitter`:

```tsx
<div
  className="panel-splitter"
  role="separator"
  aria-orientation="vertical"
  aria-label="Resize chat panel"
  aria-valuenow={chatWidth ?? /* current computed */}
  aria-valuemin={CHAT_WIDTH_MIN}
  aria-valuemax={/* current max from clampChatWidth */}
  tabIndex={0}
  onKeyDown={(e) => {
    const step = e.shiftKey ? 40 : 8
    if (e.key === "ArrowLeft")  setChatWidth((w) => clampChatWidth((w ?? default) + step))
    if (e.key === "ArrowRight") setChatWidth((w) => clampChatWidth((w ?? default) - step))
    if (e.key === "Home")       setChatWidth(CHAT_WIDTH_MIN)
    if (e.key === "End")        setChatWidth(/* current max */)
  }}
  onPointerDown={/* existing */}
  onDoubleClick={() => setChatWidth(null)}
/>
```

Add a `:focus-visible` ring on `.panel-splitter::before` matching the
hover state so keyboard users can see where they are.

Note: arrow-key direction is inverted — panel grows leftward, so
`ArrowLeft` increases width. Document this in a comment.

**LOE:** ~45 min. Verify with VoiceOver (separator role announces
current/min/max).

## Open questions

- Should the CSS default `clamp(450px, 20vw, 600px)` be tightened to
  match the shared JS bounds (`clamp(380px, 25vw, 720px)`)? Currently
  the two diverge — pre-persistence state takes CSS, post-drag state
  takes JS. Not a bug, but a papercut if someone tunes one without the
  other.
- On very wide displays (>2560px) the 720px cap might feel cramped to
  users who like a big chat. Consider a user preference toggle if we
  get reports.
