# Framework Support: Joomla 4/5

## Framework Characteristics
- PHP-based CMS — no Node.js runtime, no React/Vue server-side
- Content stored in MySQL database (`#__content`, `#__modules`, `#__menu`, `#__fields`)
- Component architecture: `com_content` (articles), `com_contact`, `com_banners`, plus third-party extensions
- Template system: PHP template overrides, module positions, layout overrides
- Built-in Web Services API (Joomla 4+) — JSON:API endpoints per component
- Plugin events for extensibility (`onAfterRender`, `onContentPrepare`, etc.)
- Menu items define URL routing and page structure
- Custom fields system (`com_fields`) for arbitrary metadata on articles, contacts, etc.

## Why Joomla Is Different

Unlike Astro, React Router, and Nuxt — all JavaScript frameworks where our React blocks can render natively — Joomla is a PHP CMS with its own content model. The integration pattern is fundamentally different:

- **We don't render our blocks on the Joomla site.** Joomla renders its own content via PHP templates.
- **We map Joomla's existing content to our `PageDoc/BlockInstance` model** so the orchestrator and LLM planner can understand and edit it.
- **We inject a vanilla JS preview bridge** into the Joomla page for live editing communication.
- **We write changes back to the Joomla database** via its REST API or the plugin's write-back engine.

## SDK Abstraction Mapping

### 1. Editor API Routes
**Next.js:** `app/api/editor/[...path]/route.ts` using `createEditorApiHandler()`
**Joomla:** PHP plugin exposes equivalent REST endpoints

The Joomla plugin implements the same endpoint contract as `EditorApiHandlerConfig`, but in PHP:

```
GET  /api/editor/pages    → PageDoc[] (scanned from Joomla content)
GET  /api/editor/blocks   → BlockManifest (dynamically built from content types)
POST /api/editor/publish  → write edited PageDocs back to Joomla DB
GET  /api/editor/draft    → set preview cookie, redirect with ?__editor=1
```

The orchestrator and editor already fetch from `{siteOrigin}/api/editor/*` — no changes needed on that side.

### 2. Content Mapping: Tiered Scanner

The plugin's content scanner maps Joomla content to `PageDoc/BlockInstance` in three tiers:

#### Tier 1: Known components (zero config)

| Joomla Content | Block Type | Props | Source |
|---|---|---|---|
| Article title + intro image | `JoomlaArticleHeader` | `title`, `introImage`, `introImageAlt`, `category` | `#__content.title`, `images` JSON |
| Article introtext | `JoomlaRichText` | `body` (HTML) | `#__content.introtext` |
| Article fulltext | `JoomlaRichText` | `body` (HTML) | `#__content.fulltext` |
| Article SEO | `JoomlaArticleMeta` | `metadesc`, `metakey` | `#__content` metadata |
| Module (mod_custom) | `JoomlaHtmlModule` | `content` (HTML), `title` | `#__modules.content` |
| Module (mod_menu) | `JoomlaNavModule` | `menuType`, `title` | `#__modules.params` |
| Custom fields | Extra props on article blocks | field-specific | `#__fields_values` |

Menu items (`#__menu`) define pages. The scanner walks the menu tree to build `PageDoc[]` with slugs matching Joomla's URL routing.

#### Tier 2: Extension discovery (automatic)

For installed components with Joomla 4+ Web Services API:
- Query `#__extensions` to discover components
- Probe each component's JSON:API schema
- Auto-generate `BlockDefinition` with `propsSchema` from discovered fields
- E.g., `JoomlaK2Item`, `JoomlaVirtuemartProduct`

#### Tier 3: Fallback (any content)

Unmatched rendered HTML → `JoomlaHtmlRegion` block with `{ html: string }` prop. Ensures every visible piece of content is at least editable as raw HTML.

### 3. Draft Mode
**Next.js:** `draftMode()` from `next/headers`
**Joomla:** Cookie-based, set by the plugin's `/api/editor/draft` endpoint

