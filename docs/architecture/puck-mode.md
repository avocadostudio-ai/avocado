# Puck Mode — Visual Drag-and-Drop Editor

Puck mode is an alternative editing experience that replaces the chat-driven editor with a visual drag-and-drop canvas powered by [@measured/puck](https://github.com/measuredco/puck). AI chat is available as a sidebar plugin.

## Enabling Per Site

Puck mode is controlled per-site via the `enablePuck` boolean on `SiteConfig` (stored in localStorage).

1. Open `/sites`
2. Click the gear icon on a site tile
3. In the **General** tab, check **"Use visual editor (Puck)"**
4. Click **"Open Editor"** — navigates to `/editor/puck?siteId=<id>`

Sites without the flag open the default chat editor at `/editor`.

### Implementation

- **Type**: `enablePuck?: boolean` on `SiteConfig` (`apps/editor/src/lib/editor-types.ts`)
- **Routing**: `openEditorForSite()` in `useSiteList.ts` checks `enablePuck` and routes to `/editor/puck` or `/editor`
- **UI**: Checkbox in site config modal General tab (`SitesPage.tsx`)
- **i18n**: `sites.enablePuck` key in `en.ts` / `de.ts`

## Package Structure

```
packages/editor-puck/
  src/
    components/
      PuckChatPrototype.tsx       # Main component (~400 lines)
      puck/
        createPuckConfig.tsx      # Block manifest -> Puck component config
        adapters.ts               # Field type mapping, op diffing (buildOpsFromPuckDiff)
        draft-api.ts              # Orchestrator API layer (bootstrap, pages, ops)
        PuckChatPluginPanel.tsx   # AI chat as a Puck plugin panel
        usePuckSiteSync.ts        # Sync draft state with orchestrator
        selection.ts              # Derive selection context from Puck store
    host/
      types.ts                    # PuckHostApi interface
      runtime.ts                  # Runtime container for host API
```

Entry point: `apps/editor/src/components/PuckPrototypeRoute.tsx` bridges the main editor's hooks into `PuckChatPrototype`.

## How It Works

### Block Registration

`createPuckConfig()` converts the block manifest (fetched from the site at `/api/editor/blocks`) into Puck-compatible component definitions. Field type mapping in `adapters.ts`:

| Block Field Type | Puck Field Type |
|------------------|-----------------|
| `number` | `"number"` |
| `enum` | `"select"` |
| `headingLevel` | `"select"` (h1-h6) |
| `richtext` | `"textarea"` |
| `image` | Custom render with image picker modal |
| default | `"text"` |

Blocks render using `SharedBlockRenderer` from `@ai-site-editor/blocks`.

### Persistence (Auto-Save)

```
User edits block in Puck canvas
  -> onPuckChange() fires
  -> ensurePuckBlockIds() adds _blockId if missing
  -> queuePersist() sets 600ms debounce timer
  -> flushPendingPersist()
     -> buildOpsFromPuckDiff() diffs previous vs current state
     -> Generates ops: add_block, remove_block, update_props, move_block
     -> POST /ops to orchestrator
```

### AI Chat Integration

- Chat runs as a Puck **plugin panel** (right sidebar)
- Uses the same `useChatEngine` hook as the main editor
- Selection context: `deriveSelectionContextFromPuck()` passes active block info to the AI
- Same `/chat` and `/agent/*` endpoints as the main editor

### Agent Mode

Agent mode is enabled server-side via `AGENT_API_KEY` in orchestrator `.env`. The editor detects availability from `/status/planner`:

```
GET /status/planner -> { ..., agentMode: true }
```

The API key never reaches the browser. The editor passes `agentModeEnabled: boolean` to `useChatEngine`, which routes to `/agent/start` + `/agent/stream` SSE when enabled.

## Comparison with Main Editor

| Aspect | Main Editor | Puck Mode |
|--------|-------------|-----------|
| Editing paradigm | Chat-driven | Visual drag-and-drop |
| Preview | Iframe + postMessage bridge | In-canvas rendering |
| Chat location | Left sidebar | Puck plugin, right sidebar |
| Block editing | Custom form panel | Puck's native field sidebar |
| Drag-and-drop | Custom drag handler | Puck's native DnD |
| Publishing | Full publish flow | Full publish flow (via usePublish hook) |
| Route | `/editor` | `/editor/puck` (per-site flag) |

## Key API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /draft/bootstrap` | Initialize draft for session |
| `GET /draft/slugs` | List available pages |
| `GET /draft/pages` | Fetch page by slug |
| `POST /ops` | Apply operations |
| `POST /publish` | Publish draft to production |
| `GET /publish/status` | Poll deployment progress |
| `GET /status/planner` | Check capabilities (incl. agentMode) |
| `GET /api/editor/blocks` (site) | Block manifest |

## Known Gaps

1. **No live site preview** — renders in Puck canvas, not in the Next.js site iframe
2. **No nested zones** — flat `content` array only, zone types hinted but unused
3. **Image handling** — basic URL picker, no upload progress or validation
4. **Drag state leak** — defensive code clears `panel-resizing` class on mount (workaround)