```php
// On draft enable: set cookie + redirect with ?__editor=1
$app->input->cookie->set('ase-draft-session', $session, 0, '/', '', true, true);
$app->redirect($redirectUrl . '?__editor=1');
```

The plugin checks for this cookie on every request. When present, it activates the DOM annotator and injects the preview bridge script.

### 4. Preview Bridge
**Next.js/Astro/React Router:** React component using `useRouter()`, `usePathname()`
**Joomla:** Vanilla JS IIFE — no React, no build tools on the Joomla side

The existing `PreviewBridgeCore` (`packages/preview-adapter/src/preview-bridge-core.tsx`) is React-based. For Joomla, we need a **vanilla JS extraction** that:

- Implements the `site-editor/v1` postMessage protocol
- Listens for: `draftUpdated`, `highlightBlock`, `navigate`, `applyPatch`
- Sends: `blockClicked`, `routeChanged`, `ready`
- Patches the DOM directly: finds `[data-block-id]` elements and updates `innerHTML`/`textContent`/`src`
- Click handler on `[data-block-id]` elements sends selection to editor
- Built with esbuild to a single `aisiteeditor-bridge.js` (~5KB)

This lives in a new `packages/preview-bridge-vanilla/` package.

### 5. DOM Annotation
**Next.js:** Block renderers add `data-block-id`, `data-block-type`, `data-editable-target` in React
**Joomla:** PHP plugin's `DomAnnotator` wraps content via `onAfterRender` event

```php
// DomAnnotator.php — inject data attributes into rendered HTML
public function onAfterRender() {
    $body = $this->app->getBody();
    // Wrap article content sections in annotated divs
    // e.g., <div data-block-id="b_intro_42" data-block-type="JoomlaRichText">
    //          <div data-editable-target="body">...article introtext...</div>
    //        </div>
    $this->app->setBody($annotatedBody);
}
```

This is template-agnostic — it wraps at the content output level, not the template level.

### 6. Block Rendering
**Next.js:** React components from `@ai-site-editor/blocks`
**Joomla:** N/A — Joomla renders its own content via PHP templates

We do NOT render our block components on the Joomla site. Joomla's templates handle rendering. Our blocks are purely a **data model abstraction** for the orchestrator and LLM planner to work with. The preview bridge patches the existing DOM on edits rather than re-rendering from React.

### 7. Publish / Write-back
**Next.js:** Static JSON file committed to repo, deployed via Vercel
**Joomla:** POST edited `PageDoc[]` back to the plugin's REST API, which writes to MySQL

```php
// PublishController.php
public function publish() {
    $pages = json_decode($this->input->json->getRaw(), true);
    foreach ($pages as $pageDoc) {
        foreach ($pageDoc['blocks'] as $block) {
            match($block['type']) {
                'JoomlaArticleHeader' => $this->articleWriter->updateHeader($block),
                'JoomlaRichText'      => $this->articleWriter->updateBody($block),
                'JoomlaArticleMeta'   => $this->articleWriter->updateMeta($block),
                'JoomlaHtmlModule'    => $this->moduleWriter->updateModule($block),
                default               => null, // read-only block types
            };
        }
    }
    return new JsonResponse(['ok' => true]);
}
```

Write-back preserves original formatting by applying targeted diffs rather than full content replacement.

## What Needs to Be Built

### New: Joomla PHP Plugin (separate repo)
1. **Content scanners** — `ArticleScanner`, `MenuScanner`, `ModuleScanner`, `CustomFieldScanner`, `ExtensionDiscovery`, `FallbackScanner`
2. **REST API** — `/pages`, `/blocks`, `/publish`, `/draft` endpoints matching `EditorApiHandlerConfig` contract
3. **DOM annotator** — `data-block-id`/`data-block-type`/`data-editable-target` injection via `onAfterRender`
4. **Write-back engine** — `ArticleWriter`, `ModuleWriter`, `CustomFieldWriter`
5. **Bridge injector** — inject vanilla JS preview bridge script

### New: Vanilla JS Preview Bridge (`packages/preview-bridge-vanilla/`)
1. Framework-agnostic `site-editor/v1` postMessage implementation
2. DOM patching for live draft updates
3. Block selection and click handling
4. esbuild to single IIFE bundle

### New: Orchestrator Adapter (~3 files)
1. `apps/orchestrator/src/joomla/joomla-publish-target.ts` — `PublishTarget` implementation
2. `apps/orchestrator/src/joomla/joomla-bootstrap.ts` — fetch pages from Joomla, bootstrap session

### Small Modifications
1. `apps/orchestrator/src/integration/integration-context.ts` — `siteType: "joomla"` flag, disable structural ops
2. `apps/orchestrator/src/chat/prompts.ts` — Joomla-specific planner context

### No Changes Needed
- `ContentSource` / `InMemoryContentSource` — draft state works as-is
- `BlockManifest` / `BlockDefinition` — already supports dynamic types with arbitrary `propsSchema`
- `pageDocSchemaLenient` — already accepts unknown block types
- `POST /draft/bootstrap` — already accepts external `PageDoc[]`
- Ops engine — `update_props` / `update_page_meta` work on any block type
- Editor app — iframe URL and postMessage protocol are already configurable

## Operation Restrictions

For Joomla sessions, only content-editing operations are supported:
- ✅ `update_props` — edit article text, images, module content
- ✅ `update_page_meta` — edit SEO fields
- ❌ `add_block` / `remove_block` / `move_block` — page structure is defined by Joomla
- ❌ `create_page` / `delete_page` — requires Joomla menu/category management

The planner system prompt enforces this via the existing `allowStructuralEdits: false` flag in integration context.

## Effort Estimate
- **Joomla PHP plugin:** ~2-3 weeks (ArticleScanner is the core; extension discovery is Phase 3)
- **Vanilla JS bridge:** ~2-3 days (extract from `preview-bridge-core.tsx`)
- **Orchestrator adapter:** ~1-2 days (clean interfaces already exist)
- **Total MVP (articles only):** ~3 weeks
- **Full scope (modules + extensions + fallback):** ~5-6 weeks

## Priority
**P2** — Largest integration effort of any framework. Unlike JS frameworks where our React blocks render natively, Joomla requires a PHP plugin, content model mapping, vanilla JS bridge, and write-back engine. However, the existing SDK abstractions (`EditorApiHandlerConfig`, `BlockManifest`, `PublishTarget`, `pageDocSchemaLenient`) are well-designed for this — no architectural changes needed, just a new adapter layer.

## Risks

| Risk | Mitigation |
|---|---|
| Template DOM structure varies across Joomla templates | `DomAnnotator` wraps at content output level via `onAfterRender`, not template level |
| HTML round-trip is lossy | Store original content; apply targeted diffs on write-back |
| Not all extensions expose Web Services APIs | Tier 3 `JoomlaHtmlRegion` fallback ensures everything editable as HTML |
| Joomla 3 has no built-in REST API | Target Joomla 4+ only (Joomla 3 EOL August 2023) |
| Cross-origin iframe security | postMessage works cross-origin by design; CORS headers on REST endpoints |

## Comparison to Other Frameworks

| Dimension | React Router | Astro | Nuxt | **Joomla** |
|---|---|---|---|---|
| Language | JS/TS | JS/TS | JS/TS | **PHP** |
| Block rendering | React (direct) | React islands | Vue (rewrite) | **N/A (Joomla templates)** |
| Preview bridge | React (minor adapt) | React island | Vue port | **Vanilla JS (new)** |
| API routes | Web API (direct) | Web API (direct) | H3 (adapt) | **PHP REST (new)** |
| Content model | PageDoc (native) | PageDoc (native) | PageDoc (native) | **Mapped from Joomla DB** |
| Write-back | JSON file | JSON file | JSON file | **Joomla REST API / DB** |
| Estimated effort | 2-3 days | 3-4 days | ~1 week | **3-6 weeks** |
